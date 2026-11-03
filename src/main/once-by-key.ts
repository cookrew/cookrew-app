/**
 * A KEYSTROKE BATCH IS WRITTEN ONCE, HOWEVER OFTEN IT ARRIVES.
 *
 * The phone sends its typing one batch at a time (renderer
 * raw-input-queue.ts) and, since 2026-10-24, sends a batch AGAIN when the
 * first try got no answer: the plane it went on died, the WebRTC link closed
 * under it, a deadline passed. No answer is not the same as not delivered —
 * the Mac may have typed it and the answer been lost on the way back — so a
 * repeat must not type it twice. Each batch carries an id; the first arrival
 * runs, and every later one (or one that lands while the first is still
 * running) gets the first one's verdict.
 *
 * Bounded by count, oldest first: a retry comes within seconds, and a
 * thousand batches is minutes of typing.
 */

export const ONCE_KEYS_KEPT = 1024

/** What a batch id may look like: short, and plain enough to sit in a map key. */
export const BATCH_ID = /^[A-Za-z0-9._-]{1,80}$/

export const createOnceByKey = <T>(kept: number = ONCE_KEYS_KEPT) => {
  const seen = new Map<string, Promise<T>>()
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const known = seen.get(key)
    if (known) return known
    const result = run()
    seen.set(key, result)
    if (seen.size > kept) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return result
  }
}
