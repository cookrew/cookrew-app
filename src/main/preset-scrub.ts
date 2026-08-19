import type { CanvasNode } from '../shared/model'
import type { TeamSnapshot } from './teams'
import { stripSessionFlags } from '../shared/claude-fork'
import { isPiCommand, stripPiSessionFlags } from './pi-bind'

/**
 * EXPORT SCRUBBER (marketplace §5). The team snapshot was designed for LOCAL
 * restore, so publishing needs a deliberate layer on top of it. This is a
 * safety gate, not a formatter: a preset carries prompts that will drive agents
 * with shell access, so what leaves the machine is decided here and nowhere
 * else (A4).
 *
 * It reuses the paste engine's discipline — the same harness bindings
 * planTerminal already clears, the same flag strippers — and adds the
 * export-only rules: session context out by default, absolute paths replaced
 * by placeholders the installer maps to the buyer's workdirs, and a secret scan
 * that BLOCKS rather than warns.
 *
 * Pure: the input snapshot is never mutated, nothing is read from disk, and the
 * report it returns is the `scrub` object embedded in the manifest and rendered
 * by the install review sheet.
 */

/** Placeholder token base; `{{dir0}}` is always the team's primary workdir. */
export const PLACEHOLDER_PREFIX = '{{dir'

const placeholder = (index: number): string => `${PLACEHOLDER_PREFIX}${index}}}`

export interface ScrubOptions {
  /**
   * Publisher opt-in to ship the conversation itself (turns + the sessions
   * sidecar). Off by default because full transcripts are the likeliest place
   * for a secret to hide; the caller is expected to have shown a loud warning
   * and a preview before setting this.
   */
  includeSessions?: boolean
}

/** Where a secret was found. Deliberately carries no sample of the match. */
export interface SecretFinding {
  /** Node id + field, e.g. `nodes[z9].command` — enough to go fix it. */
  where: string
  /** Pattern name, e.g. `aws-access-key`. Never the matched text. */
  kind: string
}

export interface ScrubReport {
  /** Whether conversation context travels with the preset. */
  sessions: boolean
  paths: 'placeholders'
  /** Shell cards whose literal command the buyer must read before first run. */
  shells: number
  notes: number
  urls: number
  secretScan: 'clean' | 'blocked'
  findings: SecretFinding[]
}

export type ScrubResult =
  | { ok: true; snapshot: TeamSnapshot; report: ScrubReport }
  | { ok: false; report: ScrubReport }

/**
 * Secret patterns. Each must match a CREDENTIAL SHAPE, never a mention: prose
 * like "put your API key in .env" has to pass, or publishing becomes a guessing
 * game and authors route around the gate. Every pattern is therefore anchored
 * on a vendor prefix or an armored header with a length floor.
 */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'provider-key', re: /\bsk-[A-Za-z0-9_-]{24,}/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ }
]

function scanSecrets(where: string, text: string | undefined, into: SecretFinding[]): void {
  if (!text) return
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(text)) into.push({ where, kind })
  }
}

/**
 * Longest-first so a nested workdir is rewritten before its parent could
 * swallow the prefix and leave the remainder dangling.
 */
function replaceAll(text: string, table: [string, string][]): string {
  let out = text
  for (const [from, to] of table) out = out.split(from).join(to)
  return out
}

/** Collect every absolute directory the snapshot names, primary first. */
function pathTable(snapshot: TeamSnapshot): Map<string, string> {
  const table = new Map<string, string>()
  const add = (dir: string | undefined): void => {
    if (!dir || table.has(dir)) return
    table.set(dir, placeholder(table.size))
  }
  add(snapshot.dir)
  for (const dir of snapshot.dirs ?? []) add(dir)
  for (const node of snapshot.nodes) {
    if (node.kind === 'terminal') add(node.cwd)
  }
  return table
}

export function scrubForPublish(snapshot: TeamSnapshot, options: ScrubOptions = {}): ScrubResult {
  const includeSessions = options.includeSessions === true
  const table = pathTable(snapshot)
  // Longest path first: /a/b/c must be rewritten before /a/b.
  const ordered: [string, string][] = [...table.entries()].sort((a, b) => b[0].length - a[0].length)
  const mask = (text: string): string => replaceAll(text, ordered)

  const findings: SecretFinding[] = []
  let shells = 0
  let notes = 0
  let urls = 0

  const nodes: CanvasNode[] = snapshot.nodes.map((node) => {
    if (node.kind === 'note') {
      notes += 1
      scanSecrets(`nodes[${node.id}].content`, node.content, findings)
      return { ...node, content: mask(node.content) }
    }
    if (node.kind === 'browser') {
      urls += 1
      scanSecrets(`nodes[${node.id}].url`, node.url, findings)
      const tabs = node.tabs?.map((tab) => {
        scanSecrets(`nodes[${node.id}].tabs.url`, tab.url, findings)
        return { ...tab, url: mask(tab.url) }
      })
      return { ...node, url: mask(node.url), ...(tabs ? { tabs } : {}) }
    }
    // Terminal. Its command is the product — kept verbatim apart from path
    // masking and the resume flags, which would point a buyer's copy at the
    // AUTHOR's live session file.
    if (node.preset === 'Shell') shells += 1
    scanSecrets(`nodes[${node.id}].command`, node.command, findings)
    const stripped = isPiCommand(node.command)
      ? stripPiSessionFlags(node.command)
      : stripSessionFlags(node.command)
    return {
      ...node,
      command: mask(stripped),
      cwd: table.get(node.cwd) ?? node.cwd,
      // No session binding leaves the machine: an inherited id would make the
      // buyer's copy resume a session file that is not theirs and does not
      // exist. Same field list planTerminal clears on a fork.
      claudeSessionId: null,
      piSessionId: null,
      codexSessionRef: null,
      opencodeSessionId: null,
      sessionLineage: undefined,
      restoreStack: undefined,
      pendingInject: null,
      // forkOf names a source terminal id that has no meaning for a buyer.
      forkOf: null
    }
  })

  const report: ScrubReport = {
    sessions: includeSessions,
    paths: 'placeholders',
    shells,
    notes,
    urls,
    secretScan: findings.length > 0 ? 'blocked' : 'clean',
    findings
  }

  // Blocked, not warned: no key leaves, ever (A4 / §5). The scrubbed snapshot
  // is deliberately NOT returned — there is nothing safe to publish yet.
  if (findings.length > 0) return { ok: false, report }

  const scrubbed: TeamSnapshot = {
    ...snapshot,
    dir: table.get(snapshot.dir) ?? snapshot.dir,
    ...(snapshot.dirs ? { dirs: snapshot.dirs.map((d) => table.get(d) ?? d) } : {}),
    nodes,
    turns: includeSessions ? snapshot.turns : {},
    ...(includeSessions && snapshot.sessions ? { sessions: snapshot.sessions } : {})
  }
  if (!includeSessions) delete (scrubbed as { sessions?: unknown }).sessions

  return { ok: true, snapshot: scrubbed, report }
}
