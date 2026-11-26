// Native Claude Code session forking, pure parts.
//
// Claude Code persists every conversation as JSONL under
// ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl. A "rewind fork"
// copies the source session TRUNCATED at the fork turn to a fresh session id
// and launches the fork with `--resume <new-id>` — full-fidelity context
// (real messages and tool calls, not a text replay) while the origin session
// file is only ever read, never modified.

import { HARNESS_CARDS } from './harness-catalog'
import type { TurnRecord } from './turn'
import { CheckpointAssigner, checkpointIdentity, type CheckpointStep } from './session-turns'

/**
 * Slack subtracted from the cutoff when matching session records against
 * scraped turn times: Cookrew stamps startedAt when Enter hits the PTY,
 * Claude writes the user record moments later — both on the same clock.
 */
const CUTOFF_SLACK_MS = 2000

/** Normalized-prompt length used when matching scraped turns to records. */
const MATCH_KEY_CHARS = 48

/** How many recent turns are sampled when scoring a candidate session. */
const MATCH_SAMPLE_TURNS = 12

/** Claude Code's project directory name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-')
}

interface SessionRecord {
  type?: string
  subtype?: string
  isMeta?: boolean
  parentUuid?: string
  content?: unknown
  timestamp?: string
  sessionId?: string
  uuid?: string
  message?: { content?: unknown }
}

function parseRecord(line: string): SessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SessionRecord) : null
  } catch {
    return null
  }
}

interface SteppedLine {
  line: string
  record: SessionRecord | null
  /** The checkpoint this record opens or rejoins (the SAME rule TurnRecord.index comes from). */
  step: CheckpointStep | null
}

/**
 * The session's records, each with the checkpoint it opens: a /goal or a skill
 * is a turn, a /model is not. A /goal's turn opens on its "Goal set:" output,
 * and the command record before it is handed out AS that opening, so no cut
 * leaves the command in the turn before and its work in its own.
 */
function steppedLines(lines: readonly string[]): SteppedLine[] {
  const assigner = new CheckpointAssigner()
  const out: SteppedLine[] = []
  let held: SteppedLine[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const record = parseRecord(line)
    const step = record === null ? null : assigner.feed(record)
    if (record !== null && step === null && assigner.awaitingGoal) {
      out.push(...held)
      held = [{ line, record, step: null }]
      continue
    }
    if (held.length > 0 && step?.command === true) {
      out.push({ ...held[0], step }, ...held.slice(1), { line, record, step: null })
      held = []
      continue
    }
    if (held.length > 0 && record === null) {
      held.push({ line, record, step })
      continue
    }
    out.push(...held, { line, record, step })
    held = []
  }
  return [...out, ...held]
}

/** The line with its session id restamped for the fork. */
function restamped({ line, record }: SteppedLine, sessionId: string): string {
  return typeof record?.sessionId === 'string' ? JSON.stringify({ ...record, sessionId }) : line
}

/**
 * True for records that hold a real user prompt (typed or pasted text).
 * Tool results also arrive as type "user" but carry array content; meta
 * records are agent-internal.
 */
function isPromptRecord(record: SessionRecord): boolean {
  return (
    record.type === 'user' &&
    record.isMeta !== true &&
    typeof record.message?.content === 'string'
  )
}

function recordTimeMs(record: SessionRecord): number {
  const parsed = record.timestamp === undefined ? NaN : Date.parse(record.timestamp)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/** Real user prompts in a session file, in order. */
export function sessionPrompts(lines: string[]): string[] {
  return lines
    .map(parseRecord)
    .filter((r): r is SessionRecord => r !== null && isPromptRecord(r))
    .map((r) => r.message?.content as string)
}

function matchKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MATCH_KEY_CHARS)
}

/**
 * How many of the terminal's recent turn prompts appear in a candidate
 * session file. Turns AFTER the fork point count too — they distinguish the
 * live origin session from a stale sibling fork that shares the same prefix.
 */
export function scoreSessionMatch(prompts: string[], turns: TurnRecord[]): number {
  const keys = new Set(prompts.map(matchKey))
  const sample = turns.slice(-MATCH_SAMPLE_TURNS)
  return sample.filter((t) => keys.has(matchKey(t.prompt))).length
}

/**
 * Everything before the turn AFTER the fork point belongs to the fork:
 * cutoff is that next turn's start time, or null (keep whole session) when
 * forking from the latest turn.
 */
export function forkCutoffMs(turns: TurnRecord[], turnIndex: number): number | null {
  const next = turns.find((t) => t.index > turnIndex)
  return next ? next.startedAt : null
}

export interface ForkedLinesOptions {
  newSessionId: string
  /** Epoch ms; records from the first user prompt at/after this are dropped. */
  cutoffMs: number | null
}

/**
 * Build the forked session's lines from the origin's: stop at the first real
 * user prompt at/after the cutoff (that prompt starts a turn the fork must
 * not have), and stamp every kept record with the new session id. The input
 * lines are never modified.
 */
export function buildForkedSessionLines(lines: string[], options: ForkedLinesOptions): string[] {
  const kept: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const record = parseRecord(line)
    if (record === null) {
      kept.push(line)
      continue
    }
    const pastCutoff =
      options.cutoffMs !== null &&
      isPromptRecord(record) &&
      recordTimeMs(record) >= options.cutoffMs - CUTOFF_SLACK_MS
    if (pastCutoff) break
    kept.push(
      typeof record.sessionId === 'string'
        ? JSON.stringify({ ...record, sessionId: options.newSessionId })
        : line
    )
  }
  return kept
}

export interface ExactForkOptions {
  newSessionId: string
  /** Number of real user turns the fork keeps (turn index == prompt position). */
  keepPrompts: number
}

/**
 * Exact fork truncation for session-bound terminals: TurnRecord indexes
 * mirror the session's real user prompts (session-turns reconcile), so
 * forking after turn N keeps everything before prompt N+1 — real message
 * boundaries, no timestamp guessing. Command-noise user records don't count.
 */
export function buildForkedSessionLinesAtTurn(
  lines: string[],
  options: ExactForkOptions
): string[] {
  const kept: string[] = []
  let prompts = 0
  // "After turn N" cuts where turn N+1 opens, by the rule TurnRecord.index has.
  for (const stepped of steppedLines(lines)) {
    if (stepped.step !== null && !stepped.step.sibling) {
      prompts += 1
      if (prompts > options.keepPrompts) break
    }
    kept.push(restamped(stepped, options.newSessionId))
  }
  return kept
}

export interface ExactUuidForkOptions {
  newSessionId: string
  /** Session message uuid of the prompt entry that started the fork turn. */
  cutoffUuid: string
}

/**
 * Exact fork truncation by message uuid (TurnRecord.uuid). Keeps the cutoff
 * turn — its prompt entry plus every reply/tool record — and everything
 * before it, then breaks at the first real user prompt AFTER the cutoff. No
 * position counting or timestamps: the uuid binds the cut to the precise
 * session message. An unmatched cutoff (or the latest turn) keeps the whole
 * session. Handoff helper for the Forge fork lane.
 */
export function buildForkedSessionLinesAtUuid(
  lines: string[],
  options: ExactUuidForkOptions
): string[] {
  const kept: string[] = []
  let seenCutoff = false
  for (const stepped of steppedLines(lines)) {
    const { step } = stepped
    if (step !== null && !step.sibling && seenCutoff) break
    if (step !== null && checkpointIdentity(step.id) === options.cutoffUuid) seenCutoff = true
    kept.push(restamped(stepped, options.newSessionId))
  }
  return kept
}

export interface AssembledForkOptions {
  newSessionId: string
  /** Prompt-entry uuids of the SELECTED checkpoints (any order). */
  keepUuids: string[]
}

/**
 * Assembled fork truncation (checkpoint-program-spec item 2a): keep ONLY the
 * records inside the selected checkpoints' uuid ranges. A range is a real
 * user prompt entry plus everything up to the next real prompt (its replies
 * and tool records). Header records before the first prompt are always kept;
 * every kept record is restamped with the new session id. Unselected ranges
 * vanish — the fork's context is exactly the chosen checkpoints.
 */
export function buildForkedSessionLinesForUuids(
  lines: string[],
  options: AssembledForkOptions
): string[] {
  const wanted = new Set(options.keepUuids)
  const kept: string[] = []
  let keeping = true // header region before the first prompt
  for (const stepped of steppedLines(lines)) {
    const { step } = stepped
    if (step !== null) {
      // A later record of the same submission carries the turn's uuid (Claude
      // binds the checkpoint to it), so it can switch the turn on, never off.
      const chosen = wanted.has(checkpointIdentity(step.id))
      keeping = step.sibling ? keeping || chosen : chosen
    }
    if (keeping) kept.push(restamped(stepped, options.newSessionId))
  }
  return kept
}

/** True when a terminal runs Claude Code (the only agent we can session-fork). */
export function isClaudeCommand(command: string): boolean {
  return HARNESS_CARDS.claude.matches(command)
}

const SESSION_FLAG_RE = /\s--(?:resume|session-id)(?:[= ]\S+)?/g

/** The command without any --resume/--session-id binding. */
export function stripSessionFlags(command: string): string {
  return command.replace(SESSION_FLAG_RE, '').trim()
}

/**
 * Session id already baked into a launch command (fork nodes persisted
 * before ids were stored on the node), so respawns can adopt it instead of
 * abandoning that session under a fresh id.
 */
export function extractSessionFlag(command: string): string | null {
  const match = /--(?:resume|session-id)[= ]([0-9a-fA-F][0-9a-fA-F-]{7,})/.exec(command)
  return match ? match[1] : null
}

/** Launch command resuming an EXISTING session file under this id. */
export function buildResumeCommand(sourceCommand: string, sessionId: string): string {
  return `${stripSessionFlags(sourceCommand)} --resume ${sessionId}`
}

/** Launch command starting a NEW conversation recorded under this id. */
export function buildSessionIdCommand(sourceCommand: string, sessionId: string): string {
  return `${stripSessionFlags(sourceCommand)} --session-id ${sessionId}`
}
