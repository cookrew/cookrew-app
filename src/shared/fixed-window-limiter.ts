/**
 * A FIXED-WINDOW LIMITER, in memory.
 *
 * The bound for a route where one client can make the machine do real work
 * per call — stretch a password, verify a signature, rewrite a 0600 file. A
 * ceiling turns "as fast as you can send them" into "as fast as a person
 * could mean them", which is all a bound of this kind is for.
 *
 * IN MEMORY RATHER THAN ON DISK, on purpose: a restart forgives everyone, and
 * that is the right trade for something whose whole job is to slow a burst.
 * Nothing here is a quota and nothing here is remembered about a person.
 *
 * WHY IT IS HERE AND NOT IMPORTED. registry/src/v2-limiter.ts is this class,
 * argued the same way, and the registry is a separate deployable — main must
 * not take a production dependency on it. src/shared is the seam both sides
 * already share (registry/src imports shared/relay-frame), so THIS is the
 * copy the registry's should later become; until someone moves its six call
 * sites, the duplication is deliberate and is written down rather than
 * discovered.
 */
export class FixedWindowLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly counts = new Map<string, { from: number; n: number }>()

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  /** True when this attempt is allowed; it is counted either way. */
  take(key: string): boolean {
    const at = this.now()
    const held = this.counts.get(key)
    if (held === undefined || at - held.from >= this.windowMs) {
      this.counts.set(key, { from: at, n: 1 })
      this.sweep(at)
      return true
    }
    // Counted past the limit as well: a client that keeps hammering keeps its
    // window open rather than earning a fresh one by waiting out one request.
    this.counts.set(key, { from: held.from, n: held.n + 1 })
    return held.n < this.limit
  }

  private sweep(at: number): void {
    if (this.counts.size < 4096) return
    for (const [key, entry] of this.counts) {
      if (at - entry.from >= this.windowMs) this.counts.delete(key)
    }
  }
}

/** The one thing a route needs from it, so a caller can inject a fake. */
export interface RateCeiling {
  take(key: string): boolean
}
