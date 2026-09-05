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
 * THE SOCKET, not a header. `X-Forwarded-For` is set by whoever is talking to
 * us, so trusting it unconditionally meant a caller could mint a fresh
 * limiter key per request by changing one string — the limiter was decoration.
 * Nothing else in this registry derives a client address from a header, and
 * this now matches: the peer's own address, or nothing.
 *
 * A deployment that really is behind an ingress may name it in
 * `trustedProxies`; only then is the forwarded chain read, and only its LAST
 * entry — the one the trusted hop wrote — rather than the first, which is
 * whatever the client sent.
 */
export function callerAddress(
  headers: Record<string, string | string[] | undefined>,
  socket: string | undefined,
  trustedProxies: readonly string[] = []
): string {
  const peer = normalise(socket)
  if (peer !== 'unknown' && trustedProxies.some((proxy) => normalise(proxy) === peer)) {
    const forwarded = headers['x-forwarded-for']
    const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',')
    const written = normalise(chain[chain.length - 1]?.trim())
    if (written !== 'unknown') return written
  }
  return peer
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are one address; two keys would be two limits. */
function normalise(address: string | undefined): string {
  const value = (address ?? '').trim()
  if (value === '') return 'unknown'
  return value.startsWith('::ffff:') ? value.slice(7) : value
}
