/**
 * Sidebar geometry. The agents sidebar has no level switch — width IS the
 * level, and these ramps are what make that continuous: identity fades in over
 * the first stretch, the turn block over a later one, so "info" and "trace" are
 * the two ends of one motion rather than two modes with labels.
 *
 * Pure arithmetic so the reveal curve can be pinned by tests instead of
 * eyeballed in a browser.
 */

/** Collapsed: the status coin and nothing else. */
export const RAIL_W = 56
/** Narrowest width worth opening to — below this, snap back to the rail. */
export const MIN_OPEN_W = 220
/** Opens here the first time; remembered per browser after that. */
export const DEFAULT_W = 470
export const MAX_W = 680

/** Below this a drag means "collapse", not "make it tiny". */
const SNAP_TO_RAIL_BELOW = 140

/** Identity (name + chips) fades in across this stretch. */
const ID_FROM = 90
const ID_TO = 170
/** The turn block (recap, ask, tool, status) across this one. */
const TURN_FROM = 300
const TURN_TO = 440

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

/** 0 below `from`, 1 above `to`, linear between. */
const ramp = (value: number, from: number, to: number): number =>
  clamp((value - from) / (to - from), 0, 1)

export interface SidebarReveal {
  /** 0→1 opacity for the name + chips line. */
  identity: number
  /** 0→1 opacity and height scalar for the turn block. */
  turn: number
}

export function revealFor(width: number): SidebarReveal {
  return {
    identity: ramp(width, ID_FROM, ID_TO),
    turn: ramp(width, TURN_FROM, TURN_TO),
  }
}

export function clampWidth(width: number): number {
  return Number.isFinite(width) ? clamp(width, RAIL_W, MAX_W) : DEFAULT_W
}

/**
 * Where a drag comes to rest. Only two outcomes are forced: a near-collapsed
 * drag becomes the rail, and an open drag is at least usable. Anything else
 * keeps exactly the width chosen — the reveal is continuous, so there is no
 * reason to pull it to a preset.
 */
export function snapWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_W
  if (width < SNAP_TO_RAIL_BELOW) return RAIL_W
  return clampWidth(Math.max(width, MIN_OPEN_W))
}
