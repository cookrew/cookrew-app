/**
 * WHICH BROWSER PICTURES ARE WANTED (ItemPets.tsx → App's thumbnail producers).
 *
 * The thumbnail producers photographed the browser cards inside the canvas
 * viewport. The canvas is retired, so nothing is "in the viewport" any more:
 * the faces on the item troop are what is on screen, and they say so here.
 * A plain list, no React: the producers read it on their own tick.
 */

/**
 * Wanted by whom. Two readers ask now — the item troop and the zoom
 * navigator — and the last writer must not blank the other's pictures, so
 * each owns a claim and the producers see their union.
 */
const claims = new Map<string, readonly string[]>()

/** At most this many: an expanded troop of 270 must not become 270 snapshots. */
export const THUMB_WANTS_MAX = 12

/** A workspace tile's front page is one picture per tile, on screen whole: it is never cut by a long deck. */
const first = (owner: string): number => (owner.startsWith('tile:') ? 0 : 1)

const union = (): readonly string[] => {
  const out: string[] = []
  const owners = [...claims.keys()].sort((a, b) => first(a) - first(b))
  for (const ids of owners.map((owner) => claims.get(owner) ?? [])) {
    for (const id of ids) {
      if (out.length >= THUMB_WANTS_MAX) return out
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

export const thumbWants = {
  ids: union,
  /** The pages the workspace tiles show now: Main starts and photographs one that has no picture. */
  tileIds: (): readonly string[] => [...claims.entries()].filter(([owner]) => owner.startsWith('tile:')).flatMap(([, ids]) => ids).slice(0, THUMB_WANTS_MAX),
  /** The one owner there used to be: kept for the troop and the tests. */
  set(ids: readonly string[]): void {
    claims.set('default', ids.slice(0, THUMB_WANTS_MAX))
  },
  /** A named reader's wish; `release` when it unmounts, so its pictures stop. */
  claim(owner: string, ids: readonly string[]): void {
    claims.set(owner, ids.slice(0, THUMB_WANTS_MAX))
  },
  release(owner: string): void {
    claims.delete(owner)
  }
}
