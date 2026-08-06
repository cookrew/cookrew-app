import { describe, expect, it } from 'vitest'
import {
  DEFAULT_W,
  INFO_W,
  LEVELS,
  MAX_W,
  RAIL_W,
  TRACE_W,
  clampWidth,
  nearestLevel,
  nextLevel,
  revealFor
} from '../src/renderer/src/sidebar-width'

/**
 * The sidebar has no level switch. Width IS the level: identity fades in over
 * one stretch, the turn block over a later one, so "info" and "trace" are the
 * two ends of a single motion rather than two modes.
 */
describe('revealFor', () => {
  it('shows nothing but the coin at the rail', () => {
    expect(revealFor(RAIL_W)).toEqual({ identity: 0, turn: 0 })
  })

  it('has identity fully in before the turn starts appearing', () => {
    const w = 220
    expect(revealFor(w).identity).toBe(1)
    expect(revealFor(w).turn).toBe(0)
  })

  it('shows everything once wide', () => {
    expect(revealFor(MAX_W)).toEqual({ identity: 1, turn: 1 })
  })

  it('ramps continuously — no jumps between the two ends', () => {
    let prev = -1
    for (let w = RAIL_W; w <= MAX_W; w += 4) {
      const { turn } = revealFor(w)
      expect(turn).toBeGreaterThanOrEqual(prev)
      prev = turn
    }
  })

  it('never leaves the 0..1 range at any width, including silly ones', () => {
    for (const w of [-500, 0, RAIL_W, 300, MAX_W, 5000]) {
      const { identity, turn } = revealFor(w)
      for (const v of [identity, turn]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('reveals identity before the turn at every width', () => {
    for (let w = RAIL_W; w <= MAX_W; w += 7) {
      expect(revealFor(w).identity).toBeGreaterThanOrEqual(revealFor(w).turn)
    }
  })
})

describe('clampWidth', () => {
  it('keeps the rail as the floor and MAX_W as the ceiling', () => {
    expect(clampWidth(-20)).toBe(RAIL_W)
    expect(clampWidth(9999)).toBe(MAX_W)
  })

  it('leaves a sensible width alone', () => {
    expect(clampWidth(DEFAULT_W)).toBe(DEFAULT_W)
  })

  it('falls back to the default rather than producing NaN', () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_W)
  })
})

/**
 * The panel does not resize — one control cycles three states. The ramps above
 * still make each step a grow-in rather than a jump.
 */
describe('nextLevel', () => {
  it('cycles rail → info → trace → rail', () => {
    expect(nextLevel(RAIL_W)).toBe(INFO_W)
    expect(nextLevel(INFO_W)).toBe(TRACE_W)
    expect(nextLevel(TRACE_W)).toBe(RAIL_W)
  })

  it('always lands on a real state, never between them', () => {
    for (const w of [0, 57, 210, 299, 460, 9999]) {
      expect(LEVELS).toContain(nextLevel(w))
    }
  })

  it('returns to where it started after a full cycle', () => {
    expect(nextLevel(nextLevel(nextLevel(INFO_W)))).toBe(INFO_W)
  })
})

describe('nearestLevel', () => {
  it('snaps a stored width from an older build onto a real state', () => {
    expect(nearestLevel(64)).toBe(RAIL_W)
    expect(nearestLevel(310)).toBe(INFO_W)
    expect(nearestLevel(600)).toBe(TRACE_W)
  })
})

describe('the reveal covers every state', () => {
  it('shows identity but not the turn at the info state', () => {
    expect(revealFor(INFO_W).identity).toBe(1)
    expect(revealFor(INFO_W).turn).toBe(0)
  })

  it('shows everything at the trace state', () => {
    expect(revealFor(TRACE_W)).toEqual({ identity: 1, turn: 1 })
  })
})
