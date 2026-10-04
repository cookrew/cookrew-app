import { describe, expect, it, vi } from 'vitest'
import { BrowserThumbCache } from '../src/main/browser-thumb-cache'
import { batchFrames } from '../src/main/browser-thumb-batch'

const b64 = (text: string): string => Buffer.from(text).toString('base64')

/** A clock the test drives, so freshness is asserted, not slept through. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => void (t += ms) }
}

describe('BrowserThumbCache', () => {
  it('stores a legacy renderer frame pushed as a png data url', () => {
    const cache = new BrowserThumbCache({})
    cache.putDataUrl('b1', `data:image/png;base64,${b64('shot')}`)
    const frame = cache.frame('b1')
    expect(frame?.type).toBe('image/png')
    expect(frame?.data.toString()).toBe('shot')
  })

  it('keeps the jpeg type of a headless frame, so /thumb cannot mislabel it', () => {
    const cache = new BrowserThumbCache({})
    cache.putDataUrl('b1', `data:image/jpeg;base64,${b64('shot')}`)
    expect(cache.frame('b1')?.type).toBe('image/jpeg')
  })

  it('ignores a push that is not an image data url', () => {
    const cache = new BrowserThumbCache({})
    cache.putDataUrl('b1', 'javascript:alert(1)')
    cache.putDataUrl('b1', 'data:text/html;base64,' + b64('<b>'))
    cache.putDataUrl('b1', 'data:image/png;base64,')
    expect(cache.frame('b1')).toBeUndefined()
  })

  it('round-trips a frame back to a data url for the renderer', () => {
    const cache = new BrowserThumbCache({})
    cache.put('b1', b64('shot'), 'image/jpeg')
    expect(cache.dataUrl('b1')).toBe(`data:image/jpeg;base64,${b64('shot')}`)
    expect(cache.dataUrl('missing')).toBeNull()
  })

  it('captures on demand when nothing has been pushed — the phone-only case', async () => {
    const capture = vi.fn(async () => b64('fresh'))
    const cache = new BrowserThumbCache({ capture })
    await cache.refresh('b1')
    expect(capture).toHaveBeenCalledWith('b1')
    expect(cache.frame('b1')?.data.toString()).toBe('fresh')
    expect(cache.frame('b1')?.type).toBe('image/jpeg')
  })

  it('serves a fresh frame without spending a screenshot', async () => {
    const time = clock()
    const capture = vi.fn(async () => b64('fresh'))
    const cache = new BrowserThumbCache({ capture, now: time.now, freshMs: 3000 })
    await cache.refresh('b1')
    time.advance(2999)
    await cache.refresh('b1')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('recaptures once the frame ages out', async () => {
    const time = clock()
    let n = 0
    const capture = vi.fn(async () => b64(`shot${++n}`))
    const cache = new BrowserThumbCache({ capture, now: time.now, freshMs: 3000 })
    await cache.refresh('b1')
    time.advance(3001)
    await cache.refresh('b1')
    expect(capture).toHaveBeenCalledTimes(2)
    expect(cache.frame('b1')?.data.toString()).toBe('shot2')
  })

  it('coalesces concurrent pollers into one screenshot', async () => {
    const capture = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(b64('fresh')), 5))
    )
    const cache = new BrowserThumbCache({ capture })
    await Promise.all([cache.refresh('b1'), cache.refresh('b1'), cache.refresh('b1')])
    expect(capture).toHaveBeenCalledTimes(1)
    expect(cache.frame('b1')?.data.toString()).toBe('fresh')
  })

  it('keeps the last picture when a capture returns nothing', async () => {
    const time = clock()
    const capture = vi.fn(async () => null)
    const cache = new BrowserThumbCache({ capture, now: time.now, freshMs: 1000 })
    cache.put('b1', b64('old'), 'image/jpeg')
    time.advance(5000)
    await cache.refresh('b1')
    expect(cache.frame('b1')?.data.toString()).toBe('old')
  })

  it('survives a capture that throws, and retries on the next poll', async () => {
    const time = clock()
    const capture = vi.fn(async () => {
      throw new Error('cdp is gone')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = new BrowserThumbCache({ capture, now: time.now, freshMs: 1000 })
    await expect(cache.refresh('b1')).resolves.toBeUndefined()
    time.advance(5000)
    await cache.refresh('b1')
    expect(capture).toHaveBeenCalledTimes(2)
    errors.mockRestore()
  })

  it('does nothing when there is no headless capturer at all', async () => {
    const cache = new BrowserThumbCache({})
    await expect(cache.refresh('b1')).resolves.toBeUndefined()
    expect(cache.frame('b1')).toBeUndefined()
  })

  it('forgets a closed browser', () => {
    const cache = new BrowserThumbCache({})
    cache.put('b1', b64('shot'), 'image/png')
    cache.forget('b1')
    expect(cache.frame('b1')).toBeUndefined()
  })
})

/**
 * THE VERSION IS THE PICTURE, NOT THE CLOCK.
 *
 * `at` is what the phone sends back as `known=` and what the batch compares
 * with `===` to answer "unchanged" with a number instead of the bytes. It was
 * stamped on EVERY capture — and a poll triggers a capture — so an idle page's
 * `at` moved every five seconds, the phone's known version never matched, and
 * the same 65 KB frame crossed the relay every tick for as long as the card
 * was on screen (relay traffic report, 2026-09-18). The freshness window
 * still needs to know when the last capture HAPPENED; that is a different
 * fact and now has its own field.
 */
describe('the version follows the pixels', () => {
  it('keeps `at` when a recapture returns the same bytes', async () => {
    const t = clock()
    const cache = new BrowserThumbCache({ capture: async () => b64('same'), now: t.now, freshMs: 3000 })
    await cache.refresh('b1')
    const first = cache.frame('b1')!
    t.advance(5000)
    await cache.refresh('b1')
    const second = cache.frame('b1')!
    expect(second.at).toBe(first.at)
    expect(second.capturedAt).toBeGreaterThan(first.capturedAt)
  })

  it('moves `at` when the bytes change', async () => {
    const t = clock()
    let shot = 'one'
    const cache = new BrowserThumbCache({ capture: async () => b64(shot), now: t.now, freshMs: 3000 })
    await cache.refresh('b1')
    const first = cache.frame('b1')!.at
    shot = 'two'
    t.advance(5000)
    await cache.refresh('b1')
    expect(cache.frame('b1')!.at).toBeGreaterThan(first)
  })

  it('the freshness window still reads the capture time, so an idle page is not re-shot every poll inside it', async () => {
    const t = clock()
    const capture = vi.fn(async () => b64('same'))
    const cache = new BrowserThumbCache({ capture, now: t.now, freshMs: 3000 })
    await cache.refresh('b1')
    t.advance(5000)
    await cache.refresh('b1') // aged out → one more shot, same bytes
    t.advance(1000)
    await cache.refresh('b1') // inside the window of the LAST shot → none
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('end to end: a second poll of an unchanged page carries a number and no bytes', async () => {
    const t = clock()
    const cache = new BrowserThumbCache({ capture: async () => b64('page'), now: t.now, freshMs: 3000 })
    await cache.refresh('b1')
    const lookup = (id: string) => cache.frame(id)
    const first = batchFrames(['b1'], {}, lookup)[0]
    expect(first.data).toBeDefined()
    t.advance(5000)
    await cache.refresh('b1')
    const second = batchFrames(['b1'], { b1: first.at as number }, lookup)[0]
    expect(second).toEqual({ id: 'b1', at: first.at })
  })

  it('a pushed legacy frame with the same bytes keeps its version too', () => {
    const t = clock()
    const cache = new BrowserThumbCache({ now: t.now })
    cache.putDataUrl('b1', `data:image/png;base64,${b64('shot')}`)
    const at = cache.frame('b1')!.at
    t.advance(5000)
    cache.putDataUrl('b1', `data:image/png;base64,${b64('shot')}`)
    expect(cache.frame('b1')!.at).toBe(at)
  })
})
