// A HOSTED AGENT'S TRANSCRIPT → TRACE BLOCKS (harness expansion P4).
//
// cli/cookrew-acp.mjs runs an ACP agent in a card's pane and writes Cookrew's
// own transcript of it, ~/.cookrew/hosted/<agent>/<session>.jsonl, one record
// per line. The format is Cookrew's, not the agent's, so one parser serves
// every hosted agent:
//
//   {t:'session', v:1, agent, id, cwd, at}   the file's first line
//   {t:'resume', id, cwd, at}                 a later process took the session up
//   {t:'model', model, effort, at}
//   {t:'user', text, at}                      opens a turn
//   {t:'text' | 'thought', message, text, at} reply / thinking, in coalesced runs
//   {t:'tool', id, title, kind, input, at}    a tool call
//   {t:'tool_done', id, status, output, at}   its result
//   {t:'permission', id, about, options, at}  the agent asked; {t:'answer', option, at}
//   {t:'error', message, at}
//   {t:'end', stop, at}                       the turn's end (ACP stopReason)
//
// End of turn is NATIVE: the host writes `end` when the agent's
// session/prompt answers. A turn waiting for approval has no `end` yet.

import type { TraceBlock, TraceBlockAccumulator, TraceThought, TraceToolCall } from './trace-blocks'
import { traceResultHead, turnAccumulatorOver, turnRecordsOf } from './trace-blocks'
import type { StreamingTurnParser } from './session-turns'
import type { TurnRecord } from './turn'

interface HostedRecord {
  t?: unknown
  text?: unknown
  message?: unknown
  id?: unknown
  title?: unknown
  input?: unknown
  status?: unknown
  output?: unknown
  stop?: unknown
  at?: unknown
}

/** ACP stopReasons: a cancel is an interruption; the limits and a refusal end a turn unsuccessfully. */
const INTERRUPTED = new Set(['cancelled'])
const FAILED = new Set(['max_tokens', 'max_turn_requests', 'refusal', 'error'])
const THOUGHT_CHARS = 2000

function recordOf(line: string): HostedRecord | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && typeof (value as HostedRecord).t === 'string' ? (value as HostedRecord) : null
  } catch {
    return null
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const timeOf = (record: HostedRecord, fallback: number): number => (typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : fallback)

export function createHostedTraceAccumulator(session?: string): TraceBlockAccumulator {
  const blocks: TraceBlock[] = []
  const calls = new Map<string, TraceToolCall>()
  let current: TraceBlock | null = null
  let prompts = 0
  /** The message the reply's last run belonged to: a new message starts a paragraph. */
  let lastMessage: string | null = null
  const prefix = session ? `${session}:` : ''

  const add = (record: HostedRecord): void => {
    if (record.t === 'user') {
      prompts += 1
      const at = timeOf(record, current?.endedAt ?? 0)
      current = { id: `${prefix}u${prompts}`, index: blocks.length + 1, prompt: str(record.text), reply: '', activity: [], startedAt: at, endedAt: at }
      blocks.push(current)
      calls.clear()
      lastMessage = null
      return
    }
    if (!current) return
    current.endedAt = timeOf(record, current.endedAt)
    switch (record.t) {
      case 'text': {
        const text = str(record.text)
        if (!text) return
        const message = str(record.message) || null
        const joint = current.reply && message !== lastMessage ? '\n\n' : ''
        current.reply = `${current.reply}${joint}${text}`
        lastMessage = message
        return
      }
      case 'thought': {
        const text = str(record.text).trim()
        if (!text) return
        const thought: TraceThought = { at: current.reply.length, calls: current.activity.length, text: text.slice(0, THOUGHT_CHARS) }
        current.thoughts = [...(current.thoughts ?? []), thought]
        return
      }
      case 'tool': {
        const call: TraceToolCall = { tool: str(record.title) || 'tool', args: str(record.input), result: '', at: current.reply.length }
        current.activity.push(call)
        if (typeof record.id === 'string') calls.set(record.id, call)
        lastMessage = null
        return
      }
      case 'tool_done': {
        const call = typeof record.id === 'string' ? calls.get(record.id) : undefined
        if (call && call.result === '') call.result = traceResultHead(str(record.output).trim() || str(record.status))
        return
      }
      case 'end': {
        const stop = str(record.stop)
        current.final = true
        if (INTERRUPTED.has(stop)) current.outcome = 'interrupted'
        else if (FAILED.has(stop)) current.outcome = 'failed'
        else delete current.outcome
        return
      }
      default:
        return
    }
  }

  return {
    feed(lines: string[]): void {
      for (const line of lines) {
        const record = recordOf(line)
        if (record) add(record)
      }
    },
    blocks: () => blocks
  }
}

export function parseHostedTrace(lines: string[], session?: string): TraceBlock[] {
  const accumulator = createHostedTraceAccumulator(session)
  accumulator.feed(lines)
  return accumulator.blocks()
}

/** A hosted transcript → durable turn history, ids namespaced by `session`. */
export function hostedTurnParser(session?: string): StreamingTurnParser {
  return Object.assign(
    function parseHostedTurns(lines: string[]): TurnRecord[] {
      return turnRecordsOf(parseHostedTrace(lines, session))
    },
    { createAccumulator: () => turnAccumulatorOver(createHostedTraceAccumulator(session)) }
  )
}

export const parseHostedTurns: StreamingTurnParser = hostedTurnParser()
