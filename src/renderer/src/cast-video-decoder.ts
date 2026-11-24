import { decodeBase64 } from './base64'
import { CAST_CODEC, type VideoChunkMessage } from '../../shared/cast-video'

/**
 * A LIVE VIEW'S H.264, DECODED ON THE PHONE (cast-video-decoder.ts).
 *
 * Every chunk is decoded, in order, whatever happens to the picture after:
 * each one is the difference from the one before (shared/cast-video.ts). So a
 * chunk that cannot be (one missing before it, a decoder that failed) breaks
 * the chain, the Mac is asked for a key frame, and nothing is decoded until it
 * comes; the ask goes again every VIDEO_KEY_REASK_MS, since one can be lost. A
 * chunk is acknowledged once decoded, or once given up on, so the Mac's pacing
 * never waits on a picture that will not come.
 *
 * A browser whose decoder keeps failing (VIDEO_GIVE_UP_AFTER in a row with no
 * picture between: a decoder it says it has and cannot set up, or one the
 * system takes away) gives up, and the view goes back to JPEG.
 *
 * Annex B: the key frame carries its own parameter sets, so the decoder needs
 * only the codec to start, and is set up again at every key frame whose size
 * or codec differs.
 */

export const VIDEO_KEY_REASK_MS = 2000
export const VIDEO_GIVE_UP_AFTER = 3

/** A decoded picture with the frame it stands for. The receiver closes `frame`. */
export interface DecodedPicture<Meta> {
  readonly seq: number
  readonly n: number
  readonly frame: VideoFrame
  /** The picture's size in frame pixels (it may be decoded a pixel smaller: even dimensions). */
  readonly width: number
  readonly height: number
  readonly meta: Meta
}

/** The part of WebCodecs this needs, so it can be tested without a browser. */
export interface DecoderLike {
  readonly state: string
  configure(config: VideoDecoderConfig): void
  decode(chunk: EncodedVideoChunk): void
  close(): void
}

export interface CastVideoDecoderDeps<Meta> {
  readonly onPicture: (picture: DecodedPicture<Meta>) => void
  /** The chain broke: ask the Mac for a key frame. */
  readonly askKey: () => void
  /** The Mac may count this chunk, and every one before it, as done with. */
  readonly ack: (n: number) => void
  /** This browser cannot decode the view after all: back to JPEG. Called once. */
  readonly giveUp: () => void
  readonly createDecoder?: (init: VideoDecoderInit) => DecoderLike
  readonly createChunk?: (init: EncodedVideoChunkInit) => EncodedVideoChunk
  readonly now?: () => number
}

let support: Promise<boolean> | null = null

/** Can this browser decode the live view's H.264 at a 3x phone's size. Asked once. */
export function canDecodeCastVideo(): Promise<boolean> {
  support ??= (async () => {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false
    try {
      const answer = await VideoDecoder.isConfigSupported({ codec: CAST_CODEC, codedWidth: 1290, codedHeight: 2796 })
      return answer.supported === true
    } catch {
      return false
    }
  })()
  return support
}

export class CastVideoDecoder<Meta> {
  private decoder: DecoderLike | null = null
  private configured: { codec: string; w: number; h: number } | null = null
  private broken = true
  private askedAt: number | null = null
  private expected = 0
  private closed = false
  private failures = 0
  private gaveUp = false
  private readonly waiting = new Map<number, { seq: number; n: number; w: number; h: number; meta: Meta }>()

  constructor(private readonly deps: CastVideoDecoderDeps<Meta>) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  push(chunk: VideoChunkMessage, meta: Meta): void {
    if (this.closed) return
    const gap = this.expected !== 0 && chunk.n !== this.expected
    this.expected = chunk.n + 1
    if ((this.broken || gap) && !chunk.key) {
      // Undecodable without what came before: asked for again from a key frame.
      this.break()
      this.deps.ack(chunk.n)
      return
    }
    if (chunk.key) this.ready(chunk)
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') {
      this.failed()
      this.deps.ack(chunk.n)
      return
    }
    let data: Uint8Array
    try {
      data = decodeBase64(chunk.data)
    } catch {
      this.break()
      this.deps.ack(chunk.n)
      return
    }
    // The timestamp is only a key back to this chunk's frame: n is unique and rising.
    this.waiting.set(chunk.n, { seq: chunk.seq, n: chunk.n, w: chunk.w, h: chunk.h, meta })
    try {
      decoder.decode(
        (this.deps.createChunk ?? ((init) => new EncodedVideoChunk(init)))({
          type: chunk.key ? 'key' : 'delta',
          timestamp: chunk.n,
          data: data as Uint8Array<ArrayBuffer>
        })
      )
    } catch {
      this.failed()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting.clear()
    this.drop()
  }

  /** A key frame: set the decoder up for it, if its codec or size is not what it was. */
  private ready(chunk: VideoChunkMessage): void {
    const same = this.configured && this.configured.codec === chunk.codec && this.configured.w === chunk.w && this.configured.h === chunk.h
    if (!same || !this.decoder || this.decoder.state !== 'configured') {
      this.drop()
      try {
        const decoder = (this.deps.createDecoder ?? ((init) => new VideoDecoder(init)))({
          output: (frame) => this.output(decoder, frame),
          error: () => {
            if (this.decoder === decoder) this.failed()
          }
        })
        decoder.configure({ codec: chunk.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' })
        this.decoder = decoder
        this.configured = { codec: chunk.codec, w: chunk.w, h: chunk.h }
      } catch {
        this.decoder = null
        this.configured = null
        return
      }
    }
    this.broken = false
    this.askedAt = null
  }

  private output(decoder: DecoderLike, frame: VideoFrame): void {
    const n = frame.timestamp
    const info = this.waiting.get(n)
    this.waiting.delete(n)
    if (this.closed || decoder !== this.decoder || !info) {
      frame.close()
      if (info) this.deps.ack(n)
      return
    }
    this.failures = 0
    this.deps.ack(n)
    this.deps.onPicture({ seq: info.seq, n, frame, width: info.w, height: info.h, meta: info.meta })
  }

  /** The decoder gave up: the chunks it held are done with, and the chain starts again at a key frame. */
  private failed(): void {
    this.drop()
    this.failures += 1
    if (this.failures >= VIDEO_GIVE_UP_AFTER && !this.gaveUp) {
      this.gaveUp = true
      this.close()
      this.deps.giveUp()
      return
    }
    this.break()
  }

  /** Broken: ask for a key frame, again once the last ask is old enough to have been lost. */
  private break(): void {
    this.broken = true
    const now = this.now()
    if (this.askedAt !== null && now - this.askedAt < VIDEO_KEY_REASK_MS) return
    this.askedAt = now
    this.deps.askKey()
  }

  /** The decoder let go of, and the chunks it held with it: done with, for the Mac's pacing. */
  private drop(): void {
    for (const n of this.waiting.keys()) this.deps.ack(n)
    this.waiting.clear()
    const decoder = this.decoder
    this.decoder = null
    this.configured = null
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close()
      } catch {
        // Already closed.
      }
    }
  }
}
