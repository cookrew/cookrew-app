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
/** Level 1: identity — coin, name, chips. */
export const INFO_W = 300
/** Level 2: identity plus the turn. Opens here the first time. */
export const TRACE_W = 470
export const DEFAULT_W = TRACE_W
export const MAX_W = TRACE_W

/**
 * The panel does not resize. One control cycles the three states, and the
 * ramps below turn each step into a continuous grow-in rather than a jump.
 */
export const LEVELS = [RAIL_W, INFO_W, TRACE_W] as const

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

/** Nearest state to an arbitrary width — used when restoring a stored value. */
export function nearestLevel(width: number): number {
  return LEVELS.reduce((best, level) =>
    Math.abs(level - width) < Math.abs(best - width) ? level : best,
  )
}

/** Next state in the cycle: rail → info → trace → rail. */
export function nextLevel(width: number): number {
  const here = LEVELS.indexOf(nearestLevel(width) as (typeof LEVELS)[number])
  return LEVELS[(here + 1) % LEVELS.length]
}
