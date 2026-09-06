import { describe, expect, it, vi } from 'vitest'
import { WARMUP_FALLBACK_MS, scheduleWebglWarmup, warmWebgl } from '../src/renderer/src/gpu-warmup'

describe('warmWebgl — a throwaway first context, released at once', () => {
  it('reports false and does not throw where WebGL is unavailable', () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document
    expect(warmWebgl(doc)).toBe(false)
  })

  it('creates one context and loses it immediately', () => {
    const loseContext = vi.fn()
    const getContext = vi.fn((_kind: string) => ({ getExtension: () => ({ loseContext }) }))
    const doc = { createElement: () => ({ getContext }) } as unknown as Document
    expect(warmWebgl(doc)).toBe(true)
    expect(getContext).toHaveBeenCalledTimes(1)
    expect(getContext.mock.calls[0][0]).toBe('webgl2')
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('falls back to webgl1 when webgl2 is refused', () => {
    const getContext = vi.fn((kind: string) => (kind === 'webgl2' ? null : { getExtension: () => null }))
    const doc = { createElement: () => ({ getContext }) } as unknown as Document
    expect(warmWebgl(doc)).toBe(true)
    expect(getContext.mock.calls.map((c) => c[0])).toEqual(['webgl2', 'webgl'])
  })

  it('swallows a throwing getContext — warm-up must never break boot', () => {
    const doc = {
      createElement: () => ({
        getContext: () => {
          throw new Error('no gpu')
        }
      })
    } as unknown as Document
    expect(warmWebgl(doc)).toBe(false)
  })
})

describe('scheduleWebglWarmup — at idle, bounded, never on the boot path', () => {
  it('uses requestIdleCallback with a timeout so a busy first paint cannot starve it', () => {
    const warm = vi.fn(() => true)
    const requestIdleCallback = vi.fn((cb: () => void, _opts?: { timeout: number }) => {
      cb()
      return 1
    })
    scheduleWebglWarmup({ requestIdleCallback, setTimeout: vi.fn() }, warm)
    expect(requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(requestIdleCallback.mock.calls[0][1]).toEqual({ timeout: WARMUP_FALLBACK_MS })
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('falls back to a timer where requestIdleCallback is missing (WebKit)', () => {
    const warm = vi.fn(() => true)
    const setTimeout = vi.fn((cb: () => void, _ms: number) => cb())
    scheduleWebglWarmup({ setTimeout }, warm)
    expect(setTimeout).toHaveBeenCalledTimes(1)
    expect(setTimeout.mock.calls[0][1]).toBe(WARMUP_FALLBACK_MS)
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('does not warm synchronously', () => {
    const warm = vi.fn(() => true)
    scheduleWebglWarmup({ requestIdleCallback: vi.fn(() => 1), setTimeout: vi.fn() }, warm)
    expect(warm).not.toHaveBeenCalled()
  })
})
