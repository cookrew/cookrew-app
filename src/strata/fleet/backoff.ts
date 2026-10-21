// Reconnect delays: exponential with "equal jitter" — half the step is fixed,
// half is random — so eight desktops that dropped together (a relay restart)
// do not all dial back on the same tick, and none dials back at zero.

export interface BackoffPolicy {
  baseMs: number
  capMs: number
}

export const LINK_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 30_000 }
/** A desktop that answered but cannot serve levels changes only when it updates. */
export const OUTDATED_RECHECK_MS = 10 * 60_000

/** attempt 0 is the first retry. `random` is [0, 1). */
export const backoffDelay = (attempt: number, random: number, policy: BackoffPolicy = LINK_BACKOFF): number => {
  const step = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, Math.min(attempt, 30)))
  return Math.round(step / 2 + (step / 2) * random)
}
