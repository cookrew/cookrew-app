// Trace-sourced context blocks (note trace-sourced-context-final): the
// checkpoint context is traced DIRECTLY from the agent-owned session files —
// Claude's ~/.claude/projects JSONL and Codex's ~/.codex/sessions rollouts.
// Append-only and uneraseable, so blocks are exact and truncation-immune by
// construction. Pure parsers + the identity-keyed pager live here; file IO
// and caching are main-process (main/trace.ts).

import { CheckpointAssigner } from './session-turns'

/** One tool invocation inside a block, TUI-faithful (unified-scroll TODO). */
export interface TraceToolCall {
  tool: string
  /** Brief rendered args (head-capped). */
  args: string
  /** Result snippet (head-capped); '' when no output was captured. */
  result: string
}

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
  /** Tool invocations in TUI order, with matched results. */
  activity: TraceToolCall[]
  startedAt: number
  endedAt: number
}

/** Head of a tool input rendered into an activity line. */
const ACTIVITY_ARG_CHARS = 80
/** Head of a tool result snippet. */
const ACTIVITY_RESULT_CHARS = 160

const head = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

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
  parentUuid?: string
  timestamp?: string
  message?: { content?: unknown }
}

interface ClaudeContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

/**
 * Short HUMAN summary of a tool_use input (bare-parens fix): prefer the
 * input.description Claude Code writes for most calls, else the first
 * string value (command, file_path, pattern, …), head-capped. Never JSON.
 */
function claudeToolArgs(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  const description = record.description
  if (typeof description === 'string' && description.trim().length > 0) {
    return head(description.trim(), ACTIVITY_ARG_CHARS)
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return head(value.trim(), ACTIVITY_ARG_CHARS)
    }
  }
  return ''
}

/** Text head of a tool_result content (string, or [{type:'text',text}]). */
function claudeResultText(content: unknown): string {
  if (typeof content === 'string') return head(content, ACTIVITY_RESULT_CHARS)
  if (Array.isArray(content)) {
    const texts = (content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c.text === 'string')
      .map((c) => c.text as string)
    return head(texts.join('\n'), ACTIVITY_RESULT_CHARS)
  }
  return ''
}

/**
 * Full-trace blocks from a Claude session file: one block per real checkpoint,
 * reply joined from assistant text, tool_use calls as structured activity.
 *
 * CHECKPOINT IDENTITY comes from the SHARED CheckpointAssigner — the SAME
 * image-aware, noise-skipping, sibling-collapsing rule parseSessionTurns
 * uses — so trace-block.index === TurnRecord.index by construction (the
 * two are no longer independent positional counters). block.id stays the
 * bound message uuid so records-union-trace pairs by real identity.
 */
export function parseClaudeTrace(lines: string[]): TraceBlock[] {
  const blocks: TraceBlock[] = []
  let current: TraceBlock | null = null
  const assigner = new CheckpointAssigner()
  // tool_use id → its call object, for filling results (tool_use_id match).
  const pendingCalls = new Map<string, TraceToolCall>()
  for (const line of lines) {
    const entry = parseLine(line) as ClaudeEntry | null
    if (entry === null || typeof entry.type !== 'string') continue
    const content = entry.message?.content
    const step = assigner.feed(entry)
    if (step !== null) {
      if (step.sibling && current !== null) {
        // Same submission — collapse: adopt the continuation identity/prompt,
        // keep the accumulated reply/activity (siblings precede any reply).
        current.id = step.id.uuid ?? current.id
        current.prompt = step.id.prompt
        continue
      }
      const startedAt = timeMs(entry.timestamp, current?.endedAt ?? 0)
      current = {
        id: step.id.uuid ?? `claude-${step.id.index}`,
        index: step.id.index,
        prompt: step.id.prompt,
        reply: '',
        activity: [],
        startedAt,
        endedAt: startedAt
      }
      pendingCalls.clear()
      blocks.push(current)
      continue
    }
    if (!current) continue
    // tool_result entries arrive as user records with array content.
    if (entry.type === 'user' && Array.isArray(content)) {
      for (const raw of content as ClaudeContentBlock[]) {
        if (raw.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') continue
        const call = pendingCalls.get(raw.tool_use_id)
        if (call && call.result === '') call.result = claudeResultText(raw.content)
      }
      current.endedAt = timeMs(entry.timestamp, current.endedAt)
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    const texts: string[] = []
    for (const raw of content as ClaudeContentBlock[]) {
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim().length > 0) {
        texts.push(raw.text)
      } else if (
        raw.type === 'tool_use' &&
        typeof raw.name === 'string' &&
        raw.name.trim().length > 0
      ) {
        // Empty-name blocks are SKIPPED — a bare "()" line is worse than
        // nothing (user screenshot evidence).
        const call: TraceToolCall = {
          tool: raw.name.trim(),
          args: claudeToolArgs(raw.input),
          result: ''
        }
        current.activity.push(call)
        if (typeof raw.id === 'string') pendingCalls.set(raw.id, call)
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
    call_id?: string
    arguments?: string
    input?: string
    output?: unknown
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
  const codexPending = new Map<string, TraceToolCall>()
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
      // Tool call open: function_call {name, arguments} / custom_tool_call
      // {name, input}; outputs match back by call_id.
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const tool = (payload.name ?? '').trim() || payload.type
        const args = head(payload.arguments ?? payload.input ?? '', ACTIVITY_ARG_CHARS)
        const call: TraceToolCall = { tool, args, result: '' }
        current.activity.push(call)
        if (typeof payload.call_id === 'string') codexPending.set(payload.call_id, call)
      } else if (
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output'
      ) {
        const call =
          typeof payload.call_id === 'string' ? codexPending.get(payload.call_id) : undefined
        if (call && call.result === '') call.result = codexOutputText(payload.output)
      } else {
        current.activity.push({ tool: payload.type, args: payload.name ?? '', result: '' })
      }
      current.endedAt = at
    }
  }
  return blocks
}

/** Text head of a codex output (string, or [{type:'input_text', text}]). */
function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return head(output, ACTIVITY_RESULT_CHARS)
  if (Array.isArray(output)) {
    const texts = (output as Array<{ text?: string }>)
      .filter((c) => typeof c.text === 'string')
      .map((c) => c.text as string)
    return head(texts.join(''), ACTIVITY_RESULT_CHARS)
  }
  return ''
}

// ---- cheap identity+title listing (fan / timeline full range) ----

/** A lightweight trace listing entry — identity + a display title/snippet. */
export interface TraceIndexEntry {
  index: number
  title: string
}

/** Snippet length for index titles (one row in the fan). */
const INDEX_TITLE_CHARS = 80

/**
 * Identity + title listing over parsed blocks: the fan/timeline spans the
 * WHOLE trace (T1..N incl. identities below the record cap) without paying
 * for full bodies. Title = first non-empty prompt line, head-capped.
 */
export function traceIndexOf(blocks: readonly TraceBlock[]): TraceIndexEntry[] {
  return blocks.map((block) => {
    const line = block.prompt.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
    return { index: block.index, title: line.length > 0 ? head(line, INDEX_TITLE_CHARS) : '(empty prompt)' }
  })
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
  const count = blocks.length
  // total is the CEILING IDENTITY (last block's index), not the array length:
  // the fan/timeline spans floor..ceiling by real identity so Conductor's
  // past-cap span works without clamping to the record count.
  const total = count === 0 ? 0 : blocks[count - 1].index
  const limit = Math.max(1, request.limit ?? TRACE_PAGE_DEFAULT_LIMIT)
  if (count === 0) return { blocks: [], total: 0 }

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
      const start = Math.max(0, Math.min(at - Math.floor((limit - 1) / 2), count - limit))
      return { blocks: blocks.slice(start, start + limit), total }
    }
    // Unknown checkpoint → tail fallback.
  }
  return { blocks: blocks.slice(Math.max(0, count - limit)), total }
}
