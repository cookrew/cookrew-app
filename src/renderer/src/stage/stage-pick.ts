// WHAT THE STAGE SHOWS: the one card that most needs a person, full screen.
//
// The stage has no canvas to pan and no zoom. Its background is a single
// card, chosen here, and every agent is a small avatar at the right edge.
//
//   pinned  — the agent you picked or touched; it stays until you go Back
//   choose  — the newest agent waiting on a decision (a permission, a pick)
//   review  — the newest agent that finished a turn: read it, prompt again
//   popped  — a browser or note that just appeared on an agent: that agent,
//             with the item open in the lower half
//   latest  — nothing asks for you: the agent that moved last
//
// Choose comes first whatever its age: an agent waiting on you is stopped
// until you answer. Review and popped are one queue, newest first.
import type { AgentRow } from '../agent-rows'

export type StageItemKind = 'browser' | 'note'

export interface StageItem {
  id: string
  kind: StageItemKind
}

export interface StagePin {
  terminalId: string
  item: StageItem | null
}

export type StageWhy = 'pinned' | 'choose' | 'review' | 'popped' | 'latest'

export interface StageTarget {
  terminalId: string
  item: StageItem | null
  why: StageWhy
}

/** A browser or note that appeared while this window was open. */
export interface PoppedItem extends StageItem {
  /** The agent it is wired to; null when it is wired to none. */
  terminalId: string | null
  at: number
}

const newest = <T>(items: readonly T[], at: (item: T) => number): T | null =>
  items.reduce<T | null>((best, item) => (best === null || at(item) > at(best) ? item : best), null)

export function pickBackground(rows: readonly AgentRow[], popped: readonly PoppedItem[], pin: StagePin | null): StageTarget | null {
  const present = new Set(rows.map((r) => r.id))
  if (pin !== null && present.has(pin.terminalId)) return { ...pin, why: 'pinned' }
  const waiting = newest(
    rows.filter((r) => r.phase === 'waiting'),
    (r) => r.lastActivityAt
  )
  if (waiting !== null) return { terminalId: waiting.id, item: null, why: 'choose' }
  const done = newest(
    rows.filter((r) => r.phase === 'done'),
    (r) => r.lastActivityAt
  )
  const pop = newest(
    popped.filter((p) => p.terminalId !== null && present.has(p.terminalId)),
    (p) => p.at
  )
  if (pop !== null && (done === null || pop.at >= done.lastActivityAt)) {
    return { terminalId: pop.terminalId as string, item: { id: pop.id, kind: pop.kind }, why: 'popped' }
  }
  if (done !== null) return { terminalId: done.id, item: null, why: 'review' }
  const last = newest(rows, (r) => r.lastActivityAt)
  return last === null ? null : { terminalId: last.id, item: null, why: 'latest' }
}

const PHASE_RANK: Record<AgentRow['phase'], number> = { waiting: 0, failed: 0, working: 1, done: 2, quiet: 3, offline: 4 }

/** The avatars, top to bottom: who needs you, who is working, who finished; newest first within each. */
export function railOrder(rows: readonly AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || b.lastActivityAt - a.lastActivityAt)
}

/**
 * The browsers and notes that appeared since the last look. The first look at
 * a workspace only learns what is there: a card that was already open when the
 * window arrived did not "pop up".
 */
export function diffPopped(
  known: ReadonlySet<string> | null,
  items: readonly StageItem[],
  ownerOf: (itemId: string) => string | null,
  at: number
): { known: ReadonlySet<string>; popped: PoppedItem[] } {
  const next = new Set(items.map((i) => i.id))
  if (known === null) return { known: next, popped: [] }
  const popped = items.filter((i) => !known.has(i.id)).map((i) => ({ ...i, terminalId: ownerOf(i.id), at }))
  return { known: next, popped }
}
