/**
 * THE CHAT FOLDS THE WORK, SHOWS THE ANSWER (owner, 2026-11-01: "fold the
 * thinking and the tool calls"). An agent's turn is its thinking, the words it
 * says between steps, its tool calls, and at the end the answer. The chat
 * shows the answer and one closed line for everything before it; opened, the
 * steps read in the order they happened.
 *
 * Pure: the parser marks where in the reply each call and thought fell
 * (trace-blocks.ts · TraceToolCall.at, TraceThought.at) and after how many
 * calls each thought came (two steps with no words between share a place).
 * A call without a mark (codex: its reply is only its last message) came
 * before all of it.
 */
import type { TraceBlock, TraceToolCall } from '../../shared/trace-blocks'

export type ChatStep =
  | { kind: 'thought'; text: string }
  | { kind: 'said'; text: string }
  | { kind: 'tool'; call: TraceToolCall }

export interface ChatFold {
  /** Everything before the answer, in order; empty when the turn took no step. */
  steps: ChatStep[]
  /** The words after the last step: what the chat shows unfolded. */
  answer: string
  thoughts: number
  tools: number
}

type Marked = { at: number; step: ChatStep }

/** Calls in their order, each thought before the first call it preceded. */
function inOrder(block: Pick<TraceBlock, 'activity' | 'thoughts'>, clampAt: (at: number | undefined) => number): Marked[] {
  const thoughts = block.thoughts ?? []
  const out: Marked[] = []
  let t = 0
  const thoughtsUpTo = (calls: number): void => {
    for (; t < thoughts.length && thoughts[t].calls <= calls; t++) out.push({ at: clampAt(thoughts[t].at), step: { kind: 'thought', text: thoughts[t].text } })
  }
  block.activity.forEach((call, i) => {
    thoughtsUpTo(i)
    out.push({ at: clampAt(call.at), step: { kind: 'tool', call } })
  })
  thoughtsUpTo(Number.POSITIVE_INFINITY)
  return out
}

export function chatFoldOf(block: Pick<TraceBlock, 'reply' | 'activity' | 'thoughts'>): ChatFold {
  const { reply, activity } = block
  const thoughts = block.thoughts ?? []
  const clampAt = (at: number | undefined): number => Math.max(0, Math.min(reply.length, at ?? 0))
  const marked = inOrder(block, clampAt)
  if (marked.length === 0) return { steps: [], answer: reply, thoughts: 0, tools: 0 }
  const steps: ChatStep[] = []
  let cursor = 0
  for (const m of marked) {
    if (m.at > cursor) {
      const said = reply.slice(cursor, m.at).trim()
      if (said) steps.push({ kind: 'said', text: said })
      cursor = m.at
    }
    steps.push(m.step)
  }
  return { steps, answer: reply.slice(cursor).trim(), thoughts: thoughts.length, tools: activity.length }
}

/** The closed line: what the agent did before answering ("Thought · 12 tool calls"). */
export function chatFoldLabel(fold: Pick<ChatFold, 'thoughts' | 'tools'>): string {
  const parts = [
    fold.thoughts > 0 ? 'Thought' : null,
    fold.tools > 0 ? `${fold.tools} tool call${fold.tools === 1 ? '' : 's'}` : null
  ].filter((p): p is string => p !== null)
  return parts.length ? parts.join(' · ') : 'Worked'
}

/** The newest step, for the closed line while the turn has no answer yet: what it is doing now. */
export function latestStepLine(steps: readonly ChatStep[]): string | null {
  const last = steps[steps.length - 1]
  if (!last) return null
  if (last.kind === 'tool') return last.call.args ? `${last.call.tool} · ${last.call.args}` : last.call.tool
  const line = last.text.split('\n').find((l) => l.trim()) ?? ''
  return line.trim() || null
}
