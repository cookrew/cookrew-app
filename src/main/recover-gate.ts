// EXACT-CONTEXT recovery gate (agent-recover feature).
//
// Decides whether a recovered node can resume the EXACT session it had at
// creation — same ref AND same first turn — versus recovering position-only.
// The rule, per harness: position-only fires IFF the exact prior session is
// genuinely unavailable, and recovery NEVER boots a fresh (claude) or
// stray/deleted (codex/opencode) session in its place.
//
// Extracted from index.ts and dependency-injected so this decision — the
// `didSpawn` seam that failed QA twice — is unit-tested per harness without
// touching real session files.

import { existsSync } from 'node:fs'
import type { TerminalNodeData } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import type { HarnessId, SessionField } from './harness'
import { HARNESS_BY_ID, harnessFor } from './harness'
import { claudeSessionFile, resolveExistingClaudeSession, type ResolveSessionOptions } from './claude-fork'
import { supportFor, unsupported, type PerHarness } from '../shared/harness-support'
import { opencodeSessionFileExists } from './opencode-bind'
import { agyConversationExists } from './agy-bind'
import { devinSessionExists } from './devin-bind'
import { dshSessionExists } from './hosted-bind'
import { piSessionHome } from './pi-bind'

/** Injectable side-effects so the gate is testable without real files. */
export interface ExactGateDeps {
  /** The node's persisted turn history (claude id recovery signal). */
  turnsHistory: (id: string) => TurnRecord[]
  /** Codex rollout-file existence check (defaults to fs.existsSync). */
  fileExists?: (path: string) => boolean
  /** OpenCode session-file existence check (defaults to the real scan). */
  opencodeExists?: (sessionId: string) => boolean
  /** Pi node-directory + cwd-scoped session existence check. */
  piExists?: (nodeId: string, cwd: string, sessionId: string) => boolean
  /**
   * The session an UNBOUND Pi node would adopt at launch, or null.
   *
   * The gate and the launcher must return the same answer here. Without it
   * the gate saw `piSessionId: null`, called the session unlocatable, and
   * refused to boot — while the conversation sat unowned in the node's own
   * cwd scope the whole time. Defaults to "nothing to adopt" so a caller that
   * does not know about ownership keeps the old, conservative behaviour.
   */
  piAdoptable?: (nodeId: string, cwd: string) => string | null
  /** Antigravity conversation-store existence check (defaults to the real data dir). */
  agyExists?: (conversationId: string) => boolean
  /** Devin session-files existence check (defaults to the real data dir). */
  devinExists?: (sessionId: string) => boolean
  /** DeepSeek Harness's own session copy existence check (defaults to ~/.dsh). */
  dshExists?: (sessionId: string) => boolean
  /** Claude session resolver (defaults to the real, file-backed resolver). */
  claudeResolver?: (options: ResolveSessionOptions) => string | null
}

/**
 * Can this node's EXACT prior session be restored right now?
 *  - claude: an existing session id / turn-history match — NEVER a fresh mint.
 *  - codex: a bound rollout whose file still exists.
 *  - opencode: a shape-valid ses_ id whose session file still exists (S1).
 *  - pi: a shape-valid id whose cwd-scoped JSONL file still exists.
 *  - plain shells / unknown harness: always true (nothing to restore).
 */
export function canRestoreExact(node: TerminalNodeData, deps: ExactGateDeps): boolean {
  const harness = harnessFor(node.command)
  if (!harness) return true
  return EXACT_RESTORE[harness.id](node, deps)
}

type ExactCheck = (node: TerminalNodeData, deps: ExactGateDeps) => boolean

/**
 * One exact-context check per harness, keyed by every HarnessId — no harness
 * can fall through into another's branch (2026-11-25: every id that was not
 * claude, codex or pi was judged by OPENCODE's rule, so a new harness could
 * never be recovered at all). A harness that cannot prove its prior session
 * exists must still declare a check: one that answers false refuses
 * honestly; there is no default that boots a fresh session in its place.
 */
export const EXACT_RESTORE: Readonly<Record<HarnessId, ExactCheck>> = {
  claude: (node, deps) => {
    const claudeResolver = deps.claudeResolver ?? resolveExistingClaudeSession
    return (
      claudeResolver({
        command: node.command,
        cwd: node.cwd,
        storedId: node.claudeSessionId,
        turns: deps.turnsHistory(node.id)
      }) !== null
    )
  },
  codex: (node, deps) => {
    const fileExists = deps.fileExists ?? existsSync
    return typeof node.codexSessionRef === 'string' && fileExists(node.codexSessionRef)
  },
  pi: (node, deps) => {
    // An unbound node is restorable when there IS something for it to adopt —
    // asked before the id lookup, because there is no id to look up.
    const adopted = node.piSessionId ? null : deps.piAdoptable?.(node.id, node.cwd) ?? null
    const key = HARNESS_BY_ID.pi.resumeKey(node.piSessionId ?? adopted ?? '')
    // Exclusive dir OR the legacy pane's own cwd dir (piSessionHome): a
    // session adopted from a reattached pane is just as exactly-restorable,
    // and gating it on the exclusive dir alone made those nodes permanently
    // non-recoverable the moment binding learned to adopt them.
    const piExists = deps.piExists ?? ((nodeId, cwd, id) =>
      piSessionHome(cwd, id, nodeId) !== null)
    return key !== null && piExists(node.id, node.cwd, key)
  },
  // opencode: format-valid ses_ id AND its session file still on disk. A
  // deleted session must NOT pass the gate (else recover fresh-boots — the
  // exact stray outcome this gate exists to prevent).
  opencode: (node, deps) => {
    const opencodeExists = deps.opencodeExists ?? opencodeSessionFileExists
    const key = HARNESS_BY_ID.opencode.resumeKey(node.opencodeSessionId ?? '')
    return key !== null && opencodeExists(key)
  },
  // agy: a UUID-shaped conversation id whose store is still on disk.
  agy: (node, deps) => {
    const agyExists = deps.agyExists ?? ((id: string) => agyConversationExists(id))
    const key = HARNESS_BY_ID.agy.resumeKey(node.agySessionId ?? '')
    return key !== null && agyExists(key)
  },
  // devin: a slug-shaped session id whose session files are still on disk.
  devin: (node, deps) => {
    const devinExists = deps.devinExists ?? ((id: string) => devinSessionExists(id))
    const key = HARNESS_BY_ID.devin.resumeKey(node.devinSessionId ?? '')
    return key !== null && devinExists(key)
  },
  // dsh: an id in the host's alphabet whose session dsh itself still holds
  // (session/resume reads dsh's copy, not Cookrew's transcript).
  dsh: (node, deps) => {
    const dshExists = deps.dshExists ?? ((id: string) => dshSessionExists(id))
    const key = HARNESS_BY_ID.dsh.resumeKey(node.dshSessionId ?? '')
    return key !== null && dshExists(key)
  }
}

/**
 * The session file a node names is on disk, whatever the lazy turn tracker
 * has verified so far: the harness resumes it itself, so a respawn (a route
 * change) loses nothing. Claude and Codex name a file outright; the others
 * are answered by the exact-context gate above and declare so.
 */
export const SESSION_ON_DISK: PerHarness<(node: TerminalNodeData, exists: (file: string) => boolean) => boolean> = {
  claude: (node, exists) =>
    Boolean(node.claudeSessionId) && exists(claudeSessionFile(node.cwd, node.claudeSessionId as string)),
  codex: (node, exists) => typeof node.codexSessionRef === 'string' && exists(node.codexSessionRef),
  opencode: unsupported('the exact-context gate already proves the session file'),
  pi: unsupported('the exact-context gate already proves the session file'),
  agy: unsupported('the exact-context gate already proves the conversation'),
  devin: unsupported('the exact-context gate already proves the session'),
  dsh: unsupported('the exact-context gate already proves the session')
}

export function sessionOnDisk(node: TerminalNodeData, exists: (file: string) => boolean = existsSync): boolean {
  const check = supportFor(SESSION_ON_DISK, harnessFor(node.command)?.id)
  return check ? check(node, exists) : false
}

/**
 * Does another node already own this session ref? (1:1 claim guard — a rollout
 * / session held by a live peer is never reassignable, so a re-bind can't
 * cross-wire two agents onto one session.)
 */
export function isRefOwned(
  nodes: readonly TerminalNodeData[],
  selfId: string,
  field: SessionField,
  ref: string
): boolean {
  return nodes.some((node) => node.id !== selfId && node[field] === ref)
}
