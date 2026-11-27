// ANTIGRAVITY CLI TRANSCRIPT → TRACE BLOCKS (harness expansion P2).
//
// agy writes one JSON object per STEP to
// ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl
// (shape read off real 1.5.18 sessions, 2026-11-26/27; fixtures in
// tests/fixtures/agy):
//
//   {step_index, source, type, status, created_at, content?, model?, tool_calls?}
//   USER_EXPLICIT/USER_INPUT     — the prompt, wrapped in <USER_REQUEST>…</USER_REQUEST>
//   MODEL/PLANNER_RESPONSE       — a reply (content) and/or tool_calls [{name, args}];
//                                  each arg value is itself a JSON-encoded string
//   MODEL/GENERIC                — a tool result, matched to the calls by POSITION
//
// There is no end-of-turn record. The turn ends when the agent loop stops,
// and it stops on a reply that asks for no tool: so a tail whose last step is
// a PLANNER_RESPONSE with content and no tool_calls is final ('structural'
// finality, harness.ts). A tail still holding a tool call — running, or
// waiting for the person's approval — stays open. One step can be written
// twice (a background command): the later write wins, inside the turn.

import type { TraceBlock, TraceBlockAccumulator, TraceToolCall } from './trace-blocks'
import { traceResultHead, traceToolArgs, turnAccumulatorOver, turnRecordsOf } from './trace-blocks'
import type { StreamingTurnParser } from './session-turns'
import type { TurnRecord } from './turn'

interface AgyStep {
  step_index?: number
  source?: string
  type?: string
  status?: string
  created_at?: string
  content?: unknown
  tool_calls?: unknown
}

interface AgyCall {
  name?: unknown
  args?: unknown
}

const REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/
/** The two timestamp lines agy puts ahead of every tool result. */
const RESULT_STAMP_RE = /^(?:Created At|Completed At): .*$/gm

function parseStep(line: string): AgyStep | null {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return null
    const step = value as AgyStep
    return Number.isInteger(step.step_index) ? step : null
  } catch {
    return null
  }
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : '')

/** What the person typed: the request inside agy's wrapper, else the whole text. */
export function agyPromptOf(content: unknown): string {
  const text = textOf(content)
  const request = REQUEST_RE.exec(text)
  return (request ? request[1] : text).trim()
}

/** agy's arg values are JSON strings (`"\"/x\""`): decoded back to what the tool got. */
function decodedArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {}
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value]
      try {
        return [key, JSON.parse(value) as unknown]
      } catch {
        return [key, value]
      }
    })
  )
}

function callsOf(step: AgyStep): AgyCall[] {
  return Array.isArray(step.tool_calls) ? (step.tool_calls as AgyCall[]).filter((call) => typeof call?.name === 'string') : []
}

const isPrompt = (step: AgyStep): boolean => step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT'
const timeOf = (step: AgyStep, fallback: number): number => {
  const at = typeof step.created_at === 'string' ? Date.parse(step.created_at) : NaN
  return Number.isNaN(at) ? fallback : at
}

/**
 * The block one turn's steps make, in step order. Rebuilt from the steps on
 * every write to the turn (a turn is tens of steps), so a step written twice
 * reads the same whichever write came last.
 */
function blockOf(id: string, index: number, steps: readonly AgyStep[]): TraceBlock {
  const [prompt, ...rest] = steps
  const startedAt = timeOf(prompt, 0)
  const block: TraceBlock = { id, index, prompt: agyPromptOf(prompt.content), reply: '', activity: [], startedAt, endedAt: startedAt }
  const pending: TraceToolCall[] = []
  for (const step of rest) {
    block.endedAt = timeOf(step, block.endedAt)
    if (step.type === 'PLANNER_RESPONSE') {
      const text = textOf(step.content).trim()
      if (text) block.reply = block.reply ? `${block.reply}\n\n${text}` : text
      for (const call of callsOf(step)) {
        const entry: TraceToolCall = { tool: String(call.name), args: traceToolArgs(decodedArgs(call.args)), result: '', at: block.reply.length }
        block.activity.push(entry)
        pending.push(entry)
      }
    } else if (step.type === 'GENERIC') {
      const call = pending.shift()
      if (call) call.result = traceResultHead(textOf(step.content).replace(RESULT_STAMP_RE, '').trim())
    }
  }
  const last = rest.at(-1)
  if (last?.type === 'PLANNER_RESPONSE' && last.status === 'DONE' && callsOf(last).length === 0 && textOf(last.content).trim()) {
    block.final = true
  }
  return block
}

/**
 * Resumable agy parser. `conversation` namespaces block ids (contract rule
 * 6: a bare step number collides across conversations); absent, ids are the
 * bare `s<step>` the whole-file parse below uses for tests.
 */
export function createAgyTraceAccumulator(conversation?: string): TraceBlockAccumulator {
  const blocks: TraceBlock[] = []
  const seenPrompts = new Set<number>()
  let turn: { start: number; steps: Map<number, AgyStep> } | null = null
  const rebuild = (): void => {
    if (!turn) return
    const steps = [...turn.steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step)
    const id = `${conversation ? `${conversation}:` : ''}s${turn.start}`
    blocks[blocks.length - 1] = blockOf(id, blocks.length, steps)
  }
  const add = (step: AgyStep): void => {
    const at = step.step_index as number
    if (isPrompt(step)) {
      if (seenPrompts.has(at)) {
        if (turn?.start === at) turn.steps.set(at, step)
        return rebuild()
      }
      seenPrompts.add(at)
      turn = { start: at, steps: new Map([[at, step]]) }
      blocks.push(blockOf('', blocks.length + 1, [step]))
      return rebuild()
    }
    // A step before the open turn belongs to a closed one: closed blocks never change.
    if (!turn || at < turn.start) return
    turn.steps.set(at, step)
    rebuild()
  }
  return {
    feed(lines: string[]): void {
      for (const line of lines) {
        const step = parseStep(line)
        if (step) add(step)
      }
    },
    blocks: () => blocks
  }
}

export function parseAgyTrace(lines: string[], conversation?: string): TraceBlock[] {
  const accumulator = createAgyTraceAccumulator(conversation)
  accumulator.feed(lines)
  return accumulator.blocks()
}

/** agy transcript → durable turn history, ids namespaced by `conversation`. */
export function agyTurnParser(conversation?: string): StreamingTurnParser {
  return Object.assign(
    function parseAgyTurns(lines: string[]): TurnRecord[] {
      return turnRecordsOf(parseAgyTrace(lines, conversation))
    },
    { createAccumulator: () => turnAccumulatorOver(createAgyTraceAccumulator(conversation)) }
  )
}

export const parseAgyTurns: StreamingTurnParser = agyTurnParser()
