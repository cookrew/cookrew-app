/**
 * WHICH PICTURES THE ZOOM VIEW CLAIMS, BY WHERE THE ZOOM IS (bytes 0.6.2).
 *
 * The zoom view wears real browser pictures in three places: the open tile's
 * deck (WorkspaceTile.tsx · ArtifactDeck), drawn on the tiles; the artifacts'
 * grid, drawn once the zoom turns into the items; and past the tiles, the crew's
 * own (the coins that tie an agent to its browsers, the newest browser drawn on
 * its own: ZoomParts.tsx · LinkNode, NewestThumb). The deck and the grid were
 * claimed at every stop, where neither is drawn: each claim is a
 * /api/browser/thumbs read every 5 s, through the relay on the console (canvas
 * bytes audit, 2026-11-11). Now each is asked for where it is drawn. Other
 * claimers (the pets beside an agent, the bar) claim their own.
 */
import { derive, type ZoomDir } from './zoom-path'

/** The tiles are on screen out here (the same line ZoomView draws them by). */
export const ON_TILES_BELOW = -0.5

export function zoomThumbClaim(at: { dir: ZoomDir; v: number; deck: readonly string[]; seen: readonly string[]; crew?: readonly string[] }): string[] {
  const onTiles = at.v < ON_TILES_BELOW
  const grid = derive(at.dir, at.v).P > 0
  // The deck only while the tiles are drawn: past them it has dealt into the grid, whose pictures in view
  // are `seen`. Deck first on the tiles: the wants are capped (thumb-wants.ts).
  const lists = [onTiles ? at.deck : [], grid ? at.seen : [], onTiles ? [] : (at.crew ?? [])]
  return [...new Set(lists.flat())].filter(Boolean)
}
