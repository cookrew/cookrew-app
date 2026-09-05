import type { IncomingMessage } from 'node:http'

/**
 * ATTEMPT LIMITS for the one route that takes no token.
 *
 * `POST /v1/accounts/@h/link` cannot ask for a credential — the device
 * redeeming a code holds no key the account knows yet, which is the whole
 * reason the code exists. That makes it the only unauthenticated write on the
 * account surface, and an unlimited guessing loop against a six-character
 * secret is exactly what an unauthenticated write must not be.
 *
 * TWO WINDOWS, because one is always the wrong one. A short window (a minute)
 * stops the burst that would grind a code inside its two-minute life; a long
 * one (the code's lifetime) stops the patient version that stays just under the
 * short limit and still gets hundreds of tries.
 *
 * WHAT THE KEY IS, HONESTLY. The client is the socket's remote address and
 * nothing else: no part of this registry trusts `X-Forwarded-For`, and starting
 * here would let any caller pick its own bucket by sending a header. Behind a
 * reverse proxy that means every caller shares one address, so this limiter
 * degrades to a per-handle limit — which is why it is the SECOND line and the
 * per-code wrong-guess counter in `LinkCodes` is the first. That one is
 * unspoofable because it counts guesses against the secret rather than against
 * whoever made them.
 */

export interface RateLimitConfig {
  /** Attempts allowed in `shortMs`. */
  burst: number
  shortMs: number
  /** Attempts allowed in `longMs` — the lifetime of the thing being guessed. */
  cap: number
  longMs: number
}

export const LINK_LIMIT: RateLimitConfig = {
  burst: 10,
  shortMs: 60 * 1000,
  cap: 20,
  longMs: 2 * 60 * 1000
}

/** Buckets are dropped as they age out; this only bounds a burst of new keys. */
const MAX_KEYS = 4096

export interface RateVerdict {
  ok: boolean
  /** Seconds until the caller could succeed, for `retry-after`. */
  retryAfter: number
}

export class RateLimiter {
  private readonly attempts = new Map<string, number[]>()

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Record an attempt and say whether it may proceed. A REFUSED attempt is
   * still recorded: otherwise the limit is a speed bump that resets itself
   * every time it fires.
   */
  take(key: string): RateVerdict {
    const at = this.now()
    this.sweep(at)
    const kept = (this.attempts.get(key) ?? []).filter((t) => t > at - this.config.longMs)
    const next = [...kept, at]
    this.attempts.set(key, next)
    if (this.attempts.size > MAX_KEYS) this.attempts.delete(this.attempts.keys().next().value ?? '')
    const recent = next.filter((t) => t > at - this.config.shortMs)
    if (recent.length > this.config.burst) {
      return { ok: false, retryAfter: seconds(recent[0] + this.config.shortMs - at) }
    }
    if (next.length > this.config.cap) {
      return { ok: false, retryAfter: seconds(next[0] + this.config.longMs - at) }
    }
    return { ok: true, retryAfter: 0 }
  }

  private sweep(at: number): void {
    for (const [key, times] of this.attempts) {
      const kept = times.filter((t) => t > at - this.config.longMs)
      if (kept.length === 0) this.attempts.delete(key)
      else if (kept.length !== times.length) this.attempts.set(key, kept)
    }
  }
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000))

/**
 * The caller's address, from the socket and only the socket. IPv4-mapped IPv6
 * is normalised so `::ffff:10.0.0.1` and `10.0.0.1` are one bucket rather than
 * two, which would otherwise double every limit for free.
 */
export function clientAddress(request: IncomingMessage): string {
  const raw = request.socket.remoteAddress ?? 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}
