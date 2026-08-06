import { describe, expect, it } from 'vitest'
import {
  DEFAULT_W,
  MAX_W,
  MIN_OPEN_W,
  RAIL_W,
  clampWidth,
  revealFor,
  snapWidth
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

describe('snapWidth', () => {
  it('snaps a near-collapsed drag to the rail — a 70px sidebar is not intent', () => {
    expect(snapWidth(70)).toBe(RAIL_W)
    expect(snapWidth(RAIL_W)).toBe(RAIL_W)
  })

  it('opens to a usable width rather than a useless sliver', () => {
    expect(snapWidth(MIN_OPEN_W + 5)).toBe(MIN_OPEN_W + 5)
    expect(snapWidth(150)).toBeGreaterThanOrEqual(MIN_OPEN_W)
  })

  it('otherwise keeps exactly the width you dragged to', () => {
    expect(snapWidth(317)).toBe(317)
    expect(snapWidth(468)).toBe(468)
  })
})
