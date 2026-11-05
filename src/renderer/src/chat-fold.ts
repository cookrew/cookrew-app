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
 *
 * WORDS YOU SENT MID-TURN SPLIT IT INTO LEGS (owner, 2026-11-05). They are your
 * side of the chat, so they cannot sit in a fold: each leg folds on its own and
 * your bubble stands between them, where the agent read it (TraceAddedPrompt).
 */
import type { TraceAddedPrompt, TraceBlock, TraceToolCall } from '../../shared/trace-blocks'

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

/** One stretch of a turn: the words you said to start it (null for the first, the prompt's own), and what the agent did. */
export interface ChatLeg {
  words: string | null
  fold: ChatFold
}

type Foldable = Pick<TraceBlock, 'reply' | 'activity' | 'thoughts'>
type Place = Pick<TraceAddedPrompt, 'at' | 'calls' | 'thoughts'>

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

export function chatFoldOf(block: Foldable): ChatFold {
  const { reply, activity } = block
  const thoughts = block.thoughts ?? []
  const clampAt = (at: number | undefined): number => Math.max(0, Math.min(reply.length, at ?? 0))
  const marked = inOrder(block, clampAt)
  if (marked.length === 0) return { steps: [], answer: reply.trim(), thoughts: 0, tools: 0 }
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

/** What happened between two places in a turn, with its marks counted from the first. */
function stretchOf(block: Foldable, from: Place, to: Place): Foldable {
  return {
    reply: block.reply.slice(from.at, to.at),
    activity: block.activity
      .slice(from.calls, to.calls)
      .map((call) => (call.at === undefined ? call : { ...call, at: call.at - from.at })),
    thoughts: (block.thoughts ?? [])
      .slice(from.thoughts, to.thoughts)
      .map((thought) => ({ ...thought, at: thought.at - from.at, calls: thought.calls - from.calls }))
  }
}

/** The turn as the chat reads it, in order; a turn you did not speak into is one leg. */
export function chatLegsOf(block: Foldable & Pick<TraceBlock, 'added'>): ChatLeg[] {
  const added = block.added ?? []
  if (added.length === 0) return [{ words: null, fold: chatFoldOf(block) }]
  const end: Place = { at: block.reply.length, calls: block.activity.length, thoughts: block.thoughts?.length ?? 0 }
  const starts: Place[] = [{ at: 0, calls: 0, thoughts: 0 }, ...added]
  return starts.map((from, i) => ({
    words: i === 0 ? null : added[i - 1].text,
    fold: chatFoldOf(stretchOf(block, from, added[i] ?? end))
  }))
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
