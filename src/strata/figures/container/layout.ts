// Seating: every workspace sits at the same standard table, built from
// modules of 4 x 3 = 12 seats joined end to end (one to four), so a bigger crew
// gets a longer table and never a different one. One shared scale: every seat
// is the same size everywhere, so every avatar is too.
//
// Seats fill in creation order, row by row (rows as even as possible, earlier
// rows take the extra), each row centred on a drawn place, the rows toward the
// front. Past capacity the last seat holds a "+K" token instead of an agent.

export const MODULE = { cols: 4, rows: 3 } as const
export const MODULE_SEATS = MODULE.cols * MODULE.rows
export const MAX_MODULES = 4
export const CAPACITY = MODULE_SEATS * MAX_MODULES

/** Avatar ball radius in model units; every container seats balls of this size. */
export const SEAT_R = 2.8

export interface Tier {
  cols: number
  rows: number
}

/** Modules a table needs for this many seats. */
export const modulesFor = (seats: number): number => Math.min(MAX_MODULES, Math.max(1, Math.ceil(seats / MODULE_SEATS)))

export const tierFor = (seats: number): Tier => ({ cols: MODULE.cols * modulesFor(seats), rows: MODULE.rows })

/** A slot count as a whole number of agents: NaN, negatives and fractions never reach the geometry. */
export const agentsIn = (slots: number): number => (Number.isFinite(slots) ? Math.max(0, Math.floor(slots)) : 0)

/** Seats actually drawn: capped at capacity (the last one is "+K" when over). */
export const seatsFor = (slots: number): number => Math.min(agentsIn(slots), CAPACITY)

/** Overflow shown on the last seat; 0 when everyone fits. */
export const overflowOf = (slots: number): number => (agentsIn(slots) > CAPACITY ? agentsIn(slots) - (CAPACITY - 1) : 0)

export interface Seat {
  index: number
  row: number
  /** Column from the left edge on screen: always a drawn place. */
  col: number
}

/** Seats per row: as even as possible, earlier rows first. */
export const rowCounts = (seats: number, tier: Tier): number[] => {
  const used = Math.min(tier.rows, Math.max(1, Math.ceil(seats / tier.cols)))
  const base = Math.floor(seats / used)
  const extra = seats % used
  return Array.from({ length: used }, (_, r) => base + (r < extra ? 1 : 0))
}

/** Where each seat sits in the tier grid, in creation order. */
export const seatGrid = (seats: number, tier: Tier): Seat[] => {
  const counts = rowCounts(seats, tier)
  const rowOffset = Math.ceil((tier.rows - counts.length) / 2)
  const starts = counts.map((_, r) => counts.slice(0, r).reduce((a, b) => a + b, 0))
  return counts.flatMap((count, r) =>
    Array.from({ length: count }, (_, c) => ({ index: starts[r] + c, row: r + rowOffset, col: c + Math.floor((tier.cols - count) / 2) }))
  )
}

/**
 * The slot rect for a ball of screen radius R centred at (cx, cy): the
 * avatar figure's whole viewBox, so an avatar laid into it puts its ball on
 * the seat. Matches AVATAR_BALL in ../avatar.
 */
export const BALL = { cx: 0.5, cy: 0.58, d: 0.56 } as const
export const slotRect = (cx: number, cy: number, R: number) => {
  const side = (2 * R) / BALL.d
  return { x: cx - BALL.cx * side, y: cy - BALL.cy * side, w: side, h: side }
}
