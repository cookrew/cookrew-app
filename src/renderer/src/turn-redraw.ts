import type { TurnPhase } from '../../shared/turn'

// A WIDEN DURING A TURN IS REDRAWN WHEN THE TURN ENDS (owner, 2026-10-31:
// the desktop LIVE view kept phone-width rows three abreast).
//
// A widen ends on a one-column narrowing (main/pty.ts · PtySession.resize),
// which makes an idle Claude Code redraw its conversation at the new width.
// A working one does not redraw — measured: the joined rows stayed on its
// screen after the same widen — so a widen that lands mid-turn is remembered
// here and the repaint kick runs once the turn is at rest.

const busy = (phase: TurnPhase): boolean => phase === 'thinking' || phase === 'waiting'

export interface TurnRedraw {
  /** The pane just got wider, while the agent was in this phase. */
  widened: (phase: TurnPhase) => void
  /** The phase is now this: true once, when a redraw is owed and the turn is at rest. */
  settled: (phase: TurnPhase) => boolean
}

export function createTurnRedraw(): TurnRedraw {
  let owed = false
  return {
    widened: (phase) => {
      if (busy(phase)) owed = true
    },
    settled: (phase) => {
      if (!owed || busy(phase)) return false
      owed = false
      return true
    }
  }
}
