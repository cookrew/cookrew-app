// Harness registry (agent-recover feature): the per-harness knowledge needed
// to RESUME an agent's existing session on (re)spawn — the same session, as
// it was, no summary/reset. One spec per harness; adding a new agent harness
// is one entry here, so recover/resume extends automatically (note
// agent-recover-feature-design).

import { stripSessionFlags } from '../shared/claude-fork'
import { sessionIdFromRolloutPath } from './codex-bind'

export type HarnessId = 'claude' | 'codex' | 'opencode'

/** TerminalNodeData fields that hold a harness's session reference. */
export type SessionField = 'claudeSessionId' | 'codexSessionRef' | 'opencodeSessionId'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Harness {
  id: HarnessId
  /** True when a launch command runs this harness. */
  matches(command: string): boolean
  /** The node field holding this harness's session reference. */
  sessionField: SessionField
  /** Resume KEY (session id) from the stored field value, or null if unusable. */
  resumeKey(sessionRef: string): string | null
  /** Launch command that RESUMES the given session key, full session as-is. */
  resumeCommand(command: string, key: string): string
}

const CLAUDE: Harness = {
  id: 'claude',
  matches: (c) => /^\s*claude\b/.test(c),
  sessionField: 'claudeSessionId',
  resumeKey: (ref) => (ref ? ref : null),
  resumeCommand: (command, key) => `${stripSessionFlags(command)} --resume ${key}`
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
    `${command.replace(/\s+resume\b.*$/, '').trim()} resume ${key}`
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
    `${command.replace(OPENCODE_SESSION_FLAG_RE, '').trim()} --session ${key}`
}

const HARNESSES: Harness[] = [CLAUDE, CODEX, OPENCODE]

/** The harness a launch command runs, or null (plain shell / unknown). */
export function harnessFor(command: string): Harness | null {
  return HARNESSES.find((h) => h.matches(command)) ?? null
}
