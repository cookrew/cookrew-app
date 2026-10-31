/**
 * THE TROOPS ATTACH TO THE FULL VIEW (owner, 2026-10-31: "make the left and
 * right agent group and browser group attachable to the full view, the way
 * group-motion-pivot.html shows it").
 *
 * In the demo's full view the panel stands in the middle and the two groups
 * stand beside it as columns: the rest of the crew down the right, the other
 * browsers and notes down the left, each centred on the panel. Here a troop
 * floating over the page becomes that column when a full view is up, and
 * moves with the panel. Attaching is a state, not a fixed layout: drag a troop
 * off the panel and it floats where it is put (remembered); drag it back to
 * the panel's side and it snaps on again.
 *
 * Pure, so the placement and the snap are tested as numbers.
 */

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type Side = 'left' | 'right'

/** The sheet's insets inside the full view (zoom/full-views.css · .zv-fullview::after). */
export const SHEET_INSET = { top: 78, side: 14, bottom: 12 } as const
/** The lane each attached troop takes beside the sheet (the CSS's --fv-lane-*). */
export const LANE_WIDE = 56
export const LANE_NARROW = 0
/** Below this width the stage cannot spare a lane: the column stands over the sheet's edge. */
export const NARROW_PX = 900
/** How close a dragged troop's middle must come to its column's to snap on. */
export const SNAP_PX = 90
/**
 * ON A PHONE (2026-11-01 phone evals): no column fits beside a 412px sheet,
 * and one over its edge covered the transcript. At or below this width the
 * troops stand as rows in a strip between the head and the sheet, which steps
 * down by STRIP_PX (zoom/full-views.css · --fv-strip): the browsers and notes
 * from the left edge, the crew from the right, a few faces each, the rest
 * behind "+N" (stripFaces).
 */
export const PHONE_PX = 700
export const STRIP_PX = 44
export const stripFaces = (side: Side, viewportWidth: number): number => (side === 'right' ? 4 : 3) - (viewportWidth < 380 ? 1 : 0)
/** How many faces an attached troop shows: all of them beside the sheet; on a phone, what its row in the strip holds. */
export const dockedCount = (count: number, side: Side, viewportWidth: number): number =>
  viewportWidth <= PHONE_PX ? Math.min(count, stripFaces(side, viewportWidth)) : count
/**
 * THE STRIP NEVER WRAPS (owner, 2026-11-01, Samsung Browser: with the
 * keyboard closed the crew stood in two rows, one behind the browsers and
 * notes, one over the transcript's top lines). "+N" used to open the troop
 * in place, a wrapping block of every face; the tap that closes the keyboard
 * lands on it easily. In the strip it turns a page instead: the same row,
 * the next `size` faces, the chip saying how many are still behind it, and
 * "–" on the last page, back to the first. `page` counts taps and wraps.
 */
export function stripPage(total: number, size: number, page: number): { start: number; end: number; rest: number; last: boolean } {
  const per = Math.max(1, size)
  const pages = Math.max(1, Math.ceil(total / per))
  const start = (((page % pages) + pages) % pages) * per
  const end = Math.min(total, start + per)
  return { start, end, rest: total - end, last: end >= total }
}

export const laneWidth = (viewportWidth: number): number => (viewportWidth < NARROW_PX ? LANE_NARROW : LANE_WIDE)

/** The paper sheet inside the full view, given the lanes the attached troops take. */
export function sheetBox(full: Box, lanes: { readonly left: number; readonly right: number }): Box {
  const left = full.left + SHEET_INSET.side + lanes.left
  const right = full.left + full.width - SHEET_INSET.side - lanes.right
  const top = full.top + SHEET_INSET.top
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, full.top + full.height - SHEET_INSET.bottom - top) }
}

/** The sheet as the page draws it: the full view less the insets its ::after is drawn at. */
export function sheetOf(full: Box, inset: { readonly top: number; readonly left: number; readonly right: number; readonly bottom: number }): Box {
  return {
    left: full.left + inset.left,
    top: full.top + inset.top,
    width: Math.max(0, full.width - inset.left - inset.right),
    height: Math.max(0, full.height - inset.top - inset.bottom)
  }
}

/**
 * Where an attached column's middle stands: in its lane beside the sheet, or
 * — with no lane — just inside the sheet's edge; centred on the sheet.
 */
export function columnMiddle(side: Side, full: Box, sheet: Box, troopWidth: number): { x: number; y: number } {
  const laneLeft = side === 'right' ? sheet.left + sheet.width : full.left
  const laneRight = side === 'right' ? full.left + full.width : sheet.left
  const lane = laneRight - laneLeft
  const x =
    lane >= troopWidth
      ? laneLeft + lane / 2
      : side === 'right'
        ? sheet.left + sheet.width - troopWidth / 2 - 4
        : sheet.left + troopWidth / 2 + 4
  return { x, y: sheet.top + sheet.height / 2 }
}

/** The attached troop's box: its middle on the column's, kept on screen and on the sheet's height. */
export function dockedSpot(side: Side, full: Box, sheet: Box, troop: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }): { left: number; top: number } {
  if (viewport.width <= PHONE_PX) return stripSpot(side, sheet, troop, viewport)
  const middle = columnMiddle(side, full, sheet, troop.width)
  const left = Math.min(Math.max(0, middle.x - troop.width / 2), Math.max(0, viewport.width - troop.width))
  const top = Math.min(Math.max(sheet.top, middle.y - troop.height / 2), Math.max(sheet.top, sheet.top + sheet.height - troop.height))
  return { left: Math.round(left), top: Math.round(Math.max(0, top)) }
}

/** On a phone: a row in the strip just above the sheet, flush with the sheet's left or right edge. */
function stripSpot(side: Side, sheet: Box, troop: { readonly width: number; readonly height: number }, viewport: { readonly width: number }): { left: number; top: number } {
  const left = side === 'right' ? sheet.left + sheet.width - troop.width : sheet.left
  const top = sheet.top - STRIP_PX + (STRIP_PX - troop.height) / 2
  return { left: Math.round(Math.min(Math.max(0, left), Math.max(0, viewport.width - troop.width))), top: Math.round(Math.max(0, top)) }
}

/** A dragged troop close enough to its column to snap on: its middle near the column's, and over the sheet's height. */
export function nearDock(side: Side, troop: Box, full: Box, sheet: Box): boolean {
  const middle = columnMiddle(side, full, sheet, troop.width)
  const cx = troop.left + troop.width / 2
  const cy = troop.top + troop.height / 2
  return Math.abs(cx - middle.x) <= SNAP_PX && cy >= sheet.top && cy <= sheet.top + sheet.height
}

/**
 * Who stands in an attached column, as the demo has it: never the card the
 * full view shows (it is the panel), the ones wired to it first, and — when
 * some are wired — the rest after them, dimmed.
 */
export function dockedOrder<T extends { readonly id: string }>(
  members: readonly T[],
  focus: { readonly exclude: string | null; readonly first: readonly string[] }
): { members: T[]; dim: ReadonlySet<string> } {
  const kept = members.filter((member) => member.id !== focus.exclude)
  const first = new Set(focus.first)
  if (first.size === 0) return { members: kept, dim: new Set() }
  const wired = kept.filter((member) => first.has(member.id))
  const rest = kept.filter((member) => !first.has(member.id))
  return { members: [...wired, ...rest], dim: new Set(rest.map((member) => member.id)) }
}
