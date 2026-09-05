/**
 * A FIXED-WINDOW LIMITER, in memory.
 *
 * The two unauthenticated write routes — claim a name, sign in — are the only
 * places on this registry where a stranger can spend a scrypt. Without a
 * ceiling, one client can hold every worker on the process busy stretching
 * passwords it already knows are wrong, which is a denial of service dressed
 * as a login form.
 *
 * In memory rather than on disk on purpose: a restart forgives everyone, and
 * that is the right trade for a bound whose whole job is to slow a burst down.
 */
export class Limiter {
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

/**
 * WHO IS ASKING, for the limiter only.
 *
 * The forwarded address when there is one — this runs behind a proxy in the
 * only deployment that matters — and the socket's otherwise. Never trusted for
 * anything but counting: a header a caller controls cannot be an identity.
 */
export function callerAddress(headers: Record<string, string | string[] | undefined>, socket: string | undefined): string {
  const forwarded = headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const address = (first ?? '').split(',')[0].trim()
  return address !== '' ? address : (socket ?? 'unknown')
}
