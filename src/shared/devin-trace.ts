// DEVIN CLI SESSION LOG → TRACE BLOCKS (harness expansion P3).
//
// With `session_store: "files"` Devin appends to
// ~/.local/share/devin/cli/sessions/<slug>/log.jsonl (shape read off real
// 3000.14 sessions, 2026-11-26/27; fixtures in tests/fixtures/devin):
//
//   {kind: 'node', at, node: {id, parent_id, message: {role, content,
//     tool_calls?, tool_call_id?, metadata: {finish_reason, created_at,
//     is_user_input, generation_model}}}}
//
// The log is a TREE: ids rise, a node names its parent, and the visible
// conversation is the branch that ends at the newest message. Devin re-roots
// its context more than once before a first reply (five copies of the first
// prompt, each under its own system chain) and writes each assistant step
// twice as siblings; the newest-leaf branch holds each of them once. A node
// written again (same id) is read in its last form. Other record kinds
// (tool_call, tool_call_update, live_row) are progress, not history.
//
// End of turn is NATIVE: a finished reply carries `finish_reason: "stop"`; a
// step that calls tools says "tool_calls", and a call waiting for the
// person's approval has no tool result after it — open, as it should be.

import type { TraceBlock, TraceBlockAccumulator, TraceToolCall } from './trace-blocks'
import { traceResultHead, traceToolArgs, turnAccumulatorOver, turnRecordsOf } from './trace-blocks'
import type { StreamingTurnParser } from './session-turns'
import type { TurnRecord } from './turn'

interface DevinMessage {
  role?: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
  metadata?: { finish_reason?: unknown; created_at?: unknown; is_user_input?: unknown }
}

interface DevinNode {
  id: number
  parent: number | null
  message: DevinMessage
  at: number
}

interface DevinCall {
  id?: unknown
  name?: unknown
  arguments?: unknown
}

/** How deep a parent walk may go before it is called a loop. */
const MAX_WALK = 200_000

function nodeOf(line: string): DevinNode | null {
  try {
    const record = JSON.parse(line) as { kind?: unknown; at?: unknown; node?: { id?: unknown; parent_id?: unknown; message?: unknown } }
    if (record?.kind !== 'node' || !record.node || !Number.isInteger(record.node.id)) return null
    const parent = record.node.parent_id
    const message = typeof record.node.message === 'object' && record.node.message !== null ? (record.node.message as DevinMessage) : {}
    return {
      id: record.node.id as number,
      parent: Number.isInteger(parent) ? (parent as number) : null,
      message,
      at: typeof record.at === 'number' ? record.at * 1000 : 0
    }
  } catch {
    return null
  }
}

export function devinText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? (part.text as string) : ''))
    .filter((text) => text !== '')
    .join('\n')
}

const roleOf = (node: DevinNode): string => (typeof node.message.role === 'string' ? node.message.role : '')
const isPrompt = (node: DevinNode): boolean => roleOf(node) === 'user' && node.message.metadata?.is_user_input === true
const callsOf = (node: DevinNode): DevinCall[] => (Array.isArray(node.message.tool_calls) ? (node.message.tool_calls as DevinCall[]) : [])
const timeOf = (node: DevinNode, fallback: number): number => {
  const at = typeof node.message.metadata?.created_at === 'string' ? Date.parse(node.message.metadata.created_at) : NaN
  return Number.isNaN(at) ? node.at || fallback : at
}

/** One turn's block from its nodes, the prompt first. */
function blockOf(id: string, index: number, nodes: readonly DevinNode[]): TraceBlock {
  const [prompt, ...rest] = nodes
  const startedAt = timeOf(prompt, 0)
  const block: TraceBlock = { id, index, prompt: devinText(prompt.message.content).trim(), reply: '', activity: [], startedAt, endedAt: startedAt }
  const pending = new Map<string, TraceToolCall>()
  for (const node of rest) {
    block.endedAt = timeOf(node, block.endedAt)
    const role = roleOf(node)
    if (role === 'assistant') {
      const text = devinText(node.message.content).trim()
      if (text) block.reply = block.reply ? `${block.reply}\n\n${text}` : text
      for (const call of callsOf(node)) {
        if (typeof call.name !== 'string') continue
        const entry: TraceToolCall = { tool: call.name, args: traceToolArgs(call.arguments), result: '', at: block.reply.length }
        block.activity.push(entry)
        if (typeof call.id === 'string') pending.set(call.id, entry)
      }
    } else if (role === 'tool' && typeof node.message.tool_call_id === 'string') {
      const call = pending.get(node.message.tool_call_id)
      if (call && call.result === '') call.result = traceResultHead(devinText(node.message.content).trim())
    }
  }
  const last = rest.at(-1)
  if (last && roleOf(last) === 'assistant' && last.message.metadata?.finish_reason === 'stop' && callsOf(last).length === 0) {
    block.final = true
  }
  return block
}

/**
 * Resumable Devin parser. The branch is kept as a list of ids and extended
 * from the newest leaf back to where it meets the list, so an append costs
 * its own length; blocks are rebuilt from the first turn the change touched.
 * A change behind the tail turn (a rewind re-rooting the branch) hands out a
 * NEW blocks array, which turnAccumulatorOver reads as a reset.
 * `session` namespaces block ids (contract rule 6).
 */
export function createDevinTraceAccumulator(session?: string): TraceBlockAccumulator {
  const nodes = new Map<number, DevinNode>()
  let chain: number[] = []
  let position = new Map<number, number>()
  let blocks: TraceBlock[] = []
  /** Chain position of each block's prompt. */
  let starts: number[] = []
  let leaf: number | null = null
  const prefix = session ? `${session}:` : ''

  const rebuildFrom = (changed: number): void => {
    // The turn the change falls in is rebuilt from its prompt; a change before
    // the first prompt rebuilds from the change itself (nothing ahead of it moved).
    const turn = starts.findLastIndex((start) => start <= changed)
    const keep = turn < 0 ? 0 : turn
    const from = turn < 0 ? changed : starts[turn]
    const fresh: TraceBlock[] = []
    const freshStarts: number[] = []
    let open: { start: number; members: DevinNode[] } | null = null
    const close = (): void => {
      if (!open) return
      const index = keep + fresh.length + 1
      fresh.push(blockOf(`${prefix}${open.members[0].id}`, index, open.members))
      freshStarts.push(open.start)
    }
    for (let at = Math.min(from, chain.length); at < chain.length; at += 1) {
      const node = nodes.get(chain[at])
      if (!node) continue
      if (isPrompt(node)) {
        close()
        open = { start: at, members: [node] }
      } else if (open) {
        open.members.push(node)
      }
    }
    close()
    const tailOnly = keep >= blocks.length - 1
    if (tailOnly) {
      blocks.length = keep
      blocks.push(...fresh)
      starts.length = keep
      starts.push(...freshStarts)
    } else {
      blocks = [...blocks.slice(0, keep), ...fresh]
      starts = [...starts.slice(0, keep), ...freshStarts]
    }
  }

  const feed = (lines: string[]): void => {
    let changed = Number.POSITIVE_INFINITY
    let leafMoved = false
    for (const line of lines) {
      const node = nodeOf(line)
      if (!node) continue
      nodes.set(node.id, node)
      const at = position.get(node.id)
      if (at !== undefined) changed = Math.min(changed, at)
      // System nodes are context Devin recomputes; the visible branch ends at a message.
      if (roleOf(node) !== 'system' && (leaf === null || node.id > leaf)) {
        leaf = node.id
        leafMoved = true
      }
    }
    if (leafMoved && leaf !== null) {
      const walked: number[] = []
      let at: number | null = leaf
      let join = -1
      while (at !== null && walked.length < MAX_WALK) {
        const known = position.get(at)
        if (known !== undefined) {
          join = known
          break
        }
        walked.push(at)
        at = nodes.get(at)?.parent ?? null
      }
      for (const id of chain.slice(join + 1)) position.delete(id)
      chain = [...chain.slice(0, join + 1), ...walked.reverse()]
      for (let i = join + 1; i < chain.length; i += 1) position.set(chain[i], i)
      changed = Math.min(changed, join + 1)
    }
    if (changed !== Number.POSITIVE_INFINITY) rebuildFrom(changed)
  }

  return { feed, blocks: () => blocks }
}

export function parseDevinTrace(lines: string[], session?: string): TraceBlock[] {
  const accumulator = createDevinTraceAccumulator(session)
  accumulator.feed(lines)
  return accumulator.blocks()
}

/** Devin log → durable turn history, ids namespaced by `session`. */
export function devinTurnParser(session?: string): StreamingTurnParser {
  return Object.assign(
    function parseDevinTurns(lines: string[]): TurnRecord[] {
      return turnRecordsOf(parseDevinTrace(lines, session))
    },
    { createAccumulator: () => turnAccumulatorOver(createDevinTraceAccumulator(session)) }
  )
}

export const parseDevinTurns: StreamingTurnParser = devinTurnParser()
