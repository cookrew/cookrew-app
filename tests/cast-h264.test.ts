import http from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tuning = vi.hoisted(() => ({
  value: { scaleMax: 2, relayScaleMax: 1, quality: 60, h264: true, h264Kbps: 4000, relayH264Kbps: 800, h264SourceQuality: 90, relayVideoScaleMax: 2 }
}))
vi.mock('../src/main/cast-tuning', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/cast-tuning')>()
  return { ...real, castTuning: () => tuning.value }
})

import {
  VIDEO_FIRST_ENCODE_TIMEOUT_MS,
  VIDEO_KEY_MIN_MS,
  VIDEO_REFRESHES,
  VIDEO_REFRESH_MS,
  VIDEO_WINDOW_MAX,
  VIDEO_WINDOW_MIN,
  VIDEO_WINDOW_START,
  VideoOut
} from '../src/main/cast-video-out'
import { CAST_ENCODER_MAX_SESSIONS, createCastEncoder, type CastEncoderHost, type CastEncoderOptions, type CastEncoderSession, type EncodedChunk } from '../src/main/cast-encoder'
import { CastViewer, type OutboundFrame, type ViewerSink } from '../src/main/cast-viewer'
import type { BrowserInstance } from '../src/main/browser-instance'
import { createSocketBridge } from '../src/main/socket-bridge'
import type { LoopbackSocket, LoopbackSocketDeps } from '../src/main/ws-client'
import { CAST_CODEC, isVideoChunk, readVideoChunk, sanitizeCodecs, sanitizeVideoAck } from '../src/shared/cast-video'
import { CastVideoDecoder, VIDEO_GIVE_UP_AFTER, VIDEO_KEY_REASK_MS, type DecoderLike } from '../src/renderer/src/cast-video-decoder'
import { parseStreamObject } from '../src/renderer/src/browser-stream'
import { coalesceInput } from '../src/renderer/src/path/bridge-outbox'
import { sanitizeCastStats } from '../src/shared/cast-stats'
import { CastStatsMeter } from '../src/renderer/src/cast-stats-meter'
import { CAST_TUNING_DEFAULTS, parseCastTuning } from '../src/main/cast-tuning'

const DEFAULT_TUNING = { ...tuning.value }
beforeEach(() => {
  tuning.value = { ...DEFAULT_TUNING }
})
afterEach(() => {
  vi.useRealTimers()
})

/** Let promise callbacks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** An encoder whose answers the test gives, one call at a time. */
function fakeSession() {
  const calls: { base64: string; key: boolean; size: { width: number; height: number }; answer: (chunk: EncodedChunk | null) => void; fail: (error: unknown) => void }[] = []
  let closed = false
  const session: CastEncoderSession = {
    encode: (base64, key, _ts, size) =>
      new Promise<EncodedChunk | null>((resolve, reject) => {
        calls.push({ base64, key, size, answer: resolve, fail: reject })
      }),
    close: () => void (closed = true)
  }
  return { session, calls, closed: () => closed }
}

const picture = (seq: number, base64 = `pic${seq}`, revision = 1): OutboundFrame => ({
  seq,
  base64,
  bytes: Buffer.from(base64),
  size: { width: 780, height: 1400 },
  meta: { displayScale: 2, pageScaleFactor: 1, mobile: true, revision }
})
const CTX = { displayScale: 2, viewportWidth: 390, viewportHeight: 700 }

function videoOut() {
  const enc = fakeSession()
  const sent: Record<string, unknown>[] = []
  const delivered: number[] = []
  const failures: unknown[] = []
  const out = new VideoOut({
    session: enc.session,
    codec: CAST_CODEC,
    send: (message) => void sent.push(message),
    ready: () => true,
    onceReady: () => undefined,
    delivered: (frame) => void delivered.push(frame.seq),
    failed: (error) => void failures.push(error),
    // The fake timers' clock (performance.now is not faked).
    now: () => Date.now()
  })
  return { out, enc, sent, delivered, failures }
}

describe('the Mac sends H.264 at the speed the phone takes it', () => {
  it('starts the chain with a key frame and sends each chunk with its picture’s size', async () => {
    const { out, enc, sent, delivered } = videoOut()
    out.offer(picture(1), CTX)
    expect(enc.calls).toHaveLength(1)
    expect(enc.calls[0].key).toBe(true)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    expect(sent[0]).toMatchObject({ t: 'vframe', seq: 1, n: 1, key: true, codec: CAST_CODEC, w: 780, h: 1400, data: 'AAAA' })
    expect(delivered).toEqual([1])
  })

  it('holds the newest picture, not the chunk, while the unacknowledged bytes fill the window', async () => {
    const { out, enc, sent } = videoOut()
    // 40 KB chunks: three fill a 96 KB window.
    const chunk40 = 'A'.repeat(Math.ceil((40 * 1024 * 4) / 3))
    for (let i = 1; i <= 3; i++) {
      out.offer(picture(i), CTX)
      enc.calls[i - 1].answer({ data: chunk40, key: i === 1 })
      await settle()
    }
    expect(out.windowBytes).toBe(VIDEO_WINDOW_START)
    expect(sent.filter((m) => m.t === 'vframe')).toHaveLength(3)
    out.offer(picture(10), CTX)
    out.offer(picture(11), CTX)
    out.offer(picture(12), CTX)
    expect(enc.calls).toHaveLength(3)
    out.ack(1)
    expect(enc.calls).toHaveLength(4)
    expect(enc.calls.at(-1)?.base64).toBe('pic12')
    expect(enc.calls.at(-1)?.key).toBe(false)
  })

  it('budgets in-flight bytes by measured throughput, so a slow line still pipelines frames', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    const chunk40 = 'A'.repeat(Math.ceil((40 * 1024 * 4) / 3))
    const send = async (seq: number): Promise<void> => {
      out.offer(picture(seq), CTX)
      enc.calls.at(-1)?.answer({ data: chunk40, key: seq === 1 })
      await settle()
    }
    // A fast line: 40 KB acknowledged every 100 ms is about 400 KB/s, and the
    // budget is a round trip (never under 0.8 s) of it.
    for (let i = 1; i <= 6; i++) {
      await send(i)
      vi.advanceTimersByTime(100)
      out.ack(i)
    }
    const fast = out.windowBytes
    expect(fast).toBeGreaterThan(VIDEO_WINDOW_START)
    expect(fast).toBeLessThanOrEqual(VIDEO_WINDOW_MAX)
    // The same 40 KB every 1200 ms is about 33 KB/s: the budget follows it down
    // toward the floor, and the inflight time is capped above (a queue must not
    // raise its own budget).
    for (let i = 7; i <= 16; i++) {
      await send(i)
      vi.advanceTimersByTime(1200)
      out.ack(i)
    }
    expect(out.windowBytes).toBeLessThanOrEqual(VIDEO_WINDOW_MAX)
    expect(out.windowBytes).toBeGreaterThanOrEqual(VIDEO_WINDOW_MIN)
    expect(out.windowBytes).toBeLessThan(fast)
  })

  it('keeps its floor on a line whose acknowledgements stop coming, and its ceiling on a fast one', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    const chunk = 'A'.repeat(Math.ceil((60 * 1024 * 4) / 3))
    for (let i = 1; i <= 80; i++) {
      out.offer(picture(i), CTX)
      enc.calls.at(-1)?.answer({ data: chunk, key: i === 1 })
      await settle()
      vi.advanceTimersByTime(20)
      out.ack(i)
    }
    expect(out.windowBytes).toBe(VIDEO_WINDOW_MAX)
    // Lost acknowledgements do not empty the window below its floor.
    for (let i = 81; i <= 84; i++) {
      out.offer(picture(i), CTX)
      enc.calls.at(-1)?.answer({ data: chunk, key: false })
      await settle()
      vi.advanceTimersByTime(3000)
    }
    expect(out.windowBytes).toBeGreaterThanOrEqual(VIDEO_WINDOW_MIN)
  })

  it('never encodes two at once: the next waits for the chunk before it', async () => {
    const { out, enc } = videoOut()
    out.offer(picture(1), CTX)
    out.offer(picture(2), CTX)
    expect(enc.calls).toHaveLength(1)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    expect(enc.calls).toHaveLength(2)
  })

  it('starts the chain again when the phone asks, from the picture on screen, but not more than once a second', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    out.keyAsked()
    // A key frame went out a moment ago: the next waits out VIDEO_KEY_MIN_MS.
    expect(enc.calls).toHaveLength(1)
    vi.advanceTimersByTime(VIDEO_KEY_MIN_MS)
    expect(enc.calls).toHaveLength(2)
    expect(enc.calls[1]).toMatchObject({ base64: 'pic1', key: true })
    enc.calls[1].answer({ data: 'AAAA', key: true })
    await settle()
    for (let i = 0; i < 20; i++) out.keyAsked()
    vi.advanceTimersByTime(VIDEO_KEY_MIN_MS / 2)
    expect(enc.calls).toHaveLength(2)
  })

  it('sharpens a picture that stopped changing, then answers the heartbeat with `same`', async () => {
    vi.useFakeTimers()
    const { out, enc, sent } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    // Each refresh still adds plenty: all of them run.
    const big = 'A'.repeat(4000)
    for (let i = 1; i <= VIDEO_REFRESHES; i++) {
      vi.advanceTimersByTime(VIDEO_REFRESH_MS)
      expect(enc.calls).toHaveLength(i + 1)
      expect(enc.calls[i]).toMatchObject({ base64: 'pic1', key: false })
      enc.calls[i].answer({ data: big, key: false })
      await settle()
      out.ack(i + 1)
    }
    vi.advanceTimersByTime(VIDEO_REFRESH_MS * 4)
    expect(enc.calls).toHaveLength(VIDEO_REFRESHES + 1)
    out.offer(picture(2, 'pic1'), CTX)
    expect(enc.calls).toHaveLength(VIDEO_REFRESHES + 1)
    expect(sent.at(-1)).toMatchObject({ t: 'same', seq: 2, revision: 1 })
  })

  it('stops sharpening as soon as a refresh adds almost nothing', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    vi.advanceTimersByTime(VIDEO_REFRESH_MS)
    enc.calls[1].answer({ data: 'A'.repeat(4000), key: false })
    await settle()
    vi.advanceTimersByTime(VIDEO_REFRESH_MS)
    enc.calls[2].answer({ data: 'AAAA', key: false })
    await settle()
    vi.advanceTimersByTime(VIDEO_REFRESH_MS * 5)
    expect(enc.calls).toHaveLength(3)
  })

  it('a new picture stops the sharpening of the old one', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    out.offer(picture(2), CTX)
    expect(enc.calls[1].base64).toBe('pic2')
  })

  it('keeps one size per viewport revision, so a picture two rows short is no new size', async () => {
    const { out, enc, sent } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    out.offer({ ...picture(2), size: { width: 780, height: 1398 } }, CTX)
    expect(enc.calls[1].size).toEqual({ width: 780, height: 1400 })
    enc.calls[1].answer({ data: 'BB', key: false })
    await settle()
    expect(sent.at(-1)).toMatchObject({ w: 780, h: 1400 })
    out.offer({ ...picture(3, 'pic3', 2), size: { width: 1170, height: 2100 } }, CTX)
    expect(enc.calls[2].size).toEqual({ width: 1170, height: 2100 })
  })

  it('a refresh reports its own wait, not the one from when its picture first came', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    // An encode that takes a while: the picture waited all of it.
    out.offer(picture(1), CTX)
    vi.advanceTimersByTime(200)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    out.takeMeasured()
    vi.advanceTimersByTime(VIDEO_REFRESH_MS)
    expect(enc.calls).toHaveLength(2)
    enc.calls[1].answer({ data: 'A'.repeat(4000), key: false })
    await settle()
    vi.advanceTimersByTime(VIDEO_REFRESH_MS)
    enc.calls[2].answer({ data: 'AAAA', key: false })
    await settle()
    const waits = out.takeMeasured().waitMs
    // Each refresh waited about a tick, not everything since the picture arrived.
    expect(waits.every((ms) => ms < VIDEO_REFRESH_MS * 2)).toBe(true)
  })

  // Owner's phone, 2026-11-26: a desktop-sized page fell back to the window floor on 0.6.42 and the
  // phone-like simulation did not reproduce it. A report says what the pacing did, so the next one can.
  it('reports, per stretch, the key frames asked for and sent, chunks written off, and what the line estimate held', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    const chunk20 = 'A'.repeat(Math.ceil((20 * 1024 * 4) / 3))
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: chunk20, key: true })
    await settle()
    vi.advanceTimersByTime(700)
    out.ack(1)
    for (let i = 2; i <= 4; i++) {
      out.offer(picture(i), CTX)
      enc.calls.at(-1)?.answer({ data: chunk20, key: false })
      await settle()
      vi.advanceTimersByTime(120)
      out.ack(i)
    }
    out.keyAsked()
    vi.advanceTimersByTime(VIDEO_KEY_MIN_MS)
    out.keyAsked()
    const first = out.takeMeasured()
    expect(first.keyAsks).toBe(2)
    expect(first.keyFrames).toBe(1)
    expect(first.writeOffs).toBe(0)
    // Asked for, the line starts over: nothing known now, so it says so rather than an old number.
    expect(first.speedKBps).toBe(0)
    expect(first.rttMs).toBe(0)
    expect(first.gain).toBeGreaterThan(1)
    expect(first.lineResets).toBe(2)
    // A fresh stretch starts its counts at zero.
    const second = out.takeMeasured()
    expect([second.keyAsks, second.keyFrames, second.writeOffs, second.lineResets]).toEqual([0, 0, 0, 0])
  })

  it('reports the line estimate while it is known', async () => {
    vi.useFakeTimers()
    const { out, enc } = videoOut()
    const chunk20 = 'A'.repeat(Math.ceil((20 * 1024 * 4) / 3))
    for (let i = 1; i <= 6; i++) {
      out.offer(picture(i), CTX)
      enc.calls.at(-1)?.answer({ data: chunk20, key: i === 1 })
      await settle()
      vi.advanceTimersByTime(150)
      out.ack(i)
    }
    const measured = out.takeMeasured()
    expect(measured.speedKBps).toBeGreaterThan(0)
    expect(measured.rttMs).toBeGreaterThan(0)
  })

  it('says when the encoder failed, and stops', async () => {
    const { out, enc, failures } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].fail(new Error('encoder died'))
    await settle()
    expect(failures).toHaveLength(1)
  })

  it('a chunk the encoder dropped is no chunk: nothing goes out for it', async () => {
    const { out, enc, sent } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer(null)
    await settle()
    expect(sent).toEqual([])
  })

  it('closes its encoder session', () => {
    const { out, enc } = videoOut()
    out.close()
    expect(enc.closed()).toBe(true)
  })
})

function viewerWith(options: { relayed?: boolean; supported?: boolean; ceiling?: number } = {}) {
  const enc = fakeSession()
  const opened: CastEncoderOptions[] = []
  const host: CastEncoderHost = {
    supported: async () => options.supported ?? true,
    open: (o) => {
      opened.push(o)
      return enc.session
    }
  }
  const controls: Record<string, unknown>[] = []
  const frames: OutboundFrame[] = []
  const offers: { scale?: number }[] = []
  const quality: (number | null)[] = []
  const frameListeners = new Set<(data: string, meta: Record<string, unknown>) => void>()
  const instance = {
    viewportState: { width: 390, height: 700, mobile: true, revision: 1, transitioning: false, agentHeld: false, ownerId: null, viewerCount: 1 },
    frameListeners,
    scaleCeiling: options.ceiling ?? 3,
    registerViewportViewer: () => undefined,
    unregisterViewportViewer: () => undefined,
    onViewportState: () => () => undefined,
    offerViewport: (_id: string, metrics: { scale?: number }) => void offers.push(metrics),
    claimViewport: () => true,
    releaseViewport: () => undefined,
    preferSourceQuality: (_id: string, q: number | null) => void quality.push(q),
    dispatchInput: async () => undefined
  } as unknown as BrowserInstance
  const sink: ViewerSink = {
    sendControl: (message) => void controls.push(message),
    frameReady: () => true,
    sendFrame: (frame) => void frames.push(frame),
    onceReady: () => undefined,
    close: () => undefined
  }
  const cast = new CastViewer(sink, () => undefined, 'b1', undefined, { relayed: options.relayed === true, encoder: host })
  // A real JPEG header so the frame has a size: 0xFFD8, SOF0 at 780x1400.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0x0c, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
  const frame = (): void => {
    for (const listener of frameListeners) listener(jpeg, { deviceWidth: 390, deviceHeight: 700, revision: 1, pageScaleFactor: 1 })
  }
  return { cast, instance, enc, opened, controls, frames, offers, quality, frame }
}

describe('a viewer that can decode H.264 gets it, and one that cannot keeps JPEG', () => {
  it('takes a phone’s word that came before Chrome was up, and starts when it is', async () => {
    const v = viewerWith()
    v.cast.handleMessage({ t: 'codecs', h264: true })
    v.cast.attach(v.instance)
    await settle()
    expect(v.controls.find((c) => c.t === 'video')).toMatchObject({ codec: CAST_CODEC, scaleMax: 2 })
    expect(v.opened[0]).toMatchObject({ codec: CAST_CODEC, bitrate: 4_000_000, framerate: 30 })
    expect(v.quality).toEqual([90])
  })

  it('keeps JPEG going while the encoder sets up, then sends chunks instead', async () => {
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    v.frame()
    // The first chunk is not out yet: the phone still gets the JPEG.
    expect(v.frames).toHaveLength(1)
    expect(v.enc.calls).toHaveLength(1)
    v.enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    expect(v.controls.find((c) => c.t === 'vframe')).toMatchObject({ n: 1, key: true, w: 780, h: 1400 })
    v.frame()
    expect(v.frames).toHaveLength(1)
  })

  it('passes the phone’s acknowledgements and key asks to the encoder', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    v.frame()
    v.enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    v.cast.handleMessage({ t: 'vack', n: 1 })
    v.cast.handleMessage({ t: 'vkey' })
    expect(v.enc.calls).toHaveLength(1)
    vi.advanceTimersByTime(VIDEO_KEY_MIN_MS)
    expect(v.enc.calls).toHaveLength(2)
    expect(v.enc.calls[1].key).toBe(true)
  })

  it('goes back to JPEG, and says so, when the phone’s decoder gives up', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    v.frame()
    v.enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    v.cast.handleMessage({ t: 'codecs', h264: false })
    expect(v.controls.at(-1)).toMatchObject({ t: 'video', codec: null })
    expect(v.enc.closed()).toBe(true)
    v.frame()
    expect(v.frames.length).toBeGreaterThan(1)
    // And it does not start again on its own.
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    expect(v.opened).toHaveLength(1)
    quiet.mockRestore()
  })

  it('a hung encoder sends the viewer back to JPEG instead of leaving it on its last picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await vi.advanceTimersByTimeAsync(0)
    v.frame()
    // The encoder never answers.
    await vi.advanceTimersByTimeAsync(VIDEO_FIRST_ENCODE_TIMEOUT_MS)
    expect(v.controls.at(-1)).toMatchObject({ t: 'video', codec: null })
    quiet.mockRestore()
  })

  it('opens no more than the Mac will run: past that, a viewer keeps JPEG', async () => {
    const v = viewerWith()
    ;(v.cast as unknown as { options: { encoder: CastEncoderHost } }).options.encoder.open = () => null
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    expect(v.controls.some((c) => c.t === 'video')).toBe(false)
    v.frame()
    expect(v.frames).toHaveLength(1)
  })

  it('on the relay aims lower, and lets the picture be sharper than JPEG could', async () => {
    const v = viewerWith({ relayed: true })
    v.cast.attach(v.instance)
    expect(v.controls.find((c) => c.t === 'ready')).toMatchObject({ scaleMax: 1 })
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    expect(v.opened[0]).toMatchObject({ bitrate: 800_000 })
    expect(v.controls.find((c) => c.t === 'video')).toMatchObject({ scaleMax: 2 })
    v.cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 3 })
    expect(v.offers.at(-1)?.scale).toBe(2)
  })

  it('keeps JPEG where this Mac cannot encode, or the tuning turned it off, or the phone cannot decode', async () => {
    for (const setup of [() => viewerWith({ supported: false }), () => (tuning.value = { ...DEFAULT_TUNING, h264: false }, viewerWith())]) {
      const v = setup()
      v.cast.attach(v.instance)
      v.cast.handleMessage({ t: 'codecs', h264: true })
      await settle()
      expect(v.controls.some((c) => c.t === 'video')).toBe(false)
      v.frame()
      expect(v.frames).toHaveLength(1)
    }
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: false })
    await settle()
    expect(v.opened).toEqual([])
  })

  it('goes back to JPEG, and says so, when the encoder fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    v.frame()
    v.enc.calls[0].fail(new Error('VideoToolbox went away'))
    await settle()
    expect(v.controls.at(-1)).toMatchObject({ t: 'video', codec: null })
    expect(v.quality).toEqual([90, null])
    expect(v.enc.closed()).toBe(true)
    v.frame()
    expect(v.frames).toHaveLength(2)
    quiet.mockRestore()
  })

  it('lets its encoder go when it leaves', async () => {
    const v = viewerWith()
    v.cast.attach(v.instance)
    v.cast.handleMessage({ t: 'codecs', h264: true })
    await settle()
    v.cast.close()
    expect(v.enc.closed()).toBe(true)
    expect(v.quality).toEqual([90, null])
  })
})

function fakeDecoderKit() {
  const made: { init: VideoDecoderInit; configs: VideoDecoderConfig[]; chunks: EncodedVideoChunkInit[]; state: string }[] = []
  const createDecoder = (init: VideoDecoderInit): DecoderLike => {
    const entry = { init, configs: [] as VideoDecoderConfig[], chunks: [] as EncodedVideoChunkInit[], state: 'unconfigured' }
    made.push(entry)
    return {
      get state() {
        return entry.state
      },
      configure: (c) => {
        entry.configs.push(c)
        entry.state = 'configured'
      },
      decode: (chunk) => void entry.chunks.push(chunk as unknown as EncodedVideoChunkInit),
      close: () => void (entry.state = 'closed')
    }
  }
  const createChunk = (init: EncodedVideoChunkInit): EncodedVideoChunk => init as unknown as EncodedVideoChunk
  const output = (n: number): { closed: boolean } => {
    const frame = { timestamp: n, closed: false, close() { this.closed = true } }
    made.at(-1)?.init.output(frame as unknown as VideoFrame)
    return frame
  }
  return { made, createDecoder, createChunk, output }
}

const chunk = (n: number, key: boolean, over: Partial<{ w: number; h: number; codec: string; seq: number }> = {}) => ({
  seq: over.seq ?? n,
  n,
  key,
  codec: over.codec ?? CAST_CODEC,
  w: over.w ?? 780,
  h: over.h ?? 1400,
  data: 'AAAA'
})

function decoder() {
  const kit = fakeDecoderKit()
  const pictures: { seq: number; n: number }[] = []
  const acks: number[] = []
  let keys = 0
  let gaveUp = 0
  const clock = { now: 0 }
  const d = new CastVideoDecoder<{ revision: number }>({
    onPicture: (p) => void pictures.push({ seq: p.seq, n: p.n }),
    askKey: () => void (keys += 1),
    ack: (n) => void acks.push(n),
    giveUp: () => void (gaveUp += 1),
    createDecoder: kit.createDecoder,
    createChunk: kit.createChunk,
    now: () => clock.now
  })
  return { d, kit, pictures, acks, keys: () => keys, gaveUp: () => gaveUp, clock }
}

describe('the phone decodes every chunk, in order, or asks to start again', () => {
  it('waits for a key frame before decoding anything', () => {
    const { d, kit, acks, keys } = decoder()
    d.push(chunk(1, false), { revision: 1 })
    expect(kit.made).toHaveLength(0)
    expect(keys()).toBe(1)
    expect(acks).toEqual([1])
  })

  it('sets the decoder up at a key frame and hands each picture over with its frame', () => {
    const { d, kit, pictures, acks } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    d.push(chunk(2, false, { seq: 7 }), { revision: 1 })
    expect(kit.made[0].configs[0]).toMatchObject({ codec: CAST_CODEC, optimizeForLatency: true })
    expect(kit.made[0].chunks.map((c) => c.type)).toEqual(['key', 'delta'])
    kit.output(1)
    kit.output(2)
    expect(pictures).toEqual([{ seq: 1, n: 1 }, { seq: 7, n: 2 }])
    expect(acks).toEqual([1, 2])
  })

  it('a chunk missing breaks the chain: nothing is decoded until a key frame, asked for once', () => {
    const { d, kit, acks, keys } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    d.push(chunk(3, false), { revision: 1 })
    d.push(chunk(4, false), { revision: 1 })
    expect(kit.made[0].chunks).toHaveLength(1)
    expect(keys()).toBe(1)
    expect(acks).toEqual([3, 4])
    d.push(chunk(5, true), { revision: 1 })
    expect(kit.made[0].chunks).toHaveLength(2)
  })

  it('a decoder that fails gives up what it held and asks for a key frame', () => {
    const { d, kit, acks, keys } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    d.push(chunk(2, false), { revision: 1 })
    kit.made[0].init.error(new DOMException('bad stream'))
    expect(keys()).toBe(1)
    expect(acks.sort()).toEqual([1, 2])
    d.push(chunk(3, false), { revision: 1 })
    expect(kit.made).toHaveLength(1)
    d.push(chunk(4, true), { revision: 1 })
    expect(kit.made).toHaveLength(2)
  })

  it('asks again for a key frame once the last ask may have been lost', () => {
    const { d, keys, clock } = decoder()
    d.push(chunk(1, false), { revision: 1 })
    d.push(chunk(2, false), { revision: 1 })
    expect(keys()).toBe(1)
    clock.now += VIDEO_KEY_REASK_MS
    d.push(chunk(3, false), { revision: 1 })
    expect(keys()).toBe(2)
  })

  it('a browser whose decoder keeps failing gives up, once, and the view goes back to JPEG', () => {
    const { d, kit, gaveUp, pictures } = decoder()
    for (let i = 0; i < VIDEO_GIVE_UP_AFTER; i++) {
      d.push(chunk(i * 2 + 1, true), { revision: 1 })
      kit.made.at(-1)?.init.error(new DOMException('no decoder'))
    }
    expect(gaveUp()).toBe(1)
    d.push(chunk(99, true), { revision: 1 })
    expect(gaveUp()).toBe(1)
    expect(pictures).toEqual([])
  })

  it('one picture in between and the count of failures starts over', () => {
    const { d, kit, gaveUp } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    kit.made.at(-1)?.init.error(new DOMException('glitch'))
    d.push(chunk(2, true), { revision: 1 })
    kit.output(2)
    d.push(chunk(3, true, { w: 1170 }), { revision: 2 })
    kit.made.at(-1)?.init.error(new DOMException('glitch'))
    d.push(chunk(4, true), { revision: 2 })
    kit.made.at(-1)?.init.error(new DOMException('glitch'))
    expect(gaveUp()).toBe(0)
  })

  it('sets the decoder up again when the picture’s size changes', () => {
    const { d, kit } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    d.push(chunk(2, true, { w: 1170, h: 2100 }), { revision: 2 })
    expect(kit.made).toHaveLength(2)
    expect(kit.made[0].state).toBe('closed')
  })

  it('a picture that comes out after it closed is let go of, not handed over', () => {
    const { d, kit, pictures } = decoder()
    d.push(chunk(1, true), { revision: 1 })
    d.close()
    const frame = kit.output(1)
    expect(frame.closed).toBe(true)
    expect(pictures).toEqual([])
  })
})

/** A response whose writes are read back as server-sent events. */
function fakeResponse(): { response: http.ServerResponse; events: () => { event: string; data: string }[]; close: () => void } {
  const request = new http.IncomingMessage(new Socket())
  request.headers['accept-encoding'] = 'identity'
  const response = new http.ServerResponse(request)
  let text = ''
  response.write = ((piece: string) => {
    text += String(piece)
    return true
  }) as typeof response.write
  response.writeHead = (() => response) as unknown as typeof response.writeHead
  response.end = (() => response) as unknown as typeof response.end
  return {
    response,
    events: () => [...text.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: m[2] })),
    close: () => void response.emit('close')
  }
}

describe('on the relay every chunk goes, in order, and none is replayed', () => {
  it('sends chunks as their own event, never folding one into the next as it does pictures', () => {
    let deps!: LoopbackSocketDeps
    const upstream = { send: () => undefined, close: () => undefined, pause: () => undefined, resume: () => undefined } as unknown as LoopbackSocket
    const bridge = createSocketBridge({ dial: (d) => ((deps = d), upstream) })
    const line = fakeResponse()
    bridge.open('/api/browser/b1/stream', line.response, 'tok', { v: 2 })
    deps.onOpen()
    const vframe = (n: number): string => JSON.stringify({ t: 'vframe', seq: n, n, key: n === 1, codec: CAST_CODEC, w: 2, h: 2, data: 'AA' })
    deps.onMessage(vframe(1))
    deps.onMessage(vframe(2))
    deps.onMessage(vframe(3))
    const sent = line.events().filter((e) => e.event === 'v').map((e) => (JSON.parse(JSON.parse(e.data)) as { n: number }).n)
    expect(sent).toEqual([1, 2, 3])
    expect(line.events().some((e) => e.event === 'c' && e.data.includes('vframe'))).toBe(false)
  })
})

describe('the words on the wire', () => {
  it('reads a chunk, and refuses one that is not', () => {
    const ok = { t: 'vframe', seq: 4, n: 2, key: false, codec: CAST_CODEC, w: 780, h: 1400, data: 'AA', meta: { revision: 3, scrollY: 120, pageScaleFactor: 1 } }
    expect(parseStreamObject(ok)).toMatchObject({ kind: 'vframe', seq: 4, revision: 3, scrollY: 120, chunk: { n: 2, key: false, w: 780 } })
    expect(parseStreamObject({ ...ok, codec: 'vp09.00.10.08' })).toBeNull()
    expect(parseStreamObject({ ...ok, n: 0 })).toBeNull()
    expect(parseStreamObject({ ...ok, data: '' })).toBeNull()
    expect(readVideoChunk({ ...ok, w: 1.5 })).toBeNull()
    expect(isVideoChunk(JSON.stringify(ok))).toBe(true)
    expect(isVideoChunk('{"t":"frame","seq":1}')).toBe(false)
  })

  it('reads the switch to and from H.264', () => {
    expect(parseStreamObject({ t: 'video', codec: CAST_CODEC, scaleMax: 2 })).toEqual({ kind: 'video', codec: CAST_CODEC, scaleMax: 2 })
    expect(parseStreamObject({ t: 'video', codec: null })).toEqual({ kind: 'video', codec: null })
    expect(parseStreamObject({ t: 'video', codec: '<script>' })).toEqual({ kind: 'video', codec: null })
  })

  it('takes only well-formed words from a phone', () => {
    expect(sanitizeCodecs({ t: 'codecs', h264: true })).toEqual({ h264: true })
    expect(sanitizeCodecs({ t: 'codecs', h264: 'yes' })).toEqual({ h264: false })
    expect(sanitizeVideoAck({ t: 'vack', n: 5 })).toBe(5)
    expect(sanitizeVideoAck({ t: 'vack', n: -1 })).toBeNull()
    expect(sanitizeVideoAck({ t: 'vack', n: 1.5 })).toBeNull()
  })

  it('folds waiting acknowledgements into the newest one on a slow line', () => {
    const a = JSON.stringify({ t: 'vack', n: 3 })
    const b = JSON.stringify({ t: 'vack', n: 5 })
    expect(coalesceInput(a, b)).toBe(b)
    expect(coalesceInput(b, a)).toBe(b)
  })
})

describe('stats and tuning know about H.264', () => {
  const base = { t: 'stats', line: 'ws', windowMs: 5000, frames: 1, painted: 1, kbps: 1, frameKB: 1, paintP50: 1, paintP95: 1, inputP50: 0, inputP95: 0, inputs: 0, dpr: 3, scale: 2 }

  it('a report says its codec, and one from before H.264 was JPEG', () => {
    expect(sanitizeCastStats({ ...base, codec: 'h264' })?.codec).toBe('h264')
    expect(sanitizeCastStats(base)?.codec).toBe('jpeg')
    expect(sanitizeCastStats({ ...base, codec: 'av1' })?.codec).toBe('jpeg')
    const meter = new CastStatsMeter(0)
    meter.frame(1, 100, 1)
    expect(meter.report(5000, 'relay', 3, 2, 'h264')?.codec).toBe('h264')
  })

  it('H.264 is on by default, with its own bounded knobs', () => {
    expect(CAST_TUNING_DEFAULTS).toMatchObject({ h264: true, h264Kbps: 4000, relayH264Kbps: 800, h264SourceQuality: 90, relayVideoScaleMax: 2 })
    expect(parseCastTuning({ h264: false, h264Kbps: 1e9, relayH264Kbps: 1, h264SourceQuality: 200, relayVideoScaleMax: 9 })).toMatchObject({
      h264: false,
      h264Kbps: 20_000,
      relayH264Kbps: 200,
      h264SourceQuality: 95,
      relayVideoScaleMax: 3
    })
    expect(parseCastTuning({ h264: 'no' }).h264).toBe(true)
  })
})

describe('the encoder host', () => {
  /** A page that answers what the script would, and can be made to fail. */
  function fakePage() {
    const state = { dead: false, runs: [] as string[] }
    const page = {
      run: async <T,>(expression: string): Promise<T> => {
        state.runs.push(expression)
        if (state.dead) throw new Error('The encoder window is gone.')
        if (expression.startsWith('window.__castEncSupported')) return true as T
        if (expression.startsWith('window.__castEncEncode')) return { data: 'AAAA', key: true } as T
        return true as T
      }
    }
    return { page, state }
  }

  it('opens no more than CAST_ENCODER_MAX_SESSIONS at once, and one closed makes room', () => {
    const { page } = fakePage()
    const host = createCastEncoder(async () => page)
    const options = { codec: CAST_CODEC, bitrate: 1, framerate: 1 }
    const sessions = Array.from({ length: CAST_ENCODER_MAX_SESSIONS }, () => host.open(options))
    expect(sessions.every((s) => s !== null)).toBe(true)
    expect(host.open(options)).toBeNull()
    sessions[0]?.close()
    sessions[0]?.close()
    expect(host.open(options)).not.toBeNull()
    expect(host.open(options)).toBeNull()
  })

  it('a window that died is forgotten: the next viewer gets a new page, and the question is asked again', async () => {
    let pages = 0
    const first = fakePage()
    const second = fakePage()
    const host = createCastEncoder(async () => (++pages === 1 ? first.page : second.page))
    expect(await host.supported(CAST_CODEC, 10, 10)).toBe(true)
    const session = host.open({ codec: CAST_CODEC, bitrate: 1, framerate: 1 })
    first.state.dead = true
    await expect(session?.encode('AA', true, 0, { width: 2, height: 2 })).rejects.toThrow('gone')
    expect(await host.supported(CAST_CODEC, 10, 10)).toBe(true)
    expect(pages).toBe(2)
  })

  it('a failure to ask is not an answer', async () => {
    let fail = true
    const host = createCastEncoder(async () => {
      if (fail) throw new Error('no window yet')
      return fakePage().page
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await host.supported(CAST_CODEC, 10, 10)).toBe(false)
    fail = false
    expect(await host.supported(CAST_CODEC, 10, 10)).toBe(true)
    quiet.mockRestore()
  })

  it('builds every page call from numbers and JSON only', async () => {
    const { page, state } = fakePage()
    const host = createCastEncoder(async () => page)
    const session = host.open({ codec: CAST_CODEC, bitrate: 1, framerate: 1 })
    await session?.encode("'); alert(1); ('", true, 1.7, { width: 780.4, height: 1400 })
    const call = state.runs.find((r) => r.startsWith('window.__castEncEncode')) as string
    expect(call).toContain(JSON.stringify("'); alert(1); ('"))
    expect(call).toMatch(/, true, 2, 780, 1400\)$/)
  })
})

describe('a picture really another size in the same revision', () => {
  it('starts a new encode size (and so a key frame) rather than draw into the corner of the old', async () => {
    const { out, enc } = videoOut()
    out.offer(picture(1), CTX)
    enc.calls[0].answer({ data: 'AAAA', key: true })
    await settle()
    out.offer({ ...picture(2), size: { width: 390, height: 700 } }, CTX)
    expect(enc.calls[1].size).toEqual({ width: 390, height: 700 })
  })
})

describe('an H.264 viewer’s `same` on the relay', () => {
  it('goes as an unnumbered beat, not into the ring a returning phone replays', () => {
    let deps!: LoopbackSocketDeps
    const upstream = { send: () => undefined, close: () => undefined, pause: () => undefined, resume: () => undefined } as unknown as LoopbackSocket
    const bridge = createSocketBridge({ dial: (d) => ((deps = d), upstream) })
    const line = fakeResponse()
    bridge.open('/api/browser/b1/stream', line.response, 'tok', { v: 2 })
    deps.onOpen()
    deps.onMessage(JSON.stringify({ t: 'same', seq: 9, revision: 2 }))
    const events = line.events()
    expect(events.find((e) => e.event === 'b')?.data).toContain('"seq":9')
    expect(events.some((e) => e.event === 'c')).toBe(false)
  })
})
