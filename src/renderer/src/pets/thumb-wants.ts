/**
 * WHICH BROWSER PICTURES ARE WANTED (ItemPets.tsx → App's thumbnail producers).
 *
 * The thumbnail producers photographed the browser cards inside the canvas
 * viewport. The canvas is retired, so nothing is "in the viewport" any more:
 * the faces on the item troop are what is on screen, and they say so here.
 * A plain list, no React: the producers read it on their own tick.
 */

let wanted: readonly string[] = []

/** At most this many: an expanded troop of 270 must not become 270 snapshots. */
export const THUMB_WANTS_MAX = 12

export const thumbWants = {
  ids: (): readonly string[] => wanted,
  set(ids: readonly string[]): void {
    wanted = ids.slice(0, THUMB_WANTS_MAX)
  }
}
