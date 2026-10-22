import { describe, expect, it } from 'vitest'
import { FAN, LEVEL3, fanTotal } from '../src/strata/stage/motion'

describe('the numbers other parts build to', () => {
  it('level 3: the frame crossfades in 120 ms both ways, the bar leaves with it and is back within 160', () => {
    expect(LEVEL3.frameIn.ms).toBe(120)
    expect(LEVEL3.frameOut.ms).toBe(120)
    expect(LEVEL3.barOut.ms).toBe(LEVEL3.frameIn.ms)
    expect(LEVEL3.barIn.ms).toBeLessThanOrEqual(160)
  })

  it('the fan: 6 pointer cards out in 260 ms, 4 touch cards in 220, and the tuck is quicker than the fan', () => {
    expect(fanTotal(6, 'out')).toBe(260)
    expect(fanTotal(4, 'out')).toBe(220)
    expect(fanTotal(6, 'back')).toBe(180)
    expect(fanTotal(6, 'back')).toBeLessThan(fanTotal(6, 'out'))
    expect(fanTotal(1, 'out')).toBe(FAN.out.ms)
  })

  it('a reduced fan is one 120 ms crossfade, no stagger, whatever the count', () => {
    expect(fanTotal(6, 'out', true)).toBe(120)
    expect(fanTotal(6, 'back', true)).toBe(120)
  })

  it('every curve is a CSS timing function the browser accepts', () => {
    for (const e of [LEVEL3.frameIn.easing, LEVEL3.barIn.easing, FAN.out.easing, FAN.back.easing]) expect(e).toMatch(/^cubic-bezier\(/)
  })
})
