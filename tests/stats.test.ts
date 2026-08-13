import { describe, expect, it } from 'vitest'
import { latencyStats } from '../src/shared/stats'

describe('latencyStats', () => {
  it('returns null for an empty sample — no summary is honest, zeros are not', () => {
    expect(latencyStats([])).toBeNull()
  })

  it('collapses a single sample to itself at every percentile', () => {
    expect(latencyStats([42])).toEqual({ count: 1, p50: 42, p95: 42, p98: 42, max: 42 })
  })

  it('ties collapse to the shared value at every percentile', () => {
    expect(latencyStats([7, 7, 7, 7])).toEqual({ count: 4, p50: 7, p95: 7, p98: 7, max: 7 })
  })

  it('an exact-rank percentile lands on the element, untouched', () => {
    // n = 5 → p50 rank = 0.5 × (5-1) = 2, an exact index: no interpolation.
    expect(latencyStats([10, 20, 30, 40, 50])).toMatchObject({ p50: 30 })
  })

  it('a fractional rank interpolates linearly between its neighbours', () => {
    // n = 5 → p95 rank = 3.8 → 40 + 0.8×(50-40); p98 rank = 3.92 → +0.92×10.
    const stats = latencyStats([10, 20, 30, 40, 50])
    expect(stats).not.toBeNull()
    expect(stats!.p95).toBeCloseTo(48)
    expect(stats!.p98).toBeCloseTo(49.2)
  })

  it('unsorted input yields the same stats as sorted input', () => {
    const shuffled = [50, 10, 40, 20, 30]
    expect(latencyStats(shuffled)).toEqual(latencyStats([10, 20, 30, 40, 50]))
  })

  it('does not mutate the input array', () => {
    const values = [50, 10, 40, 20, 30]
    latencyStats(values)
    expect(values).toEqual([50, 10, 40, 20, 30])
  })

  it('zero and negative samples sort numerically, not lexicographically', () => {
    // Lexicographic would order -50 after 0 ("-" > "0") and corrupt every rank.
    const stats = latencyStats([-50, 0, 50])
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(3)
    expect(stats!.p50).toBe(0)
    expect(stats!.max).toBe(50)
    // p98 rank = 0.98 × 2 = 1.96 → 0 + 0.96 × (50 - 0) = 48, not 0.98 × max.
    expect(stats!.p98).toBeCloseTo(48)
  })
})
