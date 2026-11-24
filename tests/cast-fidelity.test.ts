import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tuning = vi.hoisted(() => ({ value: { scaleMax: 2, relayScaleMax: 1, quality: 60 } }))
vi.mock('../src/main/cast-tuning', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/cast-tuning')>()
  return { ...real, castTuning: () => tuning.value }
})

import { CastViewer, STATS_MIN_INTERVAL_MS, type ViewerSink } from '../src/main/cast-viewer'
import type { BrowserInstance } from '../src/main/browser-instance'
import type { CastStatsEntry } from '../src/main/cast-stats-log'
import { appendCastStats, LOG_MAX_BYTES } from '../src/main/cast-stats-log'
import { CAST_TUNING_DEFAULTS, parseCastTuning } from '../src/main/cast-tuning'
import { CAST_SCALE_CEILING, headlessLaunchArgs } from '../src/main/headless-chrome'
import { budgetScale, capViewportScale, viewportScale, VIEWPORT_PIXEL_BUDGET } from '../src/shared/cast-viewport'
import { sanitizeCastStats } from '../src/shared/cast-stats'
import { CastStatsMeter, frameByteSize, percentile } from '../src/renderer/src/cast-stats-meter'
import { parseStreamObject, viewScale, viewportControlMsg } from '../src/renderer/src/browser-stream'

beforeEach(() => {
  tuning.value = { scaleMax: 2, relayScaleMax: 1, quality: 60 }
})

const report = {
  t: 'stats',
  line: 'ws',
  windowMs: 5000,
  frames: 40,
  painted: 39,
  kbps: 900,
  frameKB: 112,
  paintP50: 12,
  paintP95: 30,
  inputP50: 90,
  inputP95: 180,
  inputs: 12,
  dpr: 3,
  scale: 2
}

function viewer(options: { scaleCeiling?: number; relayed?: boolean } = {}) {
  const offers: { width: number; height: number; mobile: boolean; scale?: number }[] = []
  const controls: Record<string, unknown>[] = []
  const entries: CastStatsEntry[] = []
  const frameListeners = new Set<(data: string, meta: Record<string, unknown>) => void>()
  const instance = {
    viewportState: { width: 390, height: 700, mobile: true, revision: 1, transitioning: false, agentHeld: false, ownerId: null, viewerCount: 1 },
    frameListeners,
    ...(options.scaleCeiling !== undefined ? { scaleCeiling: options.scaleCeiling, frameQualityInUse: 60 } : {}),
    registerViewportViewer: () => undefined,
    unregisterViewportViewer: () => undefined,
    onViewportState: () => () => undefined,
    offerViewport: (_id: string, metrics: (typeof offers)[number]) => void offers.push(metrics),
    claimViewport: (_id: string, metrics: (typeof offers)[number]) => (offers.push(metrics), true),
    releaseViewport: () => undefined,
    dispatchInput: async () => undefined
  } as unknown as BrowserInstance
  const sink: ViewerSink = {
    sendControl: (message) => void controls.push(message),
    frameReady: () => true,
    sendFrame: () => undefined,
    onceReady: () => undefined,
    close: () => undefined
  }
  const cast = new CastViewer(sink, () => undefined, 'b1', undefined, {
    relayed: options.relayed === true,
    report: (entry: CastStatsEntry) => void entries.push(entry)
  })
  cast.attach(instance)
  const frame = (): void => {
    for (const listener of frameListeners) listener('QUJD', { deviceWidth: 390, deviceHeight: 700, revision: 1, pageScaleFactor: 1 })
  }
  return { cast, offers, controls, entries, frame }
}

describe('card Chrome streams at each viewer’s own scale (measured on Chrome 158, 11-24)', () => {
  it('is launched with its scale forced to the most any viewer may ask', () => {
    const args = headlessLaunchArgs('/profiles/b1', 720, 560, 'https://example.test')
    expect(args).toContain(`--force-device-scale-factor=${CAST_SCALE_CEILING}`)
    expect(CAST_SCALE_CEILING).toBe(3)
    expect(args.at(-1)).toBe('https://example.test')
  })
})

describe('the wire carries a scale up to 3, and a viewer gets only what it is allowed', () => {
  it('bounds a scale to half steps in [1, 3]', () => {
    expect(viewportScale(3)).toBe(3)
    expect(viewportScale(4)).toBe(3)
    expect(viewportScale(2.6)).toBe(2.5)
    expect(viewportScale(3, 2)).toBe(2)
    expect(viewportScale(3, Number.NaN)).toBe(1)
  })

  it('holds metrics to a cap, dropping a scale that comes to 1', () => {
    expect(capViewportScale({ width: 390, height: 700, mobile: true, scale: 3 }, 2)).toEqual({ width: 390, height: 700, mobile: true, scale: 2 })
    expect(capViewportScale({ width: 390, height: 700, mobile: true, scale: 3 }, 1)).toEqual({ width: 390, height: 700, mobile: true })
    expect(capViewportScale({ width: 390, height: 700, mobile: true }, 3)).toEqual({ width: 390, height: 700, mobile: true })
  })

  it('holds a big viewport under the pixel budget, whatever scale it may have', () => {
    // A phone's whole screen at 3x fits; a 2048-wide window at 2x does not.
    expect(capViewportScale({ width: 430, height: 932, mobile: true, scale: 3 }, 3).scale).toBe(3)
    expect(budgetScale(1600, 1000)).toBe(1.5)
    expect(capViewportScale({ width: 2048, height: 1536, mobile: false, scale: 2 }, 3)).toEqual({ width: 2048, height: 1536, mobile: false })
    expect(budgetScale(0, 700)).toBe(1)
    for (const [w, h] of [[390, 700], [1600, 1000], [1024, 1366], [2048, 2048]]) {
      const scale = capViewportScale({ width: w, height: h, mobile: false, scale: 3 }, 3).scale ?? 1
      expect(scale === 1 || w * h * scale * scale <= VIEWPORT_PIXEL_BUDGET).toBe(true)
    }
  })
})

describe('the Mac says how sharp a viewer may be, and holds it to that', () => {
  it('offers a phone the tuning’s scale when its Chrome can stream it', () => {
    const { controls } = viewer({ scaleCeiling: 3 })
    expect(controls.find((c) => c.t === 'ready')).toMatchObject({ scaleMax: 2 })
  })

  it('offers 1 where the instance cannot stream a scale (a device screen)', () => {
    const { controls } = viewer()
    expect(controls.find((c) => c.t === 'ready')).toMatchObject({ scaleMax: 1 })
  })

  it('holds an ask above the cap to the cap, whatever the viewer sent', () => {
    const { cast, offers } = viewer({ scaleCeiling: 3 })
    cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 3 })
    cast.handleMessage({ t: 'viewport-claim', width: 390, height: 700, mobile: true, scale: 3 })
    expect(offers.map((o) => o.scale)).toEqual([2, 2])
  })

  it('lets a tuning of 3 through to a Chrome that streams 3', () => {
    tuning.value = { scaleMax: 3, relayScaleMax: 1, quality: 60 }
    const { cast, offers } = viewer({ scaleCeiling: 3 })
    cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 3 })
    expect(offers[0].scale).toBe(3)
  })

  it('keeps a viewer on the relay at the relay’s scale', () => {
    const { cast, offers, controls } = viewer({ scaleCeiling: 3, relayed: true })
    expect(controls.find((c) => c.t === 'ready')).toMatchObject({ scaleMax: 1 })
    cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 3 })
    expect(offers[0]).not.toHaveProperty('scale')
  })

  it('holds a viewer already watching to a tuning lowered since it arrived', () => {
    const { cast, offers } = viewer({ scaleCeiling: 3 })
    tuning.value = { scaleMax: 1, relayScaleMax: 1, quality: 60 }
    cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 2 })
    expect(offers[0]).not.toHaveProperty('scale')
  })
})

describe('a phone’s live-view report is written down beside what the Mac sent', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records the phone’s numbers, the Mac’s frames and the tuning in force', () => {
    vi.useFakeTimers()
    const { cast, entries, frame } = viewer({ scaleCeiling: 3 })
    frame()
    frame()
    vi.advanceTimersByTime(5000)
    cast.handleMessage(report)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ browserId: 'b1', relayed: false, inUse: { scaleMax: 2, quality: 60 }, phone: { line: 'ws', inputP50: 90 } })
    expect(entries[0].sent.frames).toBe(2)
  })

  it('logs the quality the stream runs at, not what the file says since', () => {
    vi.useFakeTimers()
    const { cast, entries } = viewer({ scaleCeiling: 3 })
    tuning.value = { scaleMax: 2, relayScaleMax: 1, quality: 85 }
    vi.advanceTimersByTime(5000)
    cast.handleMessage(report)
    expect(entries[0].inUse.quality).toBe(60)
  })

  it('takes no more than one report per interval', () => {
    vi.useFakeTimers()
    const { cast, entries } = viewer({ scaleCeiling: 3 })
    vi.advanceTimersByTime(STATS_MIN_INTERVAL_MS)
    cast.handleMessage(report)
    cast.handleMessage(report)
    expect(entries).toHaveLength(1)
  })

  it('drops a report that is not the shape, and never treats it as input', () => {
    vi.useFakeTimers()
    const { cast, entries } = viewer({ scaleCeiling: 3 })
    vi.advanceTimersByTime(5000)
    cast.handleMessage({ ...report, line: 'carrier-pigeon' })
    cast.handleMessage({ ...report, kbps: -1 })
    cast.handleMessage({ ...report, frames: 'many' })
    expect(entries).toEqual([])
  })
})

describe('a stats message carries numbers only, bounded', () => {
  it('keeps a well-formed report and drops extra fields', () => {
    const clean = sanitizeCastStats({ ...report, url: 'https://secret.test', text: 'typed' })
    expect(clean).not.toBeNull()
    expect(clean).not.toHaveProperty('url')
    expect(clean).not.toHaveProperty('text')
  })

  it('bounds runaway numbers', () => {
    expect(sanitizeCastStats({ ...report, paintP95: 1e12 })?.paintP95).toBe(120_000)
  })
})

describe('the tuning file’s two knobs', () => {
  it('bounds each field and falls back on its own', () => {
    expect(parseCastTuning({ scaleMax: 9, relayScaleMax: 0, quality: 10 })).toMatchObject({ scaleMax: 3, relayScaleMax: 1, quality: 30 })
    expect(parseCastTuning({ scaleMax: 2.6 })).toEqual({ ...CAST_TUNING_DEFAULTS, scaleMax: 2.5 })
    expect(parseCastTuning({ relayScaleMax: 2 })).toEqual({ ...CAST_TUNING_DEFAULTS, relayScaleMax: 2 })
    expect(parseCastTuning('nonsense')).toEqual(CAST_TUNING_DEFAULTS)
    expect(parseCastTuning({ quality: '80' })).toEqual(CAST_TUNING_DEFAULTS)
  })

  it('defaults to 2x, the relay to 1x, at quality 60', () => {
    expect(CAST_TUNING_DEFAULTS).toMatchObject({ scaleMax: 2, relayScaleMax: 1, quality: 60 })
  })
})

describe('the real tuning reader follows the file', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cast-tuning-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads defaults with no file, the file once written, and again when it changes', async () => {
    const real = await vi.importActual<typeof import('../src/main/cast-tuning')>('../src/main/cast-tuning')
    const file = path.join(dir, 'cast-tuning.json')
    expect(real.castTuning(file)).toEqual(CAST_TUNING_DEFAULTS)
    writeFileSync(file, JSON.stringify({ scaleMax: 3, quality: 80 }))
    expect(real.castTuning(file)).toMatchObject({ scaleMax: 3, relayScaleMax: 1, quality: 80 })
    writeFileSync(file, JSON.stringify({ scaleMax: 1 }))
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    expect(real.castTuning(file)).toMatchObject({ scaleMax: 1, relayScaleMax: 1, quality: 60 })
  })

  it('reads defaults from a file that is not JSON', async () => {
    const real = await vi.importActual<typeof import('../src/main/cast-tuning')>('../src/main/cast-tuning')
    const file = path.join(dir, 'broken.json')
    writeFileSync(file, '{ scaleMax: ')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(real.castTuning(file)).toEqual(CAST_TUNING_DEFAULTS)
    quiet.mockRestore()
  })
})

describe('the stats log stays small', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cast-stats-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const entry = (): CastStatsEntry => ({
    at: '2026-11-24T00:00:00.000Z',
    browserId: 'b1',
    viewer: 'k',
    relayed: false,
    phone: sanitizeCastStats(report)!,
    sent: { frames: 1, kbps: 1, width: 780, height: 1400 },
    inUse: { scaleMax: 2, quality: 60 }
  })

  it('appends one JSON line per report', () => {
    const file = path.join(dir, 'logs', 'cast-stats.jsonl')
    appendCastStats(entry(), file)
    appendCastStats(entry(), file)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).sent.width).toBe(780)
  })

  it('moves a full log aside and starts again', () => {
    const file = path.join(dir, 'cast-stats.jsonl')
    writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES + 1))
    appendCastStats(entry(), file)
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

describe('the phone asks for its own sharpness, within what the Mac allows', () => {
  it('asks its pixel ratio up to the allowed scale', () => {
    expect(viewScale(3, 2)).toBe(2)
    expect(viewScale(3, 3)).toBe(3)
    expect(viewScale(3, 1)).toBe(1)
    expect(viewScale(2.6, 3)).toBe(2.5)
    expect(viewScale(3)).toBe(2)
  })

  it('puts the ask in the offer', () => {
    expect(viewportControlMsg('offer', { width: 390, height: 700 }, true, 3, 2)).toEqual({
      t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 2
    })
    expect(viewportControlMsg('offer', { width: 390, height: 700 }, true, 3, 1)).toEqual({
      t: 'viewport-offer', width: 390, height: 700, mobile: true
    })
  })

  it('reads the allowed scale from ready, bounded, and nothing from a Mac that never said', () => {
    expect(parseStreamObject({ t: 'ready', w: 390, h: 700, revision: 1, mobile: true, scaleMax: 2 })).toMatchObject({ scaleMax: 2 })
    expect(parseStreamObject({ t: 'ready', w: 390, h: 700, revision: 1, mobile: true, scaleMax: 9 })).toMatchObject({ scaleMax: 3 })
    expect(parseStreamObject({ t: 'ready', w: 390, h: 700, revision: 1, mobile: true })).not.toHaveProperty('scaleMax')
  })
})

describe('the phone’s meter', () => {
  it('measures arrival to paint, and input to the next frame drawn after it', () => {
    const meter = new CastStatsMeter(0)
    meter.frame(1, 2048, 100)
    meter.paint(1, 110)
    meter.input(200)
    meter.input(210)
    meter.frame(2, 2048, 190)
    meter.paint(2, 205)
    meter.frame(3, 2048, 260)
    meter.paint(3, 280)
    const r = meter.report(5000, 'relay', 3, 2)
    expect(r).toMatchObject({ t: 'stats', line: 'relay', frames: 3, painted: 3, inputs: 2, inputP50: 80, dpr: 3, scale: 2 })
    expect(r?.paintP50).toBe(15)
    expect(r?.frameKB).toBe(2)
    expect(r?.kbps).toBeCloseTo(1.2, 1)
    expect(sanitizeCastStats(r)).not.toBeNull()
  })

  it('starts over after each report, and reports nothing for a quiet stretch', () => {
    const meter = new CastStatsMeter(0)
    meter.frame(1, 10, 1)
    meter.paint(1, 2)
    expect(meter.report(5000, 'ws', 2, 2)).not.toBeNull()
    expect(meter.report(10_000, 'ws', 2, 2)).toBeNull()
  })

  it('ignores a paint it never saw arrive', () => {
    const meter = new CastStatsMeter(0)
    meter.frame(1, 10, 1)
    meter.paint(99, 5)
    expect(meter.report(5000, 'ws', 1, 1)?.painted).toBe(0)
  })

  it('reads a frame’s size from bytes or a data URL', () => {
    expect(frameByteSize({ bytes: new Uint8Array(300) })).toBe(300)
    expect(frameByteSize({ src: 'data:image/jpeg;base64,QUJDRA==' })).toBe(6)
    expect(frameByteSize({})).toBe(0)
  })

  it('takes percentiles of what it has', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100)
  })
})
