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
import type { SessionField } from './harness'
import { harnessFor } from './harness'
import { resolveExistingClaudeSession, type ResolveSessionOptions } from './claude-fork'
import { opencodeSessionFileExists } from './opencode-bind'

/** Injectable side-effects so the gate is testable without real files. */
export interface ExactGateDeps {
  /** The node's persisted turn history (claude id recovery signal). */
  turnsHistory: (id: string) => TurnRecord[]
  /** Codex rollout-file existence check (defaults to fs.existsSync). */
  fileExists?: (path: string) => boolean
  /** OpenCode session-file existence check (defaults to the real scan). */
  opencodeExists?: (sessionId: string) => boolean
  /** Claude session resolver (defaults to the real, file-backed resolver). */
  claudeResolver?: (options: ResolveSessionOptions) => string | null
}

/**
 * Can this node's EXACT prior session be restored right now?
 *  - claude: an existing session id / turn-history match — NEVER a fresh mint.
 *  - codex: a bound rollout whose file still exists.
 *  - opencode: a shape-valid ses_ id whose session file still exists (S1).
 *  - plain shells / unknown harness: always true (nothing to restore).
 */
export function canRestoreExact(node: TerminalNodeData, deps: ExactGateDeps): boolean {
  const harness = harnessFor(node.command)
  if (!harness) return true
  const fileExists = deps.fileExists ?? existsSync
  const opencodeExists = deps.opencodeExists ?? opencodeSessionFileExists
  const claudeResolver = deps.claudeResolver ?? resolveExistingClaudeSession
  if (harness.id === 'claude') {
    return (
      claudeResolver({
        command: node.command,
        cwd: node.cwd,
        storedId: node.claudeSessionId,
        turns: deps.turnsHistory(node.id)
      }) !== null
    )
  }
  if (harness.id === 'codex') {
    return typeof node.codexSessionRef === 'string' && fileExists(node.codexSessionRef)
  }
  // opencode: format-valid ses_ id AND its session file still on disk. A
  // deleted session must NOT pass the gate (else recover fresh-boots — the
  // exact stray outcome this gate exists to prevent).
  const key = harness.resumeKey(node.opencodeSessionId ?? '')
  return key !== null && opencodeExists(key)
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
