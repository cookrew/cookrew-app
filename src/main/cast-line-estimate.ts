/**
 * WHAT THE LINE TO ONE PHONE CAN CARRY, from the phone's acknowledgements (cast-video-out.ts paces by it).
 *
 * Owner 2026-11-25, "帧率也很低": on a sealed relay the phone drew 0-2 fps with the window pinned at its 16 KB
 * floor while one frame was 15-45 KB. A smoothed throughput read a window-limited line (one window per round
 * trip) as a slow one, and after a pause it divided a chunk by the whole pause. A first fix read the fastest
 * per-acknowledgement sample instead, and a review showed acknowledgements that arrive bunched (the phone
 * sends the newest only, one POST per 120 ms, with jitter on the way up) read as a line several times faster,
 * which flooded it.
 *
 * So this is BBR's delivery-rate estimate (Cardwell et al., "BBR: Congestion-Based Congestion Control"):
 *
 *   SPEED   bytes delivered between a chunk's sending and its acknowledgement, over the LONGER of the time
 *           they took to send and the time their acknowledgements took: a bunch of acknowledgements cannot
 *           read faster than the bytes were sent. A sample taken while the sender did not fill the line
 *           (app-limited: the page sent less than the window allowed) only ever raises the estimate. The
 *           line's speed is the fastest sample of the last RATE_MEMORY_MS; with none that recent, the last
 *           one is kept: a page at rest teaches nothing about the line.
 *   ROUND   the line's own round trip, from chunks sent with nothing else unacknowledged (no queue of this
 *   TRIP    sender's making can be in it), their own crossing included; the fastest of RTT_MEMORY_MS,
 *           kept while none come (a page scrolled without pause sends none). Before the first, the
 *           fastest acknowledgement of all stands in.
 *   GAP     acknowledgements come in bunches, not per chunk: the line must stay busy while the next one is
 *           on its way, so the budget adds the typical gap between them.
 *   START   until the line is known full, the budget is doubled (BBR's startup): on a 2 s line a round is
 *           ~4 s, and a window grown only by what the last round showed took half a minute to reach the
 *           line. Full is three rounds in a row that raised the speed by less than a quarter, counting
 *           only rounds the window was the limit in at least once (a caret blinking says nothing of the
 *           line; counted, it ended startup at the caret's speed, review 2026-11-25). Startup also ends
 *           when even the fastest acknowledgement of a filled round shows a queue (HyStart's delay test):
 *           on a 2 s line three flat rounds are 12 s of doubled budget, a 1.4 s queue; then one
 *           round at DRAIN_GAIN lets the queue startup left behind go, as BBR's drain does.
 *   PROBE   a page that never pauses sends nothing alone; after ten round trips without (10-25 s), the sender waits for
 *           the line to empty and sends one (cast-video-out.ts), as BBR's ProbeRTT does.
 *   NEW     a chunk sent alone whose round trip is several times the line's known one: the phone is on
 *   LINE    another network. What was known goes, and startup begins again (as a key frame asked for does,
 *           cast-video-out.ts keyAsked). Kept, a fast line's speed outlived a quiet spell on a slow one
 *           and the next scroll poured a full window onto it.
 */

/**
 * Rate samples are remembered for RATE_MEMORY_RTTS of the line's round trips, within these bounds: a line
 * that got slower is learned within a few rounds (BBR keeps ten), not after a fixed ten seconds of flooding it.
 */
export const RATE_MEMORY_MS = 10_000
export const RATE_MEMORY_MIN_MS = 3_000
const RATE_MEMORY_RTTS = 6
/** Round trips with nothing ahead are remembered this long: the line's own, not a queue's. */
export const RTT_MEMORY_MS = 30_000
/**
 * A chunk is sent alone every PROBE_EVERY_RTTS round trips, within these bounds (below RTT_MEMORY_MS, so a
 * reading is always fresh): waiting for the line to empty costs about a round trip of pictures, which on a
 * 2 s line every 10 s was a fifth of them.
 */
export const PROBE_EVERY_MS = 10_000
export const PROBE_EVERY_MAX_MS = 25_000
const PROBE_EVERY_RTTS = 10
/** A sample over less time than this is noise. */
const MIN_INTERVAL_MS = 20
/** The budget's multiplier until the line is known full, and the growth a round must show to keep looking. */
export const STARTUP_GAIN = 2
export const DRAIN_GAIN = 0.5
const FULL_GROWTH = 1.25
const FULL_ROUNDS = 3
/** A filled round whose fastest acknowledgement took longer than this share of the round trip, plus the gap, has a queue. */
const QUEUE_RTT_SHARE = 1.25
/** A lone chunk's round trip past both of these, against the line's known one, is another line. */
const NEW_LINE_TIMES = 3
const NEW_LINE_EXTRA_MS = 1000

/** What a chunk carries from its sending to its acknowledgement. */
export interface SentChunk {
  readonly at: number
  readonly bytes: number
  /** Bytes acknowledged, all told, when it went, and when the newest of those was. */
  readonly delivered: number
  readonly deliveredAt: number
  /** When the oldest chunk still counted in this sample went. */
  readonly firstSentAt: number
  /** Sent with room for it and another under both the window and the chunk cap: its sample is a floor, not the line. */
  readonly appLimited: boolean
  /** Sent with nothing else unacknowledged: its round trip has no queue of this sender's in it. */
  readonly alone: boolean
}

interface Sample {
  readonly at: number
  readonly value: number
}

const recent = (list: readonly Sample[], now: number, memoryMs: number): Sample[] => list.filter((s) => now - s.at < memoryMs)

export class LineEstimate {
  private delivered = 0
  private deliveredAt = 0
  private firstSentAt = 0
  private rates: Sample[] = []
  private speed = 0
  private rtts: Sample[] = []
  private rtt = 0
  private tooks: Sample[] = []
  private gaps: Sample[] = []
  private lastAck = 0
  /** Times this estimate forgot its line (a new network): for the viewer's report. */
  private forgotten = 0
  /** When a chunk last went alone (the first send counts as one: nothing was ahead of it). */
  private lastAloneAt = 0
  /** A round ends when a chunk sent after it began is acknowledged (BBR's next_round_delivered). */
  private roundEndsAt = 0
  private fullSpeed = 0
  private flatRounds = 0
  private full = false
  private draining = false
  /** This round had a sample the window limited, not the page: only such a round can show the line is full. */
  private roundFilled = false
  /** Bytes delivered in the last whole round, and the count when this one began. */
  private lastRound = 0
  private roundStartDelivered = 0
  /** The fastest acknowledgement this round. */
  private roundMinTook = Infinity

  /**
   * A chunk goes. `inFlight`: bytes unacknowledged before it; `window`: the byte budget it went under;
   * `limit`: the chunks unacknowledged before it and how many may be.
   */
  sent(
    now: number,
    bytes: number,
    inFlight: number,
    window: number,
    limit: { readonly chunks: number; readonly maxChunks: number; readonly key?: boolean }
  ): SentChunk {
    if (inFlight === 0 && limit.key !== true) this.lastAloneAt = now
    if (this.lastAloneAt === 0) this.lastAloneAt = now
    if (inFlight === 0) {
      // Nothing was on the way: the time since the last acknowledgement was the page's, not the line's.
      this.firstSentAt = now
      this.deliveredAt = now
    }
    return {
      at: now,
      bytes,
      delivered: this.delivered,
      deliveredAt: this.deliveredAt,
      firstSentAt: this.firstSentAt,
      // Alone, its sample is one chunk over a whole round trip: a floor too (the first key frame read 95 KB/s of 250).
      // Held back by the chunk cap rather than the window, it is the line's sample too: a doubled startup
      // budget is larger than the cap allows, and read as the page's, startup never ended (jittered relay).
      appLimited: inFlight === 0 || (inFlight + 2 * bytes <= window && limit.chunks + 2 <= limit.maxChunks),
      // A key frame never stands for the round trip: its own crossing is large, and after one is asked for the
      // chunks cleared before it are still queued ahead of it (it read 1.87 s on a 0.73 s line, review round 3).
      alone: inFlight === 0 && limit.key !== true
    }
  }

  /** The phone has `newest` and everything before it; `acked` bytes were taken off the line by it. */
  acked(now: number, newest: SentChunk, acked: number): void {
    const tookNow = now - newest.at
    if (newest.alone && this.rtt > 0 && tookNow > Math.max(this.rtt * NEW_LINE_TIMES, this.rtt + NEW_LINE_EXTRA_MS)) this.forgetLine()
    this.delivered += acked
    this.deliveredAt = now
    const took = now - newest.at
    this.tooks = [...recent(this.tooks, now, RATE_MEMORY_MS), { at: now, value: took }]
    if (this.lastAck > 0) this.gaps = [...recent(this.gaps, now, RATE_MEMORY_MS), { at: now, value: now - this.lastAck }]
    this.lastAck = now

    const interval = Math.max(newest.at - newest.firstSentAt, now - newest.deliveredAt)
    const bytes = this.delivered - newest.delivered
    this.firstSentAt = newest.at
    if (interval >= MIN_INTERVAL_MS && bytes > 0) {
      const rate = (bytes * 1000) / interval
      if (!newest.appLimited || rate > this.speed) this.rates = [...recent(this.rates, now, RATE_MEMORY_MS), { at: now, value: rate }]
    }
    const rates = recent(this.rates, now, this.rateMemoryMs())
    if (rates.length > 0) this.speed = Math.max(...rates.map((s) => s.value))

    // Its own crossing stays in: taken off at a speed read too low it left a 1 ms round trip; left in, the
    // fastest of the last RTT_MEMORY_MS is a small chunk's, a few tens of ms over the line, which is slack.
    if (newest.alone) this.rtts = [...recent(this.rtts, now, RTT_MEMORY_MS), { at: now, value: took }]
    if (!newest.appLimited) this.roundFilled = true
    this.roundMinTook = Math.min(this.roundMinTook, tookNow)
    if (newest.delivered >= this.roundEndsAt) {
      // Only a round the window limited says what the line took: a caret's round said almost nothing, and as a
      // startup cap it held the next scroll at the floor.
      if (this.roundFilled) this.lastRound = this.delivered - this.roundStartDelivered
      this.roundStartDelivered = this.delivered
      this.roundEndsAt = this.delivered
      this.endRound()
    }

    // The fastest recent acknowledgement can only be at or above the line's round trip, so it bounds a lone
    // chunk's that a stall or jitter inflated; with no lone chunk lately (a page scrolled without a pause on
    // a new network) it stands in, rather than a round trip from another line kept for good (review round 3).
    const fastestTook = Math.min(...this.tooks.map((s) => s.value))
    const rtts = recent(this.rtts, now, RTT_MEMORY_MS)
    this.rtt = rtts.length > 0 ? Math.min(fastestTook, ...rtts.map((s) => s.value)) : fastestTook
  }

  /** Another line: its speed, round trip and startup are learned again; the report's round trips stay. */
  private forgetLine(): void {
    this.forgotten += 1
    this.rates = []
    this.speed = 0
    this.rtts = []
    this.rtt = 0
    this.gaps = []
    this.lastAck = 0
    this.roundEndsAt = this.delivered
    this.roundStartDelivered = this.delivered
    this.lastRound = 0
    this.fullSpeed = 0
    this.flatRounds = 0
    this.full = false
    this.draining = false
    this.roundFilled = false
    this.roundMinTook = Infinity
  }

  /** One round over: still growing by a quarter, or the third flat round, which means the line is full. */
  private endRound(): void {
    if (this.draining) {
      this.draining = false
      return
    }
    const filled = this.roundFilled
    const fastest = this.roundMinTook
    this.roundFilled = false
    this.roundMinTook = Infinity
    if (this.full || this.speed <= 0 || !filled) return
    if (this.rtt > 0 && fastest > this.rtt * QUEUE_RTT_SHARE + this.ackGapMs(this.lastAck)) {
      this.full = true
      this.draining = true
      return
    }
    if (this.speed >= this.fullSpeed * FULL_GROWTH) {
      this.fullSpeed = this.speed
      this.flatRounds = 0
      return
    }
    this.flatRounds += 1
    if (this.flatRounds >= FULL_ROUNDS) {
      this.full = true
      this.draining = true
    }
  }

  /** The budget's multiplier: STARTUP_GAIN until the line is known full, DRAIN_GAIN for the round after, then 1. */
  get gain(): number {
    if (!this.full) return STARTUP_GAIN
    return this.draining ? DRAIN_GAIN : 1
  }

  private rateMemoryMs(): number {
    if (this.rtt <= 0) return RATE_MEMORY_MS
    return Math.min(RATE_MEMORY_MS, Math.max(RATE_MEMORY_MIN_MS, this.rtt * RATE_MEMORY_RTTS))
  }

  /** Bytes a second the line carries; 0 before anything is known. */
  get bytesPerSecond(): number {
    return this.speed
  }

  /** No chunk has gone alone for PROBE_EVERY_MS: the next should wait for the line to empty. */
  probeDue(now: number): boolean {
    const every = Math.min(PROBE_EVERY_MAX_MS, Math.max(PROBE_EVERY_MS, this.rtt * PROBE_EVERY_RTTS))
    return this.lastAloneAt > 0 && now - this.lastAloneAt >= every
  }

  /** An acknowledgement of a chunk no longer counted (written off, or cleared by a key frame asked for): the phone is there. */
  heard(now: number): void {
    this.lastAck = now
  }

  /** Bytes the line delivered in the last whole round the window limited; 0 before one. */
  get lastRoundBytes(): number {
    return this.lastRound
  }

  /** How many times this estimate forgot its line since it was made. */
  get forgets(): number {
    return this.forgotten
  }

  /** When the newest acknowledgement came; 0 before any. */
  get lastAckAt(): number {
    return this.lastAck
  }

  /** The line's own round trip in ms; 0 before anything is known. */
  get roundTripMs(): number {
    return this.rtt
  }

  /** The typical time between two acknowledgements lately (the median), 0 before two. */
  ackGapMs(now: number): number {
    const gaps = recent(this.gaps, now, RATE_MEMORY_MS).map((s) => s.value)
    if (gaps.length === 0) return 0
    gaps.sort((a, b) => a - b)
    return gaps[Math.floor(gaps.length / 2)]
  }

  /** Acknowledgement round trips of the last RATE_MEMORY_MS, as measured (queue and all). */
  tookMs(now: number): number[] {
    return recent(this.tooks, now, RATE_MEMORY_MS).map((s) => s.value)
  }
}
