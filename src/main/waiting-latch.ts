import type { TurnPhase } from '../shared/turn'

/**
 * "AN AGENT WAITS ON YOU" IS SAID ONCE PER WAIT (plan
 * docs/hitl-cross-workspace-2026-11-15 · agent.waiting). A tracked terminal
 * counts the waits it enters (TerminalActivity.waitSeq): a second approval in
 * the same turn is a new count and is said again; repeated pushes of one wait,
 * or a menu redraw, keep the count and are not. An activity with no count (a
 * mirrorless card, herdr's word only) latches until a reply, a rest or the
 * end of the turn, the safe side of a flapping detector.
 */
export function createWaitingLatch(): {
  /** True when this activity starts a wait worth saying. */
  observe: (terminalId: string, phase: TurnPhase, waitSeq?: number) => boolean
  /** The turn finished, or the terminal left: the next wait is a new one. */
  clear: (terminalId: string) => void
} {
  /** terminal → the wait last said: its count, or 'latched' for one with no count. */
  let said: ReadonlyMap<string, number | 'latched'> = new Map()
  const without = (id: string): ReadonlyMap<string, number | 'latched'> => new Map([...said].filter(([one]) => one !== id))
  return {
    observe(terminalId, phase, waitSeq) {
      if (phase === 'replied' || phase === 'idle') {
        if (said.get(terminalId) === 'latched') said = without(terminalId)
        return false
      }
      if (phase !== 'waiting') return false
      const mark = typeof waitSeq === 'number' ? waitSeq : 'latched'
      if (said.get(terminalId) === mark) return false
      said = new Map([...said, [terminalId, mark]])
      return true
    },
    clear(terminalId) {
      if (said.has(terminalId)) said = without(terminalId)
    }
  }
}
