import type { MapContext } from '../shared/cast-input'
import { VIDEO_FRAME_TYPE } from '../shared/cast-video'
import type { CastEncoderSession } from './cast-encoder'
import type { OutboundFrame } from './cast-viewer'

/**
 * ONE VIEWER'S PICTURE AS H.264 (cast-video-out.ts).
 *
 * The screencast hands over pictures as fast as Chrome draws them; a chunk
 * depends on the one before it, so none may be lost on the way and none may
 * be sent faster than the line takes them. So the picture is what waits, not
 * the chunk: the newest one is held, and encoded only while fewer than
 * VIDEO_CREDIT chunks (and VIDEO_CREDIT_BYTES) are unacknowledged by the
 * phone. A slow line gets fewer frames, each one whole.
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

export const VIDEO_CREDIT = 3
export const VIDEO_CREDIT_BYTES = 512 * 1024
/** An acknowledgement this late was lost: the chunk stops counting against the credit. */
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
  private readonly inFlight = new Map<number, { at: number; bytes: number }>()
  /** When the last key frame went out; null before the first, which never waits. */
  private lastKeyAt: number | null = null
  /** The size pictures are encoded at in this viewport revision: the largest seen, so a two-row jitter is no new size. */
  private canvas: { revision: number; width: number; height: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly started: number

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
    this.pending = { frame, context }
    this.clearRefresh()
    this.pump()
  }

  /** The phone has this chunk and every one before it. */
  ack(n: number): void {
    for (const sent of [...this.inFlight.keys()]) if (sent <= n) this.inFlight.delete(sent)
    this.pump()
  }

  /** The phone's chain broke: the next chunk starts it again. */
  keyAsked(): void {
    this.needKey = true
    this.inFlight.clear()
    if (!this.pending && this.last) this.pending = this.last
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
    for (const [n, sent] of this.inFlight) if (now - sent.at >= VIDEO_ACK_TIMEOUT_MS) this.inFlight.delete(n)
    const bytes = [...this.inFlight.values()].reduce((sum, sent) => sum + sent.bytes, 0)
    if (this.inFlight.size >= VIDEO_CREDIT || bytes >= VIDEO_CREDIT_BYTES) {
      const oldest = Math.min(...[...this.inFlight.values()].map((sent) => sent.at))
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, Math.max(10, oldest + VIDEO_ACK_TIMEOUT_MS - now))
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
    this.encode(picture)
  }

  private encode(picture: Picture): void {
    const { frame } = picture
    if (!frame.size) return this.pump()
    const size = this.canvasFor(frame.meta.revision, frame.size)
    this.encoding = true
    const key = this.needKey
    const timestamp = Math.max(0, Math.round((this.now() - this.started) * 1000))
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
          this.inFlight.set(n, { at: this.now(), bytes })
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
      this.pending = this.last
      this.pump()
    }, VIDEO_REFRESH_MS)
  }
}
