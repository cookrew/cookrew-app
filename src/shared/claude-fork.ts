// Native Claude Code session forking, pure parts.
//
// Claude Code persists every conversation as JSONL under
// ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl. A "rewind fork"
// copies the source session TRUNCATED at the fork turn to a fresh session id
// and launches the fork with `--resume <new-id>` — full-fidelity context
// (real messages and tool calls, not a text replay) while the origin session
// file is only ever read, never modified.

import type { TurnRecord } from './turn'
import { isNoisePrompt } from './session-turns'

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
  isMeta?: boolean
  timestamp?: string
  sessionId?: string
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
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const record = parseRecord(line)
    if (record === null) {
      kept.push(line)
      continue
    }
    if (isPromptRecord(record) && !isNoisePrompt(record.message?.content as string)) {
      prompts += 1
      if (prompts > options.keepPrompts) break
    }
    kept.push(
      typeof record.sessionId === 'string'
        ? JSON.stringify({ ...record, sessionId: options.newSessionId })
        : line
    )
  }
  return kept
}

/** True when a terminal runs Claude Code (the only agent we can session-fork). */
export function isClaudeCommand(command: string): boolean {
  return /^\s*claude\b/.test(command)
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
