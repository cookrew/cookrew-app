// Harness registry (agent-recover feature): the per-harness knowledge needed
// to RESUME an agent's existing session on (re)spawn — the same session, as
// it was, no summary/reset. One spec per harness; adding a new agent harness
// is one entry here, so recover/resume extends automatically (note
// agent-recover-feature-design).

import { stripSessionFlags } from '../shared/claude-fork'
import type { TerminalNodeData } from '../shared/model'
import { parseSessionTurns } from '../shared/session-turns'
import { parseCodexTurns, parsePiTurns } from '../shared/trace-blocks'
import type { TurnRecord } from '../shared/turn'
import { claudeWatchFile } from './claude-fork'
import { codexWatchFile, sessionIdFromRolloutPath } from './codex-bind'
import { isPiCommand, piNodeSessionDir, piResumeCommand, piWatchFile, validPiSessionId } from './pi-bind'

/** Session-root overrides a watchFile resolver honors (tests). */
export interface HarnessWatchOptions {
  projectsDir?: string
  codexSessionsDir?: string
  piSessionsRoot?: string
}

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'pi'

/** TerminalNodeData fields that hold a harness's session reference. */
export type SessionField =
  | 'claudeSessionId'
  | 'codexSessionRef'
  | 'opencodeSessionId'
  | 'piSessionId'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Harness {
  id: HarnessId
  /** True when a launch command runs this harness. */
  matches(command: string): boolean
  /** The node field holding this harness's session reference. */
  sessionField: SessionField
  /** Resume KEY (session id) from the stored field value, or null if unusable. */
  resumeKey(sessionRef: string): string | null
  /** Launch command that RESUMES the given session key, full session as-is.
   *  `context` is REQUIRED (M6): harnesses that scope sessions by terminal
   *  (pi — exclusive --session-dir) cannot build an honest resume without it,
   *  so an optional param was a latent runtime throw on the first generic pi
   *  call site. Harnesses that don't need it simply ignore it. */
  resumeCommand(command: string, key: string, context: { terminalId: string }): string
  /**
   * Turn-history capability (harness-integration-contract):
   * 'file'   — durable TurnRecords are derived from the harness's session
   *            FILE (SessionTurnSync reconcile); `parseTurns` must be wired
   *            and its indices must equal the trace-block indices.
   * 'scrape' — PTY-scrape only; a conscious, declared limitation. New
   *            harnesses are expected to reach 'file' before their preset
   *            ships (tests/harness-conformance.test.ts pins this).
   */
  turns: 'file' | 'scrape'
  /** Session-file lines → TurnRecords; present exactly when turns === 'file'. */
  parseTurns?: (lines: string[]) => TurnRecord[]
  /**
   * The session file SessionTurnSync should poll for this node, or null when
   * unbound/unusable. Owned by the harness so adding one is registry-only
   * (contract rule 4) — each resolver carries its own security validation
   * (UUID shape, sessions-tree prefix, exclusive-dir scan). Present exactly
   * when turns === 'file'.
   */
  watchFile?: (node: TerminalNodeData, options: HarnessWatchOptions) => string | null
}

const CLAUDE: Harness = {
  id: 'claude',
  matches: (c) => /^\s*claude\b/.test(c),
  sessionField: 'claudeSessionId',
  resumeKey: (ref) => (ref ? ref : null),
  resumeCommand: (command, key) => `${stripSessionFlags(command)} --resume ${key}`,
  turns: 'file',
  parseTurns: parseSessionTurns,
  watchFile: claudeWatchFile
}

const CODEX: Harness = {
  id: 'codex',
  matches: (c) => /^\s*codex\b/.test(c),
  // Stored ref is the rollout FILE path; the resume key is its session uuid.
  sessionField: 'codexSessionRef',
  resumeKey: (ref) => sessionIdFromRolloutPath(ref) ?? (UUID_RE.test(ref) ? ref : null),
  // Global opts (e.g. --dangerously-bypass-approvals-and-sandbox) MUST stay
  // BEFORE the `resume` subcommand (Tinker). Strip any prior resume tail.
  resumeCommand: (command, key) =>
    `${command.replace(/\s+resume\b.*$/, '').trim()} resume ${key}`,
  turns: 'file',
  parseTurns: parseCodexTurns,
  watchFile: codexWatchFile
}

const OPENCODE_SESSION_FLAG_RE = /\s(?:--session|--continue|-s|-c)(?:[= ]\S+)?/g
const OPENCODE: Harness = {
  id: 'opencode',
  matches: (c) => /^\s*opencode\b/.test(c),
  sessionField: 'opencodeSessionId',
  // Defense-in-depth (HIGH-2): opencodeSessionId can arrive via the unauth
  // node-patch endpoint and flows into a shell command — validate the
  // `ses_<base62>` shape before it can reach the launch string.
  resumeKey: (ref) => (/^ses_[A-Za-z0-9]+$/.test(ref) ? ref : null),
  resumeCommand: (command, key) =>
    `${command.replace(OPENCODE_SESSION_FLAG_RE, '').trim()} --session ${key}`,
  // OpenCode has no session-file trace/turn parser yet — declared limitation.
  turns: 'scrape'
}

const PI: Harness = {
  id: 'pi',
  matches: isPiCommand,
  sessionField: 'piSessionId',
  // This value can be restored from persisted/mobile-originated node data and
  // reaches a shell command, so accept only Pi's closed session-id alphabet.
  resumeKey: (ref) => (validPiSessionId(ref) ? ref : null),
  resumeCommand: (command, key, context) =>
    piResumeCommand(command, key, piNodeSessionDir(context.terminalId)),
  turns: 'file',
  parseTurns: parsePiTurns,
  watchFile: piWatchFile
}

/** Every registered harness. Conformance: tests/harness-conformance.test.ts. */
export const HARNESSES: Harness[] = [CLAUDE, CODEX, OPENCODE, PI]

/** The harness a launch command runs, or null (plain shell / unknown). */
export function harnessFor(command: string): Harness | null {
  return HARNESSES.find((h) => h.matches(command)) ?? null
}
