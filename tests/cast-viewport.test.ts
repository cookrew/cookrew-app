import { describe, expect, it } from 'vitest'
import { sanitizeViewportMessage, VIEWPORT_MAX, VIEWPORT_MIN } from '../src/shared/cast-viewport'

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
