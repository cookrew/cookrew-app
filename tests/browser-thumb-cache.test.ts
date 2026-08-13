import { describe, expect, it, vi } from 'vitest'
import { BrowserThumbCache } from '../src/main/browser-thumb-cache'

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
