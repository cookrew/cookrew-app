/**
 * Whether a terminal is doing work right now — the liveness question.
 *
 * Its own module because it has been got wrong twice, in opposite directions,
 * and because the test that was supposed to catch the second one hand-copied
 * the logic instead of importing it. A predicate that lives in one place and
 * is imported by both the wiring and its test cannot drift from either.
 *
 * WRONG ONCE — too narrow. The drain first asked terminalIsWorking, which is
 * the CLIPBOARD's predicate: UNCOPYABLE_PHASES is exactly {'thinking'},
 * because that is when the session file is being appended to and a copy would
 * tear. But 'waiting' means the turn is not finished, so a workspace could be
 * drained out from under an agent mid-turn.
 *
 * WRONG TWICE — too broad. `phase !== 'idle'` swept in 'replied', which means
 * TURN COMPLETE BUT UNREAD and demotes to idle only when someone VIEWS the
 * result (turn-tracker.ts seen(): "never a TTL — unread results must not
 * silently expire"). Viewing takes focus, and a background session is by
 * definition not focused, so a finished-but-unread turn would hold residency
 * forever. That is worse than draining too early: it never falls to zero,
 * which is the leaked-flag failure mode ef5e13c was reverted for, reached
 * through a predicate instead of a flag.
 *
 * RIGHT — work the agent is part-way through, plus commissioned work that has
 * not started. Draining a 'replied' session costs nothing: the read marker is
 * persisted, the tmux session is detached and not killed, and the result is
 * still there when someone comes back for it.
 */

import type { TurnPhase } from '../shared/turn'

/**
 * Phases in which the agent is mid-work. Deliberately NOT UNCOPYABLE_PHASES —
 * that answers "would copying this tear the session file?", which is a
 * narrower question with a different owner. The two are pinned apart by test.
 */
const WORKING_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>(['thinking', 'waiting'])

export interface LivenessFacts {
  /** Current turn phase, or undefined for an untracked terminal. */
  phase: TurnPhase | undefined
  /**
   * A dispatch record is open for this terminal. Counts with no phase at all:
   * a record is reserved BEFORE its prompt is submitted, so a workspace can
   * hold commissioned work whose agent has not started a turn yet.
   */
  hasOpenDispatch: boolean
}

export function terminalHasLiveWork(facts: LivenessFacts): boolean {
  if (facts.hasOpenDispatch) return true
  return facts.phase !== undefined && WORKING_PHASES.has(facts.phase)
}

/** Exposed so a test can pin it against UNCOPYABLE_PHASES rather than restate it. */
export const LIVE_WORK_PHASES = WORKING_PHASES
