// Trace-sourced context blocks (note trace-sourced-context-final): the
// checkpoint context is traced DIRECTLY from the agent-owned session files —
// Claude's ~/.claude/projects JSONL and Codex's ~/.codex/sessions rollouts.
// Append-only and uneraseable, so blocks are exact and truncation-immune by
// construction. Pure parsers + the identity-keyed pager live here; file IO
// and caching are main-process (main/trace.ts).

import { isNoisePrompt } from './session-turns'

export interface TraceBlock {
  /**
   * Stable identity: Claude prompt-entry uuid; Codex 'p<ordinal>' (1-based
   * user_message position — rollouts are append-only, ordinals never shift).
   */
  id: string
  /** 1-based checkpoint ordinal; aligns with TurnRecord.index for Claude. */
  index: number
  /** Exact prompt text, newlines included. */
  prompt: string
  /** Joined assistant text for the block. */
  reply: string
  /** Dim tool-activity lines in TUI order (e.g. 'Bash(npm test)'). */
  activity: string[]
  startedAt: number
  endedAt: number
}

/** Head of a tool input rendered into an activity line. */
const ACTIVITY_ARG_CHARS = 80

function timeMs(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? fallback : parsed
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ---- Claude session trace ----

interface ClaudeEntry {
  type?: string
  isMeta?: boolean
  uuid?: string
  timestamp?: string
  message?: { content?: unknown }
}

interface ClaudeContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

function claudeActivityLine(block: ClaudeContentBlock): string {
  const head = block.input === undefined ? '' : JSON.stringify(block.input)
  const brief =
    head.length > ACTIVITY_ARG_CHARS ? `${head.slice(0, ACTIVITY_ARG_CHARS - 1)}…` : head
  // {"command":"npm test"} → npm test for the common single-arg case.
  const single = /^\{"[a-zA-Z_]+":"(.*)"\}$/.exec(brief)
  return `${block.name ?? 'tool'}(${single ? single[1] : brief})`
}

/**
 * Full-trace blocks from a Claude session file: one block per real user
 * prompt (uuid-keyed), reply joined from assistant text, tool_use calls as
 * activity lines. Corrupt lines and noise prompts are skipped.
 */
export function parseClaudeTrace(lines: string[]): TraceBlock[] {
  const blocks: TraceBlock[] = []
  let current: TraceBlock | null = null
  for (const line of lines) {
    const entry = parseLine(line) as ClaudeEntry | null
    if (entry === null || typeof entry.type !== 'string') continue
    const content = entry.message?.content
    const isPrompt =
      entry.type === 'user' &&
      entry.isMeta !== true &&
      typeof content === 'string' &&
      !isNoisePrompt(content)
    if (isPrompt) {
      const startedAt = timeMs(entry.timestamp, current?.endedAt ?? 0)
      current = {
        id: entry.uuid ?? `claude-${blocks.length + 1}`,
        index: blocks.length + 1,
        prompt: content as string,
        reply: '',
        activity: [],
        startedAt,
        endedAt: startedAt
      }
      blocks.push(current)
      continue
    }
    if (!current || entry.type !== 'assistant' || !Array.isArray(content)) continue
    const texts: string[] = []
    for (const raw of content as ClaudeContentBlock[]) {
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim().length > 0) {
        texts.push(raw.text)
      } else if (raw.type === 'tool_use') {
        current.activity.push(claudeActivityLine(raw))
      }
    }
    if (texts.length > 0) {
      current.reply = current.reply.length > 0 ? `${current.reply}\n${texts.join('\n')}` : texts.join('\n')
    }
    current.endedAt = timeMs(entry.timestamp, current.endedAt)
  }
  return blocks
}

// ---- Codex rollout trace ----

interface CodexRecord {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    name?: string
    message?: string
    phase?: string
    session_id?: string
    cwd?: string
    timestamp?: string
  }
}

export interface CodexSessionMeta {
  sessionId: string
  cwd: string
  timestampMs: number
}

/** The binder's key: rollout line 1 is {type:'session_meta', payload:{...}}. */
export function parseCodexSessionMeta(line: string): CodexSessionMeta | null {
  const record = parseLine(line) as CodexRecord | null
  if (!record || record.type !== 'session_meta') return null
  const payload = record.payload
  if (!payload || typeof payload.session_id !== 'string' || typeof payload.cwd !== 'string') {
    return null
  }
  return {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    timestampMs: timeMs(payload.timestamp ?? record.timestamp, 0)
  }
}

/** response_item payload types that are conversation noise, not activity. */
const CODEX_SILENT_ITEMS = new Set(['message', 'reasoning'])

/**
 * Blocks from a Codex rollout: event_msg user_message opens a block
 * ('p<ordinal>' identity), agent_message closes its reply (final_answer
 * phase wins, else the last one), non-message response_items render as
 * activity lines.
 */
export function parseCodexTrace(lines: string[]): TraceBlock[] {
  const blocks: TraceBlock[] = []
  let current: TraceBlock | null = null
  let sawFinal = false
  for (const line of lines) {
    const record = parseLine(line) as CodexRecord | null
    if (!record || !record.payload) continue
    const at = timeMs(record.timestamp, current?.endedAt ?? 0)
    const payload = record.payload
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      if (typeof payload.message !== 'string') continue
      current = {
        id: `p${blocks.length + 1}`,
        index: blocks.length + 1,
        prompt: payload.message,
        reply: '',
        activity: [],
        startedAt: at,
        endedAt: at
      }
      sawFinal = false
      blocks.push(current)
      continue
    }
    if (!current) continue
    if (record.type === 'event_msg' && payload.type === 'agent_message') {
      if (typeof payload.message === 'string' && (!sawFinal || payload.phase === 'final_answer')) {
        current.reply = payload.message
        if (payload.phase === 'final_answer') sawFinal = true
      }
      current.endedAt = at
      continue
    }
    if (record.type === 'response_item' && payload.type && !CODEX_SILENT_ITEMS.has(payload.type)) {
      current.activity.push(payload.name ? `${payload.type}(${payload.name})` : payload.type)
      current.endedAt = at
    }
  }
  return blocks
}

// ---- identity-keyed paging (review BLOCK 2: never array positions) ----

export interface TracePageRequest {
  /** The `limit` blocks OLDER than this TraceBlock.index (scroll-up). */
  beforeIndex?: number
  /** The `limit` blocks NEWER than this TraceBlock.index. */
  afterIndex?: number
  /** Window centered on this TraceBlock.index (checkpoint click). */
  aroundIndex?: number
  /** Window size; default 20. */
  limit?: number
}

export interface TracePage {
  blocks: TraceBlock[]
  /** Full trace length — sizes the transcript virtualizer. */
  total: number
}

const TRACE_PAGE_DEFAULT_LIMIT = 20

/**
 * Window a trace by block IDENTITY (TraceBlock.index), never array offsets:
 * identities survive caps and non-contiguous histories. End windows come
 * back SHORT rather than shifted, so virtualizers never get duplicates.
 */
export function pageTraceBlocks(blocks: TraceBlock[], request: TracePageRequest = {}): TracePage {
  const total = blocks.length
  const limit = Math.max(1, request.limit ?? TRACE_PAGE_DEFAULT_LIMIT)
  if (total === 0) return { blocks: [], total: 0 }

  if (request.beforeIndex !== undefined) {
    const older = blocks.filter((b) => b.index < (request.beforeIndex as number))
    return { blocks: older.slice(Math.max(0, older.length - limit)), total }
  }
  if (request.afterIndex !== undefined) {
    const newer = blocks.filter((b) => b.index > (request.afterIndex as number))
    return { blocks: newer.slice(0, limit), total }
  }
  if (request.aroundIndex !== undefined) {
    const at = blocks.findIndex((b) => b.index === request.aroundIndex)
    if (at >= 0) {
      const start = Math.max(0, Math.min(at - Math.floor((limit - 1) / 2), total - limit))
      return { blocks: blocks.slice(start, start + limit), total }
    }
    // Unknown checkpoint → tail fallback.
  }
  return { blocks: blocks.slice(Math.max(0, total - limit)), total }
}
