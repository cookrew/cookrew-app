// Trace-sourced context blocks (note trace-sourced-context-final): the
// checkpoint context is traced DIRECTLY from the agent-owned session files —
// Claude's ~/.claude/projects JSONL, Codex's ~/.codex/sessions rollouts, and
// Pi's cwd-scoped JSONL in Cookrew's per-node session directories.
// Append-only and uneraseable, so blocks are exact and truncation-immune by
// construction. Pure parsers + the identity-keyed pager live here; file IO
// and caching are main-process (main/trace.ts).

import {
  CheckpointAssigner,
  checkpointIdentity,
  type HistoryDelta,
  type SessionTurnAccumulator,
  type StreamingTurnParser
} from './session-turns'
import type { TurnRecord } from './turn'

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
   * Stable identity: Claude/Pi prompt-entry id; Codex 'p<ordinal>' (1-based
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
  /**
   * POSITIVE end-of-turn evidence written by the harness itself into its own
   * file — codex's `task_complete` event, pi's assistant `stopReason: 'stop'`
   * (both verified on real session files, see the parsers). Absent means the
   * block has no self-proving tail: only a later user prompt (the next-user
   * boundary, applied in turnRecordsOf) can close it.
   */
  final?: boolean
  /**
   * UNSUCCESSFUL terminal evidence the harness itself wrote (Sol r3 P1):
   * codex `turn_aborted` → 'interrupted'; pi `stopReason: 'aborted'` →
   * 'interrupted', 'error'/'length' → 'failed'. Always paired with
   * `final: true` — an abort/error IS positive evidence the turn ended,
   * just not well. Successful finality leaves it absent (absent-on-final
   * means done, see TurnRecord.outcome). Claude has no in-file failure
   * marker (an errored turn simply never writes end_turn), so Claude
   * blocks never carry it.
   */
  outcome?: 'failed' | 'interrupted'
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
  subtype?: string
  isMeta?: boolean
  uuid?: string
  parentUuid?: string
  timestamp?: string
  message?: { content?: unknown }
  compactMetadata?: { preTokens?: number; postTokens?: number }
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
export function parseClaudeTraceDocument(lines: string[]): {
  blocks: TraceBlock[]
  markers: TraceBoundaryMarker[]
} {
  const blocks: TraceBlock[] = []
  const markers: TraceBoundaryMarker[] = []
  let current: TraceBlock | null = null
  const assigner = new CheckpointAssigner()
  // tool_use id → its call object, for filling results (tool_use_id match).
  const pendingCalls = new Map<string, TraceToolCall>()
  for (const line of lines) {
    const entry = parseLine(line) as ClaudeEntry | null
    if (entry === null || typeof entry.type !== 'string') continue
    const content = entry.message?.content
    const step = assigner.feed(entry)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const meta = entry.compactMetadata
      markers.push({
        kind: 'compact',
        afterIndex: assigner.assigned,
        ...(typeof meta?.preTokens === 'number' ? { preTokens: meta.preTokens } : {}),
        ...(typeof meta?.postTokens === 'number' ? { postTokens: meta.postTokens } : {})
      })
    }
    if (step !== null) {
      if (step.sibling && current !== null) {
        // Same submission — collapse: adopt the continuation identity/prompt,
        // keep the accumulated reply/activity (siblings precede any reply).
        current.id = checkpointIdentity(step.id)
        current.prompt = step.id.prompt
        continue
      }
      const startedAt = timeMs(entry.timestamp, current?.endedAt ?? 0)
      current = {
        id: checkpointIdentity(step.id),
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
  return { blocks, markers }
}

/** Whole-file compatibility projection; TraceReader keeps the markers too. */
export function parseClaudeTrace(lines: string[]): TraceBlock[] {
  return parseClaudeTraceDocument(lines).blocks
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
    /** New rollout format (codex-cli ≥ ~0.147): completed conversation items. */
    item?: { type?: string; content?: unknown; phase?: string }
    /** `task_complete` carries the closing reply verbatim. */
    last_agent_message?: string
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

/** A resumable trace parser: feed rollout/session lines in any chunking and
 *  read the blocks so far — identical to a whole-file parse by construction
 *  (the whole-file parsers below are single-feed uses of these). */
export interface TraceBlockAccumulator {
  feed(lines: string[]): void
  blocks(): TraceBlock[]
}

/** Joined text of a new-format item's content blocks. Codex writes the type
 *  tag as 'text' on UserMessage items and 'Text' on AgentMessage items
 *  (verified on real 0.147 rollouts) — accept both. */
function codexItemText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => typeof c.type === 'string' && c.type.toLowerCase() === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

/**
 * Streaming Codex rollout parser. A user prompt opens a block, the agent
 * reply closes it (final_answer phase wins, else the last one), non-message
 * response_items render as activity lines. Block identity is
 * `<session_id>:p<ordinal>` — namespaced by the rollout's own session_id so
 * a TurnRecord.uuid can never collide across sessions (a bare positional
 * 'p<N>' would defeat the uuid carryover guard on rebind).
 *
 * BOTH rollout generations are read (verified against the real corpus under
 * ~/.codex/sessions, 851 old / 12 new / 7 transitional files):
 *  - old:  event_msg `user_message` / `agent_message` events;
 *  - new (codex-cli ≥ ~0.147): event_msg `item_completed` whose item.type is
 *    'UserMessage' / 'AgentMessage' — the old events are gone entirely.
 *    Transitional builds emit item_completed only for 'Plan' items, so the
 *    two prompt shapes never co-occur and cannot double-open a block.
 *
 * FINALITY: `task_complete` is codex's own end-of-turn marker — present in
 * both generations, written once per completed turn with the closing reply
 * as `last_agent_message`. An interrupted turn writes `turn_aborted`
 * instead — ALSO terminal evidence (final, outcome 'interrupted'): the turn
 * ended, unsuccessfully, and a dispatch waiting on it must not strand until
 * the sweep. Either marker lets the TAIL block claim final; everything else
 * waits for the next-user boundary in turnRecordsOf.
 */
export function createCodexTraceAccumulator(): TraceBlockAccumulator {
  const blocks: TraceBlock[] = []
  let current: TraceBlock | null = null
  let sawFinal = false
  let sessionId: string | null = null
  const codexPending = new Map<string, TraceToolCall>()

  const open = (prompt: string, at: number): void => {
    current = {
      id: `${sessionId ?? 'session'}:p${blocks.length + 1}`,
      index: blocks.length + 1,
      prompt,
      reply: '',
      activity: [],
      startedAt: at,
      endedAt: at
    }
    sawFinal = false
    blocks.push(current)
  }

  const reply = (text: string, phase: string | undefined, at: number): void => {
    if (current === null) return
    if (!sawFinal || phase === 'final_answer') {
      current.reply = text
      if (phase === 'final_answer') sawFinal = true
    }
    // A reply arriving REOPENS a block: whatever finality (and terminal
    // outcome) it had earned no longer describes the tail of the exchange
    // (parity with the Claude accumulator's latest-assistant-entry rule).
    delete current.final
    delete current.outcome
    current.endedAt = at
  }

  const feedLine = (line: string): void => {
    const record = parseLine(line) as CodexRecord | null
    if (!record || !record.payload) return
    const at = timeMs(record.timestamp, current?.endedAt ?? 0)
    const payload = record.payload
    if (record.type === 'session_meta' && typeof payload.session_id === 'string') {
      sessionId = payload.session_id
      return
    }
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      if (typeof payload.message === 'string') open(payload.message, at)
      return
    }
    if (record.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item
      if (item?.type === 'UserMessage') {
        const prompt = codexItemText(item.content)
        if (prompt !== null) open(prompt, at)
      } else if (item?.type === 'AgentMessage') {
        const text = codexItemText(item.content)
        if (text !== null) reply(text, item.phase, at)
      }
      return
    }
    if (!current) return
    if (record.type === 'event_msg' && payload.type === 'agent_message') {
      if (typeof payload.message === 'string') reply(payload.message, payload.phase, at)
      else current.endedAt = at
      return
    }
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      // The turn ended and codex said so — a FINALITY marker and nothing
      // more. It must NOT move endedAt when a reply event landed: the
      // previous derivation ignored this event entirely, so the block's
      // endedAt is the last agent message's timestamp, and the stored
      // ledger rows built on that are ground truth (the event lands
      // 100-500ms after the reply; adopting its clock drifted 12/163 real
      // agents on rebuild). The event also carries the closing reply
      // verbatim — used only when no reply event landed at all (truncated
      // reads, transitional formats), where the old parser had nothing
      // either. In THAT fallback there is no prior-derivation ground truth
      // to preserve — endedAt still sat at the prompt time, fabricating a
      // zero-duration completed turn (Sol r3 P2) — so the task_complete
      // timestamp, the only closing clock the file holds, becomes endedAt.
      if (current.reply === '' && typeof payload.last_agent_message === 'string') {
        current.reply = payload.last_agent_message
        current.endedAt = at
      }
      current.final = true
      delete current.outcome
      return
    }
    if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
      // Codex's own record that the turn was cut short — positive TERMINAL
      // evidence, not quiet (Sol r3 P1: discarding it stranded the dispatch
      // until the ten-minute sweep). The turn ended, unsuccessfully: final,
      // with the outcome named. Like task_complete, the marker never moves a
      // clock that prior reply/tool activity supplied — the previous
      // derivation ignored the event entirely, so the stored ledger rows
      // built on those clocks are ground truth. But a prompt aborted before
      // ANY activity landed has no clock at all: endedAt still equals the
      // prompt time, and closing there fabricated a zero-duration
      // interrupted turn (Sol r4 P2). In that shape the abort marker is the
      // only closing clock the file holds — the task_complete fallback's
      // exact twin — so its timestamp becomes endedAt.
      if (current.endedAt === current.startedAt) current.endedAt = at
      current.final = true
      current.outcome = 'interrupted'
      return
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

  return {
    feed(lines: string[]): void {
      for (const line of lines) feedLine(line)
    },
    blocks(): TraceBlock[] {
      return blocks
    }
  }
}

/** Whole-rollout parse — a single feed of the accumulator, so incremental
 *  and whole-file parsing cannot diverge. */
export function parseCodexTrace(lines: string[]): TraceBlock[] {
  const accumulator = createCodexTraceAccumulator()
  accumulator.feed(lines)
  return accumulator.blocks()
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

// ---- Pi session trace ----

interface PiContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  arguments?: unknown
}

interface PiMessage {
  role?: string
  content?: unknown
  timestamp?: number
  toolCallId?: string
  /** Assistant messages carry the model's stop reason ('stop' | 'toolUse' |
   *  'aborted' | 'error' | 'length' — verified on real pi session files). */
  stopReason?: string
}

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: PiMessage
}

function piEntryTime(entry: PiEntry, fallback: number): number {
  if (typeof entry.message?.timestamp === 'number' && Number.isFinite(entry.message.timestamp)) {
    return entry.message.timestamp
  }
  return timeMs(entry.timestamp, fallback)
}

function piText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as PiContentBlock[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * Pi stores a tree in one JSONL file. Follow the last context-bearing leaf to
 * the root so `/tree` branch switches expose only the active conversation,
 * not abandoned sibling branches.
 */
function activePiEntries(entries: readonly PiEntry[]): PiEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]))
  const leaf = [...entries].reverse().find((entry) =>
    entry.type === 'message' || entry.type === 'compaction' || entry.type === 'branch_summary' ||
    entry.type === 'custom_message'
  )
  if (!leaf) return []
  const branch: PiEntry[] = []
  const seen = new Set<string>()
  let current: PiEntry | undefined = leaf
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id)
    branch.push(current)
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
  }
  return branch.reverse()
}

/**
 * Streaming builder over ONE active branch: feed branch entries in order and
 * read the blocks so far. The extracted loop body of the old buildPiBlocks,
 * so the incremental accumulator (extend-the-suffix) and the full rebuild
 * (branch switch) run the SAME code and cannot diverge.
 */
interface PiBlockBuilder {
  add(entry: PiEntry): void
  blocks(): TraceBlock[]
}

function createPiBlockBuilder(): PiBlockBuilder {
  const blocks: TraceBlock[] = []
  const pending = new Map<string, TraceToolCall>()
  let current: TraceBlock | null = null
  const add = (entry: PiEntry): void => {
    if (entry.type !== 'message' || !entry.message) return
    const message = entry.message
    const at = piEntryTime(entry, current?.endedAt ?? 0)
    if (message.role === 'user') {
      const prompt = piText(message.content)
      if (prompt.length === 0) return
      current = {
        id: entry.id as string,
        index: blocks.length + 1,
        prompt,
        reply: '',
        activity: [],
        startedAt: at,
        endedAt: at
      }
      pending.clear()
      blocks.push(current)
      return
    }
    if (!current) return
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const texts: string[] = []
      for (const block of message.content as PiContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text)
        } else if (block.type === 'toolCall' && typeof block.name === 'string' && block.name.trim()) {
          const call: TraceToolCall = {
            tool: block.name.trim(),
            args: claudeToolArgs(block.arguments),
            result: ''
          }
          current.activity.push(call)
          if (typeof block.id === 'string') pending.set(block.id, call)
        }
      }
      if (texts.length > 0) {
        const text = texts.join('\n')
        current.reply = current.reply ? `${current.reply}\n${text}` : text
      }
      // FINALITY tracks the LATEST assistant message's stopReason, exactly
      // like Claude's stop_reason rule (verified on real session files):
      //  - 'stop'    — pi's own end-of-turn marker: final, successful
      //                (outcome absent = done);
      //  - 'toolUse' — more of this turn is coming: open;
      //  - 'aborted' — the turn was cut short: TERMINAL, 'interrupted';
      //  - 'error'   — the model errored out: TERMINAL, 'failed';
      //  - 'length'  — the context/output limit cut the turn: TERMINAL,
      //                'failed' — the turn ENDED, unsuccessfully. Quiet
      //                stays non-terminal everywhere, but a native
      //                abort/error/length marker IS positive evidence the
      //                exchange is over (Sol r3 P1: treating it as
      //                non-final stranded dispatches until the sweep).
      if (message.stopReason === 'stop') {
        current.final = true
        delete current.outcome
      } else if (message.stopReason === 'aborted') {
        current.final = true
        current.outcome = 'interrupted'
      } else if (message.stopReason === 'error' || message.stopReason === 'length') {
        current.final = true
        current.outcome = 'failed'
      } else {
        delete current.final
        delete current.outcome
      }
      current.endedAt = at
      return
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = pending.get(message.toolCallId)
      if (call && call.result === '') call.result = claudeResultText(message.content)
      current.endedAt = at
    }
  }
  return { add, blocks: () => blocks }
}

/** Active-branch blocks from already-parsed pi entries (full walk). */
function buildPiBlocks(entries: readonly PiEntry[]): TraceBlock[] {
  const builder = createPiBlockBuilder()
  for (const entry of activePiEntries(entries)) builder.add(entry)
  return builder.blocks()
}

/** Entry types that can be the active-branch leaf (mirrors activePiEntries). */
const PI_LEAF_TYPES = new Set(['message', 'compaction', 'branch_summary', 'custom_message'])

/** Parse-work counters for the incremental gate (tests/pi-incremental.test.ts):
 *  the eval instrument that keeps Pi observation from regressing to O(total). */
export interface PiTraceStats {
  /** Entries pushed through the block builder since construction. */
  entriesWalked: number
  /** Branch switches paid as full branch rebuilds — the explicit exception. */
  fullRebuilds: number
}

/** A Pi accumulator additionally exposes its parse-work counters. */
export interface PiTraceAccumulator extends TraceBlockAccumulator {
  stats(): PiTraceStats
}

/**
 * Streaming Pi session parser. Pi stores a TREE, and the active branch is
 * derived from the LAST context-bearing leaf backwards — a new entry can
 * re-root the whole visible conversation. Observation is INCREMENTAL in the
 * common case (Sol r3 P1 — I3 promises cost independent of history size,
 * not merely O(Δ) disk reads): an appended entry whose parent IS the
 * current leaf extends the active branch, so it is fed straight into the
 * retained block builder — O(1) per entry, O(suffix) per feed.
 *
 * THE EXPLICIT EXCEPTION: a context-bearing entry whose parent is NOT the
 * current leaf re-roots the branch (a `/tree` switch, a rewind resume, an
 * adopted mid-tree fork). The old branch suffix cannot be un-fed from a
 * streaming builder, so this pays one full branch rebuild — O(entries) —
 * and is counted in stats().fullRebuilds. Branch switches are human-rate
 * events; appends are token-rate, and only appends are on the hot path.
 * All entries stay retained (parsed, not bytes) precisely so the rebuild
 * needs no re-read.
 */
export function createPiTraceAccumulator(): PiTraceAccumulator {
  const entries: PiEntry[] = []
  const known = new Set<string>()
  let builder = createPiBlockBuilder()
  /** Id of the current active-branch leaf the builder is synced to. */
  let leafId: string | null = null
  let entriesWalked = 0
  let fullRebuilds = 0

  const rebuild = (): void => {
    builder = createPiBlockBuilder()
    for (const entry of activePiEntries(entries)) {
      entriesWalked += 1
      builder.add(entry)
    }
    fullRebuilds += 1
  }

  const feedEntry = (entry: PiEntry): void => {
    entries.push(entry)
    if (typeof entry.type !== 'string' || !PI_LEAF_TYPES.has(entry.type)) {
      // Not a context-bearing entry: it cannot be the leaf and is not part
      // of any branch walk until something parents onto it (which the
      // extend check below then sees as a re-root).
      known.add(entry.id as string)
      return
    }
    const parent = typeof entry.parentId === 'string' ? entry.parentId : null
    const extendsBranch =
      leafId !== null ? parent === leafId : parent === null || !known.has(parent)
    known.add(entry.id as string)
    leafId = entry.id as string
    if (extendsBranch) {
      entriesWalked += 1
      builder.add(entry)
      return
    }
    rebuild()
  }

  return {
    feed(lines: string[]): void {
      for (const line of lines) {
        const entry = parseLine(line) as PiEntry | null
        if (entry !== null && typeof entry.id === 'string') feedEntry(entry)
      }
    },
    blocks(): TraceBlock[] {
      return builder.blocks()
    },
    stats(): PiTraceStats {
      return { entriesWalked, fullRebuilds }
    }
  }
}

/** Active-branch transcript blocks from Pi's cwd-scoped JSONL session —
 *  a single feed of the accumulator, so the two paths cannot diverge. */
export function parsePiTrace(lines: string[]): TraceBlock[] {
  const accumulator = createPiTraceAccumulator()
  accumulator.feed(lines)
  return accumulator.blocks()
}

// ---- cheap identity+title listing (fan / timeline full range) ----

/** A boundary event on the checkpoint rail. 'compact' is parsed from the
 * session file itself; 'clear' is a lineage segment boundary emitted by the
 * trace reader (a /clear starts a new FILE — nothing marks it in-file). */
export interface TraceBoundaryMarker {
  kind: 'compact' | 'clear' | 'rewind'
  /** Checkpoint ordinal the boundary sits AFTER (0 = before the first). */
  afterIndex: number
  /** compact_metadata when the boundary record carries it. */
  preTokens?: number
  postTokens?: number
  /** 'clear' only: session id the previous segment ran on. */
  previousSessionId?: string
  /** 'rewind' only: checkpoint the agent was rewound TO. */
  toIndex?: number
}

/**
 * Compact markers from ONE session file: feed every entry through the SHARED
 * CheckpointAssigner so afterIndex matches rail ordinals BY CONSTRUCTION
 * (the same identity rule that keeps trace-block.index === TurnRecord.index),
 * and record each compact_boundary system entry where it lands.
 */
export function compactMarkersOf(lines: string[]): TraceBoundaryMarker[] {
  const markers: TraceBoundaryMarker[] = []
  const assigner = new CheckpointAssigner()
  for (const line of lines) {
    // Assistant/tool-result lines dominate large sessions and can carry tens of
    // kilobytes each. Neither can move the checkpoint assigner or add a compact
    // marker, so reject them before JSON.parse.
    if (!/"type"\s*:\s*"user"/.test(line) && !line.includes('compact_boundary')) continue
    const entry = parseLine(line) as (ClaudeEntry & {
      subtype?: string
      compactMetadata?: { preTokens?: number; postTokens?: number }
    }) | null
    if (entry === null || typeof entry.type !== 'string') continue
    assigner.feed(entry)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const meta = entry.compactMetadata
      markers.push({
        kind: 'compact',
        afterIndex: assigner.assigned,
        ...(typeof meta?.preTokens === 'number' ? { preTokens: meta.preTokens } : {}),
        ...(typeof meta?.postTokens === 'number' ? { postTokens: meta.postTokens } : {})
      })
    }
  }
  return markers
}

/** A lightweight trace listing entry — identity + a display title/snippet. */
export interface TraceIndexEntry {
  index: number
  title: string
  /**
   * The block's stable identity (TraceBlock.id — the prompt entry's message
   * uuid). This is the join key that survives compaction renumbering: after a
   * /compact the ledger continues its indices while the trace restarts at T1
   * (checkpoint-session-alignment), so any consumer pairing records to rows
   * needs the uuid, not the number. Optional so listings from an older remote
   * server still typecheck; consumers fall back to index pairing when absent.
   */
  id?: string
}

/** Cursor for the cheap identity/title listing. Omitted returns the full index. */
export interface TraceIndexRequest {
  /** Return only identities newer than this checkpoint. */
  afterIndex?: number
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
    return {
      index: block.index,
      id: block.id,
      title: line.length > 0 ? head(line, INDEX_TITLE_CHARS) : '(empty prompt)'
    }
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

// ---- harness session → TurnRecord derivation (harness-integration-contract) ----
//
// The durable turn history (endpoint rail titles, card pager) is derived from
// the SAME trace blocks the checkpoint rail reads, so TurnRecord.index ===
// TraceBlock.index BY CONSTRUCTION for every harness — the phantom-offset
// class cannot re-enter through a second parser.

/** Longest reply text carried into a TurnRecord (parity with session-turns). */
const MAX_TURN_REPLY_CHARS = 4000

/** Trace blocks → TurnRecords: same identity, prompt, reply, timestamps.
 *
 * FINALITY (Sol round-2 P0 — a file-backed dispatch must be closable): every
 * NON-TAIL record is final, because a later user prompt in an append-only
 * file is positive evidence the earlier exchange ended (the same next-user
 * rule the Claude accumulator applies). The TAIL record claims final only
 * from a marker the harness itself wrote (TraceBlock.final — codex
 * `task_complete`/`turn_aborted`, pi's terminal stopReasons); a tail
 * mid-stream stays open. An unsuccessful terminal marker (block.outcome)
 * rides along on final records only — outcome without finality would be a
 * verdict on an exchange still running. */
export function turnRecordsOf(blocks: TraceBlock[]): TurnRecord[] {
  const tail = blocks.length - 1
  return blocks.map((block, at) => turnRecordOf(block, at === tail))
}

/** One block's TurnRecord projection — `tail` says whether it currently sits
 *  at the end of the history (positional finality applies to everything
 *  else). Extracted from turnRecordsOf so the delta path below can project a
 *  SUFFIX without mapping the whole array. */
function turnRecordOf(block: TraceBlock, tail: boolean): TurnRecord {
  const final = !tail || block.final === true
  return {
    index: block.index,
    prompt: block.prompt,
    reply: block.reply.slice(0, MAX_TURN_REPLY_CHARS),
    uuid: block.id,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    ...(final ? { final: true } : {}),
    ...(final && block.outcome !== undefined ? { outcome: block.outcome } : {})
  }
}

/** Field equality over everything a parser-derived TurnRecord carries — the
 *  delta cursor's change detector. Trace blocks are extended in place by the
 *  streaming parsers, so (unlike the Claude accumulator's replaced records)
 *  reference identity cannot stand in for it. */
function sameTurnRecord(a: TurnRecord, b: TurnRecord): boolean {
  return (
    a.index === b.index &&
    a.uuid === b.uuid &&
    a.prompt === b.prompt &&
    a.reply === b.reply &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.final === b.final &&
    a.outcome === b.outcome
  )
}

/** A TraceBlockAccumulator wrapped as the SessionTurnAccumulator shape
 *  SessionTurnSync resumes — records() re-derives finality positionally, so
 *  a block that stops being the tail becomes final exactly on the feed that
 *  brought the next prompt.
 *
 *  takeDelta (Sol r4 P1) rides the same invariant the parsers guarantee: a
 *  NON-TAIL block never changes again (Codex's late tool outputs touch only
 *  `activity`, which no TurnRecord field reads), so the change since the
 *  last take is the tail plus whatever appended — projected as a SUFFIX,
 *  O(delta). The one exception is Pi's branch-switch rebuild, which swaps
 *  the builder and with it the identity of the blocks() array; a changed
 *  array is the 'reset' signal (Codex and the linear Pi path keep one array
 *  for the accumulator's lifetime). */
function turnAccumulatorOver(blockAccumulator: TraceBlockAccumulator): SessionTurnAccumulator {
  /** takeDelta cursor: blocks projected by the last take… */
  let emittedCount = 0
  /** …the tail record exactly as it was handed out… */
  let emittedTail: TurnRecord | undefined
  /** …and the blocks() array it was projected from (rebuild detection). */
  let emittedBlocks: TraceBlock[] | undefined

  return {
    feed: (lines) => blockAccumulator.feed(lines),
    records: () => turnRecordsOf(blockAccumulator.blocks()),
    takeDelta(): HistoryDelta {
      const blocks = blockAccumulator.blocks()
      const count = blocks.length
      if (emittedBlocks !== undefined && blocks !== emittedBlocks) {
        // A rebuilt branch re-wrote history at arbitrary depth — nothing
        // previously emitted can be trusted, so the consumer re-projects.
        emittedBlocks = blocks
        emittedCount = count
        emittedTail = count > 0 ? turnRecordOf(blocks[count - 1], true) : undefined
        return { kind: 'reset' }
      }
      emittedBlocks = blocks
      // The last emitted record, projected for its CURRENT position — when
      // blocks appended behind it, positional finality lands here (the same
      // rule turnRecordsOf applies), which is exactly the rewrite the delta
      // must carry. A stale tail goes out ALONE (partial advance, see
      // HistoryDelta): queued appends follow on the immediate next take.
      const prior =
        emittedCount > 0 ? turnRecordOf(blocks[emittedCount - 1], emittedCount === count) : undefined
      if (prior !== undefined && emittedTail !== undefined && !sameTurnRecord(prior, emittedTail)) {
        emittedTail = prior
        return { kind: 'tail', record: prior }
      }
      const records = blocks
        .slice(emittedCount)
        .map((block, at, span) => turnRecordOf(block, at === span.length - 1))
      emittedCount = count
      if (records.length > 0) emittedTail = records[records.length - 1]
      return { kind: 'append', records }
    }
  }
}

/** Codex rollout JSONL → durable turn history (resumable: O(Δ) reconcile). */
export const parseCodexTurns: StreamingTurnParser = Object.assign(
  function parseCodexTurns(lines: string[]): TurnRecord[] {
    return turnRecordsOf(parseCodexTrace(lines))
  },
  { createAccumulator: () => turnAccumulatorOver(createCodexTraceAccumulator()) }
)

/** Pi session JSONL (active branch) → durable turn history (resumable). */
export const parsePiTurns: StreamingTurnParser = Object.assign(
  function parsePiTurns(lines: string[]): TurnRecord[] {
    return turnRecordsOf(parsePiTrace(lines))
  },
  { createAccumulator: () => turnAccumulatorOver(createPiTraceAccumulator()) }
)
