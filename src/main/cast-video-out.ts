import type { MapContext } from '../shared/cast-input'
import { VIDEO_FRAME_TYPE } from '../shared/cast-video'
import type { CastEncoderSession } from './cast-encoder'
import type { OutboundFrame } from './cast-viewer'
import { LineEstimate, type SentChunk } from './cast-line-estimate'

/**
 * ONE VIEWER'S PICTURE AS H.264 (cast-video-out.ts).
 *
 * The screencast hands over pictures as fast as Chrome draws them; a chunk
 * depends on the one before it, so none may be lost on the way and none may
 * be sent faster than the line takes them. So the picture is what waits, not
 * the chunk: the newest one is held, and encoded only while the bytes the
 * phone has not acknowledged fit the window. A slow line gets fewer frames,
 * each one whole.
 *
 * THE WINDOW IS FELT OUT FROM HOW LONG ACKNOWLEDGEMENTS TAKE. It was three
 * chunks, and on the relay an acknowledgement is a POST through cookrew.dev:
 * the Mac sent 1.2 frames a second while using 4-19 KB/s of a ~100 KB/s line
 * (phone stats, 11-24). Now, while a chunk comes back about as fast as the
 * fastest lately, the window grows; once they come back slower, chunks are
 * queueing somewhere, and the window gives back, since a queue is exactly the
 * delay a finger feels (socket-bridge-session.ts learns its credit the same way).
 *
 * A PAGE AT REST IS SHARPENED, THEN QUIET. Under motion the encoder spends few
 * bits per frame and text softens; once the pictures stop coming the last one
 * is encoded again, VIDEO_REFRESH_MS apart, until a refresh adds almost nothing
 * (or VIDEO_REFRESHES of them), which is how an encoder brings a still picture
 * up to full quality. After that, Chrome's own heartbeat (the same JPEG again)
 * is answered with `same`, as on the relay.
 *
 * A key frame starts the chain: the first, any after the phone asks (it saw a
 * gap or its decoder failed), and any after the picture's size changed (the
 * encoder is set up again; cast-encoder-script.ts).
 */

/** Bytes in flight: where the window starts, and how small and large it may become. */
export const VIDEO_WINDOW_START = 96 * 1024
/**
 * THE WINDOW IS A DELAY BUDGET, NOT A CREDIT. Measured throughput times how
 * long a chunk may be in flight: at least MIN_INFLIGHT_S, and otherwise the
 * line's round trip plus the gap acknowledgements come in (doubled while the
 * line is not yet known full; cast-line-estimate.ts), so a frame can be sent
 * while the previous ones are still acknowledged (measured 11-24 on the relay: a shrinking window left
 * 16-40 KB in flight, one to three 12-16 KB frames, which is 1-4 fps at a
 * 0.7-1.3 s round trip, while the line carried 50-100 KB/s). The cost is about
 * a round trip of standing latency — the scroll lead hides it — and not a
 * pixel of sharpness.
 */
export const VIDEO_WINDOW_MIN = 16 * 1024
export const VIDEO_WINDOW_MAX = 512 * 1024
const MIN_INFLIGHT_S = 0.8
/**
 * The budget never grows past this. It is built from the line's own round trip
 * (cast-line-estimate.ts: from chunks with nothing ahead of them), not the one
 * just seen: a queue this window itself made would otherwise raise the next
 * budget, which is how a delay-based loop runs away. The cap bounds even that.
 *
 * It was 1.5 s, under the round trip of a sealed relay (acknowledgements took
 * 1.3-2.3 s on the phone, owner 2026-11-25): each round's window was smaller
 * than the line, and it shrank to the floor.
 */
const MAX_INFLIGHT_S = 4
/** An unacknowledged chunk stops counting after this many of the fastest round trips lately, within [VIDEO_ACK_TIMEOUT_MS, 2x that]. */
const LOST_AFTER_RTTS = 2.5
/** Measurements kept between reports, at most: a viewer whose reports never come must not grow them forever. */
const MEASURED_MAX = 1000
/** Chunks in flight whatever their size: a run of tiny refreshes is no reason to send forty. */
export const VIDEO_WINDOW_MAX_CHUNKS = 24
/**
 * On a long line the cap grows to what a 30 fps page sends in CHUNK_CAP_RTTS of
 * its round trip, up to VIDEO_WINDOW_MAX_CHUNKS_LONG. At 24 a caret and its
 * sharpening refreshes filled it on a 2 s line, and capped there a few hundred
 * bytes a second read as the line's speed (owner 2026-11-25, "帧率也很低").
 */
export const VIDEO_WINDOW_MAX_CHUNKS_LONG = 96
const SOURCE_FPS = 30
const CHUNK_CAP_RTTS = 1.5
/** An acknowledgement this late was lost: the chunk stops counting against the window. */
export const VIDEO_ACK_TIMEOUT_MS = 2500
/**
 * Up to this many refreshes of a picture at rest, ended early once one comes
 * back smaller than VIDEO_REFRESH_SETTLED_BYTES: the encoder has nothing left
 * to add. Measured 11-24 on real Chrome: two fixed refreshes left one run of
 * three 5.3 levels (of 255) from its source, its last refresh still 15 KB.
 */
export const VIDEO_REFRESHES = 4
export const VIDEO_REFRESH_SETTLED_BYTES = 1500
export const VIDEO_REFRESH_MS = 150
/**
 * Key frames a viewer asks for come at most this often. A key frame is the
 * dearest thing to make (~250 KB at 2x) and `vkey` is any paired device's to
 * send; a phone whose chain broke waits this long at most, dropping deltas.
 */
export const VIDEO_KEY_MIN_MS = 1000
/**
 * An encode that has not answered by now never will: the viewer goes back to
 * JPEG rather than stay on its last picture (review 11-24). The first is
 * longer: setting the encoder up took ~3 s on real Chrome.
 */
export const VIDEO_ENCODE_TIMEOUT_MS = 5000
export const VIDEO_FIRST_ENCODE_TIMEOUT_MS = 10_000
/** Within one revision a picture this much larger or smaller is a new size, not jitter. */
const SIZE_JITTER_PX = 4

export interface VideoOutDeps {
  readonly session: CastEncoderSession
  readonly codec: string
  /** A message to the viewer, in order (the sink's sendControl). */
  readonly send: (message: Record<string, unknown>) => void
  /** May the line take more now, and a call back when it can (the sink's own backpressure). */
  readonly ready: () => boolean
  readonly onceReady: (callback: () => void) => void
  /** A chunk for this picture went out: the viewer's frame context is now this one. */
  readonly delivered: (frame: OutboundFrame, context: MapContext, bytes: number) => void
  /** The encoder failed: the viewer goes back to JPEG. */
  readonly failed: (error: unknown) => void
  readonly now?: () => number
}

interface Picture {
  readonly frame: OutboundFrame
  readonly context: MapContext
}

export class VideoOut {
  private pending: Picture | null = null
  private last: Picture | null = null
  private encoding = false
  private needKey = true
  private closed = false
  private count = 0
  private refreshes = 0
  private waitingReady = false
  private readonly inFlight = new Map<number, SentChunk>()
  /** When the last key frame went out; null before the first, which never waits. */
  private lastKeyAt: number | null = null
  /** The size pictures are encoded at in this viewport revision: the largest seen, so a two-row jitter is no new size. */
  private canvas: { revision: number; width: number; height: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly started: number
  /** Bytes the phone may have unacknowledged; learned from how long acknowledgements take. */
  private window = VIDEO_WINDOW_START
  /** The line's speed and round trip, from the phone's acknowledgements. */
  private line = new LineEstimate()
  /** When the newest picture began waiting to be encoded. */
  private pendingSince = 0
  /** What this stretch measured, for the viewer's report (cast-stats-log.ts). */
  private measured = { encodeMs: [] as number[], waitMs: [] as number[], ackMs: [] as number[] }

  constructor(private readonly deps: VideoOutDeps) {
    this.started = this.now()
  }

  /**
   * A first chunk has gone out. Until then the viewer keeps its JPEG frames:
   * setting an encoder up took ~3 s on real Chrome (measured 11-24), and a
   * picture frozen that long is worse than a JPEG one.
   */
  get flowing(): boolean {
    return this.count > 0
  }

  /** A clock that only goes forward: encoder timestamps are made from it. */
  private now(): number {
    return (this.deps.now ?? (() => performance.now()))()
  }

  /** The newest picture from the screencast. */
  offer(frame: OutboundFrame, context: MapContext): void {
    if (this.closed) return
    const last = this.last
    const same = last !== null && last.frame.base64 === frame.base64 && last.frame.meta.revision === frame.meta.revision
    if (same && this.pending === null) {
      // Chrome's heartbeat. Sharpened enough already: the line is alive, the picture stands.
      if (this.refreshes >= VIDEO_REFRESHES && !this.encoding) {
        this.deps.send({ t: 'same', seq: frame.seq, revision: frame.meta.revision })
        this.deps.delivered(frame, context, 0)
        return
      }
    }
    this.setPending({ frame, context })
    this.clearRefresh()
    this.pump()
  }

  /** The picture to encode next, and when it began to wait (the report's waitMs). */
  private setPending(picture: Picture): void {
    if (this.pending === null) this.pendingSince = this.now()
    this.pending = picture
  }

  /**
   * The phone has this chunk and every one before it. One sample per
   * acknowledgement, from its newest chunk: the older ones it covers waited for
   * the acknowledgement to be sent (on the relay, behind a POST), and read as
   * slow they would look like a queue that is not there (review 11-24).
   */
  ack(n: number): void {
    const newest = this.inFlight.get(n)
    let acked = 0
    for (const [sent, info] of [...this.inFlight]) {
      if (sent > n) continue
      acked += info.bytes
      this.inFlight.delete(sent)
    }
    if (newest) this.learn(newest, acked)
    // ANY acknowledgement says the phone is there, one for a chunk already written off or cleared by a key
    // frame asked for included. Ignored, such a phone read as silent while it acknowledged, every chunk was
    // written off before its acknowledgement came, and the sender poured into a line it had stopped measuring
    // (review 2026-11-25: a 33 s queue after a network change).
    else this.line.heard(this.now())
    this.pump()
  }

  /**
   * The delay budget, from one acknowledgement: what the line carries a second
   * (cast-line-estimate.ts) times how long a chunk may be in flight: its own
   * round trip with slack, plus the gap acknowledgements come in, never under
   * MIN_INFLIGHT_S. Sharpness is untouched; the standing latency it buys is
   * what keeps frames flowing on a slow line.
   */
  private learn(newest: SentChunk, acked: number): void {
    const now = this.now()
    this.measure('ackMs', now - newest.at)
    this.line.acked(now, newest, acked)
    const speed = this.line.bytesPerSecond
    if (speed <= 0) return
    // The round trip of a chunk sent alone already holds the wait for its acknowledgement's POST; with the gap
    // the next one comes after, the line stays busy. More only stands as a queue in front of the finger.
    const budgetMs = (this.line.roundTripMs + this.line.ackGapMs(now)) * this.line.gain
    // In startup, never more than twice what the last round delivered: a line that got slower meanwhile is
    // still read at its old speed for the rate memory, and the doubled budget poured onto it (review round 3).
    const startupCap = this.line.gain > 1 && this.line.lastRoundBytes > 0 ? 2 * this.line.lastRoundBytes : Infinity
    const inflightS = Math.min(MAX_INFLIGHT_S, Math.max(MIN_INFLIGHT_S, budgetMs / 1000))
    this.window = Math.min(VIDEO_WINDOW_MAX, startupCap, Math.max(VIDEO_WINDOW_MIN, Math.round(speed * inflightS)))
    this.window = Math.max(VIDEO_WINDOW_MIN, this.window)
  }

  private measure(kind: 'encodeMs' | 'waitMs' | 'ackMs', value: number): void {
    const list = this.measured[kind]
    list.push(value)
    if (list.length > MEASURED_MAX) list.splice(0, list.length - MEASURED_MAX)
  }

  /** The window now, in bytes (for tests and the viewer's report). */
  get windowBytes(): number {
    return this.window
  }

  /** Chunks unacknowledged at most: VIDEO_WINDOW_MAX_CHUNKS, more on a line whose round trip needs them. */
  private maxChunks(): number {
    const needed = Math.ceil((this.line.roundTripMs / 1000) * SOURCE_FPS * CHUNK_CAP_RTTS)
    return Math.min(VIDEO_WINDOW_MAX_CHUNKS_LONG, Math.max(VIDEO_WINDOW_MAX_CHUNKS, needed))
  }

  /** When an unacknowledged chunk stops counting: a few of the fastest round trips lately, within [VIDEO_ACK_TIMEOUT_MS, 2x that]. */
  private lostAfter(): number {
    const took = this.line.tookMs(this.now())
    if (took.length === 0) return VIDEO_ACK_TIMEOUT_MS
    return Math.min(2 * VIDEO_ACK_TIMEOUT_MS, Math.max(VIDEO_ACK_TIMEOUT_MS, Math.min(...took) * LOST_AFTER_RTTS))
  }

  /** The median acknowledgement round trip of the last ten seconds (0 before any): the line, for cast-profile.ts. */
  ackP50(): number {
    const recent = this.line.tookMs(this.now())
    if (recent.length === 0) return 0
    recent.sort((a, b) => a - b)
    return Math.round(recent[Math.min(recent.length - 1, Math.floor(recent.length / 2))])
  }

  /** What this stretch measured, then a fresh one: encode time, how long a picture waited, acknowledgement round trips. */
  takeMeasured(): { encodeMs: number[]; waitMs: number[]; ackMs: number[]; windowKB: number } {
    const out = { ...this.measured, windowKB: Math.round(this.window / 1024) }
    this.measured = { encodeMs: [], waitMs: [], ackMs: [] }
    return out
  }

  /** The phone's chain broke: the next chunk starts it again. */
  keyAsked(): void {
    this.needKey = true
    this.inFlight.clear()
    // Very likely another line (the phone came back on a new network): what was learned of the old one is no
    // guide to this one, and the chunks just cleared are still crossing. Kept, the estimate went on pouring a
    // full window on top of them (review 2026-11-25). Startup again, from VIDEO_WINDOW_START.
    this.window = Math.min(this.window, VIDEO_WINDOW_START)
    this.line = new LineEstimate()
    if (!this.pending && this.last) this.setPending(this.last)
    this.pump()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pending = null
    this.last = null
    if (this.timer) clearTimeout(this.timer)
    this.clearRefresh()
    this.timer = null
    this.deps.session.close()
  }

  private clearRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  private pump(): void {
    if (this.closed || this.encoding || !this.pending) return
    const now = this.now()
    const lostAfter = this.lostAfter()
    // WRITTEN OFF ONLY WHEN THE PHONE WENT QUIET: no acknowledgement of anything for lostAfter. While
    // acknowledgements keep coming the line is alive, only slow, and every chunk on it still counts; writing
    // the slow ones off let the sender pour more onto a line that had just got slower (a 7 s queue, measured
    // in tests/cast-video-line.test.ts), and hid that it was full.
    const heard = (sent: SentChunk): number => Math.max(sent.at, this.line.lastAckAt)
    for (const [n, sent] of this.inFlight) {
      if (now - heard(sent) < lostAfter) continue
      this.inFlight.delete(n)
    }
    const bytes = [...this.inFlight.values()].reduce((sum, sent) => sum + sent.bytes, 0)
    // PROBE THE ROUND TRIP (BBR's ProbeRTT): with no chunk sent alone for a while, the next waits until the
    // line is empty and goes alone, so the line's own round trip is read again. Without it, a page that never
    // paused had only acknowledgements with its own queue in them to read, and the queue fed the round trip
    // that fed the queue: ~3.4 s behind after minutes on a slow relay (review round 4). One round trip of
    // pictures every PROBE_EVERY_MS.
    const probing = this.inFlight.size > 0 && this.line.probeDue(now)
    if (probing || this.inFlight.size >= this.maxChunks() || (this.inFlight.size > 0 && bytes >= this.window)) {
      const oldest = Math.min(...[...this.inFlight.values()].map(heard))
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, Math.max(10, oldest + lostAfter - now))
      return
    }
    const keyWait = this.needKey && this.lastKeyAt !== null ? this.lastKeyAt + VIDEO_KEY_MIN_MS - now : 0
    if (keyWait > 0) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, keyWait)
      return
    }
    if (!this.deps.ready()) {
      if (this.waitingReady) return
      this.waitingReady = true
      this.deps.onceReady(() => {
        this.waitingReady = false
        this.pump()
      })
      return
    }
    const picture = this.pending
    this.pending = null
    this.measure('waitMs', now - this.pendingSince)
    this.encode(picture)
  }

  private encode(picture: Picture): void {
    const { frame } = picture
    if (!frame.size) return this.pump()
    const size = this.canvasFor(frame.meta.revision, frame.size)
    this.encoding = true
    const key = this.needKey
    const encodeStart = this.now()
    const timestamp = Math.max(0, Math.round((encodeStart - this.started) * 1000))
    const limit = this.count === 0 ? VIDEO_FIRST_ENCODE_TIMEOUT_MS : VIDEO_ENCODE_TIMEOUT_MS
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const hung = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`the H.264 encoder did not answer in ${limit} ms`)), limit)
    })
    Promise.race([this.deps.session.encode(frame.base64, key, timestamp, size), hung])
      .finally(() => {
        if (watchdog) clearTimeout(watchdog)
      })
      .then(
      (chunk) => {
        this.encoding = false
        if (this.closed) return
        this.measure('encodeMs', this.now() - encodeStart)
        if (chunk) {
          this.count += 1
          const n = this.count
          const bytes = Math.floor((chunk.data.length * 3) / 4)
          this.deps.send({
            t: VIDEO_FRAME_TYPE,
            seq: frame.seq,
            n,
            key: chunk.key,
            codec: this.deps.codec,
            w: size.width,
            h: size.height,
            data: chunk.data,
            meta: frame.meta
          })
          const unacknowledged = [...this.inFlight.values()].reduce((sum, sent) => sum + sent.bytes, 0)
          const limit = { chunks: this.inFlight.size, maxChunks: this.maxChunks() }
          this.inFlight.set(n, this.line.sent(this.now(), bytes, unacknowledged, this.window, { ...limit, key: chunk.key === true }))
          if (chunk.key) {
            this.needKey = false
            this.lastKeyAt = this.now()
          }
          this.deps.delivered(frame, picture.context, bytes)
          const repeat = this.last !== null && this.last.frame.base64 === frame.base64
          // A new picture starts its sharpening over; a refresh counts toward it, or ends it once it adds almost nothing.
          if (!repeat) this.refreshes = 0
          else this.refreshes = bytes < VIDEO_REFRESH_SETTLED_BYTES ? VIDEO_REFRESHES : this.refreshes + 1
          this.last = picture
          this.scheduleRefresh()
        }
        this.pump()
      },
      (error: unknown) => {
        this.encoding = false
        if (!this.closed) this.deps.failed(error)
      }
    )
  }

  /**
   * The size to encode this picture at. Measured 11-24: within one viewport
   * revision a resting screencast alternated 780x1400 and 780x1398, and every
   * change of size set the encoder up again with a key frame of ~265 KB. A new
   * revision starts over; within one, the largest picture seen stands.
   */
  private canvasFor(revision: number, size: { width: number; height: number }): { width: number; height: number } {
    const kept = this.canvas
    const jitter =
      kept !== null &&
      Math.abs(size.width - kept.width) <= SIZE_JITTER_PX &&
      Math.abs(size.height - kept.height) <= SIZE_JITTER_PX
    if (!kept || kept.revision !== revision || !jitter) {
      // A new revision, or a picture really another size: drawn into the corner of
      // the old one it would leave stale content around it and taps would miss.
      this.canvas = { revision, ...size }
    } else if (size.width > kept.width || size.height > kept.height) {
      this.canvas = { revision, width: Math.max(size.width, kept.width), height: Math.max(size.height, kept.height) }
    }
    const { width, height } = this.canvas as { width: number; height: number }
    return { width, height }
  }

  /** The picture stopped changing: encode it again, a few times, to bring it up to full quality. */
  private scheduleRefresh(): void {
    this.clearRefresh()
    if (this.refreshes >= VIDEO_REFRESHES) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.closed || this.pending || !this.last) return
      this.setPending(this.last)
      this.pump()
    }, VIDEO_REFRESH_MS)
  }
}
