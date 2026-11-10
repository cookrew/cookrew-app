/**
 * HOW MUCH OF THE MAC'S ANSWERS MAY BE OUT ON THE RELAY LINE AT ONCE.
 *
 * Measured 2026-11-10 on the owner's Mac: it reaches cookrew.dev through
 * Clash's TUN and a proxy, at an effective 35-40 KB/s, and every byte written
 * left the process at once and queued out there. One 336 KB answer took 114 s
 * behind 4.5 MB of others; p99 was 33 s. Whatever is out on that line is
 * first-in-first-out and cannot be taken back, so the only place a small answer
 * can still go first is a queue the Mac holds itself (relay-uplink.ts), and
 * the only question is how little to put out there without wasting the line.
 *
 * The answer comes from the relay's receipts (`got`, relay-frame.ts): each one
 * reveals how long the newest confirmed byte took to arrive. The smallest such
 * delay seen lately is the line's own round trip; anything above it is queue.
 * The window moves by what was confirmed, scaled by how far the queue is from
 * TARGET_MS: up below it, down above it, still at it. Proportional both ways,
 * because the delay is noisy (receipts are coalesced, a frame takes time to
 * cross) and a fixed cut on every sample over the target starved the line by
 * a seventh in testing. Only a queue far over target (twice it: a proxy that
 * changed route, or a burst that went out before receipts were known) is
 * halved, at most once per round trip. The window grows only while there was
 * more to send than it allowed, so a quiet line does not talk itself into a
 * window it never proved.
 *
 * The same idea as LEDBAT (RFC 6817), sized for one long stream: a delay
 * target, a base delay from recent minimums, and nothing that needs the
 * relay to do more than count.
 */

/** The window never closes below this: a pong and a keystroke always fit. */
export const PACE_MIN = 16 * 1024
/**
 * Before any receipt has said what the line can do: about TCP's own first
 * window. Feedback on a slow line arrives only after the queue it measures, so
 * a large start is a second or more of answers out of reach; a small one costs
 * a fast line a few round trips, once per line.
 */
export const PACE_START = 16 * 1024
/**
 * Never more out at once than this: a megabyte a second on a 2 s round trip,
 * and short enough that a pong behind a full window still crosses a 40 KB/s
 * line inside the relay's 75 s pulse deadline should the route slow at once.
 */
export const PACE_MAX = 2 * 1024 * 1024
/** Queue out on the line that is tolerated before the window shrinks. */
export const PACE_TARGET_MS = 250
/**
 * Base delay is the minimum over this many buckets of this length: a minute.
 * Long enough that a line held at its floor (where every byte waits behind a
 * frame) does not mistake that wait for its own round trip; short enough that
 * a proxy switching routes is believed within a minute.
 */
export const PACE_BUCKET_MS = 10_000
export const PACE_BUCKETS = 6
/** A queue this many times the target is drained by halving, not by steps. */
export const PACE_FAR = 2
/** What a halving keeps. */
export const PACE_CUT = 0.5

export interface PaceSample {
  /** Bytes newly confirmed. */
  readonly acked: number
  /** Write-to-receipt delay of the newest write this receipt reached, or null (the last one still stands). */
  readonly rttMs: number | null
  /** Was there more waiting to go than the window let out? */
  readonly limited: boolean
}

export interface RelayPace {
  readonly window: () => number
  readonly sample: (sample: PaceSample) => void
  /** A new line: what was learned about the old one may not hold. */
  readonly reset: () => void
}

export interface RelayPaceOptions {
  readonly now?: () => number
  readonly min?: number
  readonly start?: number
  readonly max?: number
  readonly targetMs?: number
}

interface Bucket {
  readonly at: number
  readonly min: number
}

export const createRelayPace = (options: RelayPaceOptions = {}): RelayPace => {
  const now = options.now ?? Date.now
  const min = options.min ?? PACE_MIN
  const start = options.start ?? PACE_START
  const max = options.max ?? PACE_MAX
  const target = options.targetMs ?? PACE_TARGET_MS

  let window = start
  let buckets: readonly Bucket[] = []
  let lastCut = Number.NEGATIVE_INFINITY
  /** The queue as last measured, for receipts that measured nothing new. */
  let lastQueued: number | null = null

  const remember = (at: number, rttMs: number): number => {
    // By age, not count: after a quiet spell the old minimums say nothing about the route now.
    const fresh = buckets.filter((bucket) => at - bucket.at < PACE_BUCKET_MS * PACE_BUCKETS)
    const current = fresh[fresh.length - 1]
    buckets =
      current === undefined || at - current.at >= PACE_BUCKET_MS
        ? [...fresh.slice(-(PACE_BUCKETS - 1)), { at, min: rttMs }]
        : [...fresh.slice(0, -1), { at: current.at, min: Math.min(current.min, rttMs) }]
    return Math.min(...buckets.map((bucket) => bucket.min))
  }

  return {
    window: () => window,
    sample: ({ acked, rttMs, limited }) => {
      const at = now()
      // Every confirmed byte moves the window; only some receipts carry a new
      // delay, and the others are judged by the last one.
      if (rttMs !== null) lastQueued = rttMs - remember(at, rttMs)
      if (lastQueued === null) return
      const queued = lastQueued
      const base = Math.min(...buckets.map((bucket) => bucket.min))
      if (rttMs !== null && queued > target * PACE_FAR) {
        // Once per round trip: the receipts that follow a cut still carry the
        // queue from before it, and cutting on each would close the window.
        if (at - lastCut >= base + target) {
          window = Math.max(min, Math.floor(window * PACE_CUT))
          lastCut = at
        }
        return
      }
      // 1 with no queue, 0 at the target, down to -1 at twice it.
      const off = (target - queued) / target
      if (off > 0 && !limited) return
      window = Math.min(max, Math.max(min, Math.round(window + acked * off)))
    },
    reset: () => {
      window = start
      buckets = []
      lastCut = Number.NEGATIVE_INFINITY
      lastQueued = null
    }
  }
}
