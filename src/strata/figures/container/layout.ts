// Seating: how many seats a container has room for, and where seat i goes.
// Containers come in tiers so a 2-agent workspace is a small piece of
// furniture and a 48-agent one a big one, at ONE shared scale: every seat is
// the same size everywhere, so every avatar is too.
//
// Seats fill in creation order, row by row (rows as even as possible, earlier
// rows take the extra), each row centred on the column pitch. Past capacity
// the last seat holds a "+K" token instead of an agent.

export const CAPACITY = 48

/** Avatar ball radius in model units; every container seats balls of this size. */
export const SEAT_R = 2.8

export interface Tier {
  cols: number
  rows: number
}

const TIERS: Tier[] = [
  { cols: 4, rows: 1 },
  { cols: 4, rows: 2 },
  { cols: 6, rows: 2 },
  { cols: 6, rows: 3 },
  { cols: 8, rows: 3 },
  { cols: 8, rows: 4 },
  { cols: 12, rows: 4 }
]

export const tierFor = (slots: number): Tier => TIERS.find((t) => t.cols * t.rows >= slots) ?? TIERS[TIERS.length - 1]

/** Seats actually drawn: capped at capacity (the last one is "+K" when over). */
export const seatsFor = (slots: number): number => Math.max(0, Math.min(Math.floor(slots), CAPACITY))

/** Overflow shown on the last seat; 0 when everyone fits. */
export const overflowOf = (slots: number): number => (slots > CAPACITY ? Math.floor(slots) - (CAPACITY - 1) : 0)

export interface Seat {
  index: number
  row: number
  /** Column position from the left edge on screen, in column units (may be fractional when centred). */
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
  const rowOffset = Math.floor((tier.rows - counts.length) / 2)
  let index = 0
  return counts.flatMap((count, r) =>
    Array.from({ length: count }, (_, c) => ({ index: index++, row: r + rowOffset, col: c + (tier.cols - count) / 2 }))
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
