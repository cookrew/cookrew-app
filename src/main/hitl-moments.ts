import type { TurnPhase } from '../shared/turn'

/**
 * WHEN AN AGENT'S REPLY IS NEWS, READ OFF ITS PHASES (plan
 * docs/hitl-cross-workspace-2026-11-15 · phase 3). The tracker's activity is
 * the one stream every agent passes through, mirrored or not: a mirrorless
 * agent's closed turn is announced as `replied` too (turn-tracker.ts ·
 * restingPhase). So a reply is the moment a phase goes from working or
 * waiting to `replied`, unread; the log's `turn.completed` is not used here,
 * because only a mirrored agent writes one.
 *
 * A turn another agent asked for (a dispatch: the activity names it, or the
 * tracker holds it armed at any point of the turn) is that agent's answer, not
 * the owner's news. Settled is the end of what was said: a wait answered (the
 * phase left `waiting`) or a reply read (`replied` to `idle`), wherever it was
 * answered or read. The first sight of an agent is never a moment: a boot, a
 * reconnect or a new workspace says nothing.
 */
export type Moment = 'reply' | 'settled'

interface Seen {
  readonly phase: TurnPhase
  /** The turn in hand was asked for by a dispatch. */
  readonly dispatched: boolean
}

const WORKING: ReadonlySet<TurnPhase> = new Set(['thinking', 'waiting'])

export function createMomentTracker(): {
  observe: (terminalId: string, phase: TurnPhase, dispatched: boolean) => Moment | null
  forget: (terminalId: string) => void
} {
  let seen: ReadonlyMap<string, Seen> = new Map()
  const keep = (id: string, next: Seen): void => {
    seen = new Map([...seen, [id, next]])
  }
  return {
    observe(terminalId, phase, dispatched) {
      const before = seen.get(terminalId)
      const asked = WORKING.has(phase) ? (before?.dispatched ?? false) || dispatched : false
      keep(terminalId, { phase, dispatched: asked })
      if (!before || before.phase === phase) return null
      if (phase === 'replied' && WORKING.has(before.phase)) return before.dispatched || dispatched ? null : 'reply'
      if (before.phase === 'waiting' || (before.phase === 'replied' && phase === 'idle')) return 'settled'
      return null
    },
    forget(terminalId) {
      if (seen.has(terminalId)) seen = new Map([...seen].filter(([id]) => id !== terminalId))
    }
  }
}
