import type { TurnPhase } from '../../shared/turn'

// A WIDEN DURING A TURN IS REDRAWN WHEN THE TURN ENDS (owner, 2026-10-31:
// the desktop LIVE view kept phone-width rows three abreast).
//
// A widen is followed by a dip one column narrower (main/pty.ts ·
// PtySession.resize), which makes an idle Claude Code redraw its
// conversation. A working one does not redraw — measured: the joined rows
// stayed on its screen after the same widen — so a widen that lands mid-turn
// is remembered here and the repaint kick (another dip) runs once the turn is
// at rest.

const busy = (phase: TurnPhase): boolean => phase === 'thinking' || phase === 'waiting'

export interface TurnRedraw {
  /** The pane just got wider, while the agent was in this phase. */
  widened: (phase: TurnPhase) => void
  /**
   * The pane is now `cols` wide, in this phase: a widen when it is wider than
   * every width it had lately. The way back from a dip is not one (below).
   */
  sized: (cols: number, phase: TurnPhase, now: number) => void
  /** The pane is now `cols` wide, judged against nothing (an attach, a reconnect). */
  note: (cols: number, now: number) => void
  /** The phase is now this: true once, when a redraw is owed and the turn is at rest. */
  settled: (phase: TurnPhase) => boolean
}

/**
 * How long a width counts as the pane's own. A repaint kick dips one column
 * and comes back after 400 ms (TerminalOverlay KICK_DIP_MS; main's widen dip,
 * DIP_MS, the same), and its echo arrives later still: well inside this.
 *
 * THE WAY BACK FROM A DIP IS NO WIDEN (owner's recording, 2026-11-01: an idle
 * agent's desktop LIVE view repainted every 1-3 s). The dip makes Claude Code
 * redraw, the redraw reads as a busy turn, the way back was a widen during
 * it, and the owed kick at rest was the next dip: a kick that owed itself a
 * kick, for ever. Wider than the widest of the last moments is a widen.
 */
export const DIP_MEMORY_MS = 2000

interface Width {
  readonly cols: number
  readonly at: number
}

export function createTurnRedraw(): TurnRedraw {
  let owed = false
  /** Widths of the last moments, and always the latest, however old. */
  let seen: readonly Width[] = []
  const remember = (cols: number, now: number): void => {
    const recent = seen.filter((width) => now - width.at <= DIP_MEMORY_MS)
    seen = [...recent, { cols, at: now }]
  }
  const widened = (phase: TurnPhase): void => {
    if (busy(phase)) owed = true
  }
  return {
    widened,
    sized: (cols, phase, now) => {
      const latest = seen[seen.length - 1]
      const before = seen.filter((width) => width === latest || now - width.at <= DIP_MEMORY_MS)
      if (latest && cols > Math.max(...before.map((width) => width.cols))) widened(phase)
      remember(cols, now)
    },
    note: remember,
    settled: (phase) => {
      if (!owed || busy(phase)) return false
      owed = false
      return true
    }
  }
}
