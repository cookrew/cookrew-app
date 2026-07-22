import { describe, expect, it } from 'vitest'
import { mostCovered } from '../src/renderer/src/zoom-lod'

// Magpie E2 HIGH 2: browser fullscreen views stacked OVER terminal overlays
// because each layer arbitrated its own winner. The shared selection must
// pick ONE node across kinds — the most-covered (clicked) one on top.
describe('mostCovered (shared overlay arbitration)', () => {
  it('picks the highest-coverage id across mixed node kinds', () => {
    expect(
      mostCovered(['term-1', 'browser-1'], { 'term-1': 0.92, 'browser-1': 0.85 })
    ).toBe('term-1')
    expect(
      mostCovered(['term-1', 'browser-1'], { 'term-1': 0.81, 'browser-1': 0.97 })
    ).toBe('browser-1')
  })

  it('keeps the first id on coverage ties (stable winner, no flicker)', () => {
    expect(mostCovered(['a', 'b'], { a: 0.9, b: 0.9 })).toBe('a')
  })

  it('returns null for an empty set and treats missing coverage as 0', () => {
    expect(mostCovered([], {})).toBeNull()
    expect(mostCovered(['a', 'b'], { b: 0.5 })).toBe('b')
  })
})
