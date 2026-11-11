/**
 * WHICH PICTURES THE ZOOM VIEW CLAIMS, BY WHERE THE ZOOM IS (bytes 0.6.2).
 *
 * Two things in the zoom view wear real browser pictures: the open tile's deck
 * (WorkspaceTile.tsx · ArtifactDeck), drawn on the tiles, and the artifacts'
 * grid, drawn once the zoom turns into the items. Both were claimed at every
 * stop, the agents' crew and card included, where neither is drawn: each claim
 * is a /api/browser/thumbs read every 5 s, through the relay on the console
 * (canvas bytes audit, 2026-11-11). Now a picture is asked for where it is
 * drawn. Other claimers (the pets beside an agent) claim their own.
 */
import { derive, type ZoomDir } from './zoom-path'

/** The tiles are on screen out here (the same line ZoomView draws them by). */
export const ON_TILES_BELOW = -0.5

export function zoomThumbClaim(at: { dir: ZoomDir; v: number; deck: readonly string[]; seen: readonly string[] }): string[] {
  const onTiles = at.v < ON_TILES_BELOW
  const grid = derive(at.dir, at.v).P > 0
  // The deck only while the tiles are drawn: past them it has dealt into the grid, whose pictures in view
  // are `seen`. Deck first on the tiles: the wants are capped (thumb-wants.ts).
  const lists = [onTiles ? at.deck : [], grid ? at.seen : []]
  return [...new Set(lists.flat())].filter(Boolean)
}
