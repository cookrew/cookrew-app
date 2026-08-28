/**
 * Bring a card back when its herdr attach client drops.
 *
 * `herdr agent attach` is a long-lived client streaming one pane into a PTY.
 * When several clients contend for the server's socket, macOS returns EAGAIN
 * and the client treats it as fatal — it prints
 *
 *     herdr: lost connection to server: Resource temporarily unavailable (os error 35)
 *
 * and exits. The SERVER is fine and THE PANE IS FINE; only our view of it died.
 * But PtyManager's exit handler simply drops the session from its map, so the
 * card is left showing that sentence forever and the agent behind it becomes
 * unreachable until someone restarts or recovers the terminal by hand.
 *
 * runWithHerdrRetry (herdr-retry.ts) does not help here. It wraps the CLI calls
 * Cookrew makes itself; this is a child process printing to a terminal, and
 * nothing was waiting on its exit code.
 *
 * So: reattach. Bounded, because a genuinely dead server must not become a
 * respawn loop — a pane that cannot be reattached three times in a minute is
 * not transient, and the card should be allowed to stay dead and say so.
 */

/** Text a dropped-but-recoverable attach leaves on screen. */
const TRANSIENT_DISCONNECT =
  /lost connection to server|os error 35|resource temporarily unavailable|\beagain\b/i

/**
 * Exits that mean "the pane is gone", never worth reattaching. `agent attach`
 * prints this when the registry cannot resolve its target, and retrying just
 * reprints it — the repair for that is ensureAgentResolvable, not a respawn.
 */
const GONE = /agent_not_found|no such pane|server_not_running/i

export const MAX_REATTACHES = 3
export const REATTACH_WINDOW_MS = 60_000
/** Backoff per attempt. Widening, so a flapping server is not hammered. */
export const REATTACH_BACKOFF_MS = [250, 1000, 2500]

export interface AttachExit {
  exitCode: number
  /** The pane's visible text at the moment it exited. */
  tail: string
}

/** Reattach bookkeeping for ONE terminal. Caller owns and persists it. */
export interface ReattachState {
  attempts: number
  /** When the current window opened. */
  since: number
}

export type ReattachDecision =
  | { reattach: true; delayMs: number; attempt: number; state: ReattachState }
  | { reattach: false; reason: 'clean-exit' | 'not-transient' | 'pane-gone' | 'budget-spent' }

export const freshReattachState = (): ReattachState => ({ attempts: 0, since: 0 })

/**
 * Should this exit be followed by a reattach, and after how long?
 *
 * Pure, and takes `now` so the window is testable without a clock.
 */
export function decideReattach(
  exit: AttachExit,
  state: ReattachState,
  now: number
): ReattachDecision {
  // A clean exit is the user closing the card or the agent ending. Never fight
  // a deliberate exit — that would resurrect terminals people just closed.
  if (exit.exitCode === 0) return { reattach: false, reason: 'clean-exit' }
  if (GONE.test(exit.tail)) return { reattach: false, reason: 'pane-gone' }
  if (!TRANSIENT_DISCONNECT.test(exit.tail)) return { reattach: false, reason: 'not-transient' }

  // A window that has gone quiet starts over, so an app up for days does not
  // accumulate its way to a permanent refusal.
  const expired = state.since === 0 || now - state.since > REATTACH_WINDOW_MS
  const attempts = expired ? 0 : state.attempts
  if (attempts >= MAX_REATTACHES) return { reattach: false, reason: 'budget-spent' }

  return {
    reattach: true,
    attempt: attempts + 1,
    delayMs: REATTACH_BACKOFF_MS[Math.min(attempts, REATTACH_BACKOFF_MS.length - 1)],
    state: { attempts: attempts + 1, since: expired ? now : state.since }
  }
}
