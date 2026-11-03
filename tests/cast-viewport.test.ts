import { describe, expect, it } from 'vitest'
import { sanitizeViewportMessage, viewportScale, VIEWPORT_MAX, VIEWPORT_MIN } from '../src/shared/cast-viewport'

describe('sanitizeViewportMessage (unauth LAN security boundary)', () => {
  it('accepts only the closed offer/claim/release vocabulary', () => {
    expect(
      sanitizeViewportMessage({
        t: 'viewport-offer',
        width: 390,
        height: 700,
        mobile: true,
        method: 'Emulation.setDeviceMetricsOverride'
      })
    ).toEqual({ type: 'offer', metrics: { width: 390, height: 700, mobile: true } })
    expect(
      sanitizeViewportMessage({ t: 'viewport-claim', width: 1200, height: 800, mobile: false })
    ).toEqual({ type: 'claim', metrics: { width: 1200, height: 800, mobile: false } })
    expect(sanitizeViewportMessage({ t: 'viewport-release' })).toEqual({ type: 'release' })
  })

  it('clamps dimensions and pathological aspect ratios', () => {
    const result = sanitizeViewportMessage({
      t: 'viewport-claim',
      width: 1,
      height: 100_000,
      mobile: true
    })
    expect(result).toEqual({
      type: 'claim',
      metrics: { width: VIEWPORT_MIN, height: 800, mobile: true }
    })
    const wide = sanitizeViewportMessage({
      t: 'viewport-offer',
      width: 100_000,
      height: 1,
      mobile: false
    })
    expect(wide).toEqual({
      type: 'offer',
      metrics: { width: 800, height: VIEWPORT_MIN, mobile: false }
    })
    expect(VIEWPORT_MAX).toBe(2048)
  })

  it('rejects malformed metrics and raw CDP/Emulation shapes', () => {
    expect(sanitizeViewportMessage({ t: 'viewport-offer', width: NaN, height: 700, mobile: true })).toBeNull()
    expect(sanitizeViewportMessage({ t: 'viewport-claim', width: '390', height: 700, mobile: true })).toBeNull()
    expect(sanitizeViewportMessage({ t: 'viewport-claim', width: 390, height: 700, mobile: 'true' })).toBeNull()
    expect(
      sanitizeViewportMessage({
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 1, height: 1, mobile: true }
      })
    ).toBeNull()
  })
})

describe('a viewer’s device scale (crisp on a Retina desktop, bounded for everyone)', () => {
  it('passes a 2x ask through, and leaves a 1x ask (the phone’s) out of the metrics', () => {
    expect(sanitizeViewportMessage({ t: 'viewport-offer', width: 800, height: 600, mobile: false, scale: 2 })).toEqual({
      type: 'offer',
      metrics: { width: 800, height: 600, mobile: false, scale: 2 }
    })
    expect(sanitizeViewportMessage({ t: 'viewport-offer', width: 800, height: 600, mobile: false, scale: 1 })).toEqual({
      type: 'offer',
      metrics: { width: 800, height: 600, mobile: false }
    })
  })
  it('clamps to [1, 2] in half steps; junk is 1', () => {
    expect(viewportScale(3)).toBe(2)
    expect(viewportScale(1.3)).toBe(1.5)
    expect(viewportScale(0.5)).toBe(1)
    expect(viewportScale('2')).toBe(1)
    expect(viewportScale(Number.NaN)).toBe(1)
    expect(viewportScale(undefined)).toBe(1)
  })
})
