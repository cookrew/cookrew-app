/**
 * THE COINS DOCKED ON A THUMBNAIL, at the artifacts stop: each agent's coin
 * for an item lies along the bottom of the item's thumbnail (zoom.css ·
 * .zv-ip > .zv-th, 168 wide, origin at its centre), from its right corner
 * leftwards. Sharers once stood a fixed pitch apart, so ten of them ran the row
 * 50 px past the card's left edge, over its picture and its neighbour's (owner,
 * 2026-11-17). Now the row closes up into a stack as the troop's does, and
 * never leaves its thumbnail; past what fits, the rest wait hidden under the
 * last one shown (the caption under the thumbnail counts and names them all).
 */

/** A docked coin's width in scene px: zoom.css · .zv-coin, 22 px drawn at the dock's 1.2 (zoom-frame.ts). */
export const DOCK_COIN = 22 * 1.2
/** The outermost coins' centres, either side of the thumbnail's: 16 in from its 84 px half width. */
export const DOCK_EDGE = 84 - 16
/** The pitch while the row has room. */
export const DOCK_STEP = 21
/** The closest the row closes up: nearly half of each face still seen. */
const DOCK_MIN_STEP = 12
/** How many coins a row shows: as many as stand DOCK_MIN_STEP apart between the two edges. */
export const DOCK_MAX = Math.floor((2 * DOCK_EDGE) / DOCK_MIN_STEP) + 1

/** Where the `j`th of `n` coins on one thumbnail lies, from the thumbnail's centre, and whether it is shown. */
export function coinDock(j: number, n: number): { dx: number; shown: boolean } {
  const shown = Math.max(1, Math.min(n, DOCK_MAX))
  const step = shown > 1 ? Math.min(DOCK_STEP, (2 * DOCK_EDGE) / (shown - 1)) : 0
  const at = Math.min(Math.max(0, j), shown - 1)
  return { dx: DOCK_EDGE - at * step, shown: j < shown }
}
