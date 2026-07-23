import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFramePoller,
  fitContain,
  frameSrc,
  shouldPollFrame
} from '../src/renderer/src/browser-frame'

describe('shouldPollFrame (poll only while open + visible)', () => {
  it('polls when open and the document is visible', () => {
    expect(shouldPollFrame({ open: true, hidden: false })).toBe(true)
  })
  it('stops when the view is closed/occluded', () => {
    expect(shouldPollFrame({ open: false, hidden: false })).toBe(false)
  })
  it('stops when the document is hidden (app backgrounded)', () => {
    expect(shouldPollFrame({ open: true, hidden: true })).toBe(false)
  })
})

describe('frameSrc (cache-busted live-frame URL)', () => {
  it('targets the thumb endpoint with a monotonic buster', () => {
    expect(frameSrc('b1', 0)).toBe('/api/browser/b1/thumb?f=0')
    expect(frameSrc('b1', 7)).toBe('/api/browser/b1/thumb?f=7')
  })
  it('a new seq → a different URL so the <img> refetches', () => {
    expect(frameSrc('b1', 1)).not.toBe(frameSrc('b1', 2))
  })
  it('encodes the browser id', () => {
    expect(frameSrc('a/b', 0)).toBe('/api/browser/a%2Fb/thumb?f=0')
  })
})

describe('fitContain (letterbox fit, centered, aspect preserved)', () => {
  it('a frame WIDER than the view letterboxes top/bottom', () => {
    // 800×400 frame into a 400×400 view → scale 0.5 → 400×200, centered vertically.
    expect(fitContain(800, 400, 400, 400)).toEqual({ width: 400, height: 200, left: 0, top: 100 })
  })
  it('a frame TALLER than the view letterboxes left/right', () => {
    // 400×800 into 400×400 → scale 0.5 → 200×400, centered horizontally.
    expect(fitContain(400, 800, 400, 400)).toEqual({ width: 200, height: 400, left: 100, top: 0 })
  })
  it('same aspect fills exactly, no letterbox', () => {
    expect(fitContain(1000, 500, 400, 200)).toEqual({ width: 400, height: 200, left: 0, top: 0 })
  })
  it('degenerate (unmeasured view / no frame) → zero rect', () => {
    expect(fitContain(0, 400, 400, 400)).toEqual({ width: 0, height: 0, left: 0, top: 0 })
    expect(fitContain(800, 400, 0, 400)).toEqual({ width: 0, height: 0, left: 0, top: 0 })
  })
})

describe('createFramePoller (interval lifecycle, fake timers)', () => {
  afterEach(() => vi.useRealTimers())
  it('ticks once per interval while started', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const p = createFramePoller(tick, 1000)
    p.start()
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(3)
  })
  it('start is idempotent — never stacks intervals', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const p = createFramePoller(tick, 1000)
    p.start()
    p.start() // second start must not double the cadence
    vi.advanceTimersByTime(2000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
  it('stop halts ticks; restart resumes', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const p = createFramePoller(tick, 1000)
    p.start()
    vi.advanceTimersByTime(1000)
    p.stop()
    vi.advanceTimersByTime(5000)
    expect(tick).toHaveBeenCalledTimes(1)
    p.start()
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
