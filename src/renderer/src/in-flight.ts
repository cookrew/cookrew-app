/**
 * ONE AT A TIME OVER A SCARCE LINE. Every request through the relay holds one
 * of a desktop's sixteen exchanges until it is answered, so anything that fires
 * on a clock or on a tap adds up while the Mac is stalled: nobody is answering,
 * and each new request takes another slot. Both helpers take a deadline, because
 * a fetch on a dead direct plane can hang for minutes and must not silence the
 * thing behind it for that long.
 */

/** The relay's deadline for a first answer: past it, a request is over anyway. */
export const RELAY_ANSWER_MS = 30_000

/**
 * A periodic task that skips its turn while the last run is unanswered, for at
 * most `holdMs`. A failure counts as an answer.
 */
export function skipWhileOut(task: () => Promise<unknown>, holdMs: number, now: () => number = Date.now): () => void {
  let heldUntil = 0
  return () => {
    const at = now()
    if (at < heldUntil) return
    const mine = at + holdMs
    heldUntil = mine
    const release = (): void => {
      if (heldUntil === mine) heldUntil = 0
    }
    void task().then(release, release)
  }
}

/**
 * A request that a second caller joins while the same key is unanswered, for at
 * most `holdMs`. Everyone gets the one answer; once it settles, the next call
 * asks afresh.
 */
export function joinInFlight<K, T>(run: (key: K) => Promise<T>, holdMs: number): (key: K) => Promise<T> {
  const pending = new Map<K, Promise<T>>()
  return (key) => {
    const joined = pending.get(key)
    if (joined) return joined
    const forget = (): void => {
      clearTimeout(deadline)
      if (pending.get(key) === own) pending.delete(key)
    }
    const own = run(key).finally(forget)
    const deadline = setTimeout(forget, holdMs)
    pending.set(key, own)
    return own
  }
}
