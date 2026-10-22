// PHASE HONESTY: the levels speak the board's verdict in the contract's words,
// and never claim more than the board knows.
//
//   working → thinking   waiting → waiting   unread → replied
//   done    → idle       offline → offline
//
// The source passes through unchanged: a probe stays a probe (the multiplexer
// calls a busy Claude idle), a ledger row stays last-known. Nothing here may
// upgrade one to 'live'.

import { ledgerPhase, livePhase, type BoardPhase, type BoardRow, type BoardSource } from '../../shared/board'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'
import type { AgentPhase, PhaseSource } from '../../shared/strata'

const PHASE_OF_BOARD: Readonly<Record<BoardPhase, AgentPhase>> = {
  working: 'thinking',
  waiting: 'waiting',
  unread: 'replied',
  done: 'idle',
  offline: 'offline'
}

export function agentPhaseOf(phase: BoardPhase): AgentPhase {
  return PHASE_OF_BOARD[phase]
}

/** Identity on purpose: the board's three sources ARE the contract's three. */
export function phaseSourceOf(source: BoardSource): PhaseSource {
  return source
}

export interface AgentPhaseVerdict {
  phase: AgentPhase
  source: PhaseSource
}

/** A board row's verdict, exactly. */
export function verdictOfRow(row: Pick<BoardRow, 'phase' | 'source'>): AgentPhaseVerdict {
  return { phase: agentPhaseOf(row.phase), source: phaseSourceOf(row.source) }
}

/**
 * One terminal's verdict with the board's own precedence (board.ts · mergeBoard
 * rule 1): L1 live beats L2 probe beats L3 ledger. Every agent gets one — the
 * board drops a terminal with no history, a level cannot drop a seated agent.
 */
export function phaseVerdict(
  activity: TerminalActivity | undefined,
  probe: BoardPhase | undefined,
  history: readonly TurnRecord[] | undefined
): AgentPhaseVerdict {
  if (activity) return { phase: agentPhaseOf(livePhase(activity)), source: 'live' }
  if (probe) return { phase: agentPhaseOf(probe), source: 'probe' }
  const last = history && history.length > 0 ? history[history.length - 1] : undefined
  return { phase: agentPhaseOf(ledgerPhase(last)), source: 'ledger' }
}

/**
 * When the phase began, as far as this verdict can say. Live: the turn's start
 * while thinking/waiting, else the last turn's end. Ledger: the last turn's
 * end. Probe: unknown from the verdict alone — the builder carries the moment
 * it first saw the phase instead (see build.ts · phaseSince).
 */
export function phaseSinceOf(
  verdict: AgentPhaseVerdict,
  activity: TerminalActivity | undefined,
  history: readonly TurnRecord[] | undefined
): number | null {
  const last = history && history.length > 0 ? history[history.length - 1] : undefined
  // Never `updatedAt`: it moves on every activity push, and a since that moves
  // is a delta per tick that says nothing.
  if (verdict.source === 'live' && activity) {
    if (verdict.phase === 'thinking' || verdict.phase === 'waiting') return activity.turnStartedAt ?? null
    return last?.endedAt ?? null
  }
  if (verdict.source === 'ledger') return last?.endedAt ?? null
  return null
}
