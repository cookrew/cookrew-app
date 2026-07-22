import { describe, expect, it } from 'vitest'
import { mostCovered, pickOverlayWinner } from '../src/renderer/src/zoom-lod'

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

// Magpie desktop stacking: zooming a card with an adjacent neighbor mounted
// BOTH overlays; the neighbor sliver stole rail clicks. Exactly one overlay
// must mount, keyed to the intended (already-open) card.
describe('pickOverlayWinner (single overlay, intent-stable)', () => {
  it('mounts nothing when no card crosses the threshold', () => {
    expect(pickOverlayWinner([], {}, null)).toBeNull()
  })

  it('picks the most-covered card on a fresh zoom-in (no prior overlay)', () => {
    // Target is centered/most-covered; the adjacent neighbor is a sliver.
    expect(pickOverlayWinner(['target', 'neighbor'], { target: 0.95, neighbor: 0.81 }, null)).toBe(
      'target'
    )
  })

  it('keeps the already-open card even when a neighbor becomes more covered', () => {
    // Panned so the neighbor now covers more — the open card must NOT flip.
    expect(
      pickOverlayWinner(['target', 'neighbor'], { target: 0.78, neighbor: 0.9 }, 'target')
    ).toBe('target')
  })

  it('switches to the new card once the previously-open one leaves the active set', () => {
    // Zoomed away: target dropped below EXIT and is no longer active.
    expect(pickOverlayWinner(['neighbor'], { neighbor: 0.9 }, 'target')).toBe('neighbor')
  })

  it('never mounts two overlays: only one id is ever returned', () => {
    const winner = pickOverlayWinner(['a', 'b', 'c'], { a: 0.85, b: 0.9, c: 0.82 }, null)
    expect(['a', 'b', 'c']).toContain(winner)
  })
})
