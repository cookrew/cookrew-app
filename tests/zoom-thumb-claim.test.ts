import { describe, expect, it } from 'vitest'
import { zoomThumbClaim } from '../src/renderer/src/zoom/thumb-claim'

/**
 * WHICH PICTURES THE ZOOM VIEW ASKS FOR, BY WHERE IT IS (bytes 0.6.2). It
 * asked for the grid's pictures and the open tile's deck at every stop, the
 * agents' crew and card included, where neither is drawn: a /api/browser/thumbs
 * read every 5 s through the relay for nothing on screen.
 */

const DECK = ['d1', 'd2']
const SEEN = ['g1', 'g2', 'd1']

describe('the zoom view’s pictures', () => {
  it('on the tiles (devices and workspaces): the open tile’s deck, which wears real pictures', () => {
    expect(zoomThumbClaim({ dir: 'agents', v: -2, deck: DECK, seen: SEEN })).toEqual(['d1', 'd2'])
    expect(zoomThumbClaim({ dir: 'agents', v: -1, deck: DECK, seen: SEEN })).toEqual(['d1', 'd2'])
  })

  it('at the artifacts: the grid in view, then the deck', () => {
    expect(zoomThumbClaim({ dir: 'items', v: 0, deck: DECK, seen: SEEN })).toEqual(['g1', 'g2', 'd1'])
    expect(zoomThumbClaim({ dir: 'items', v: 1, deck: DECK, seen: SEEN })).toEqual(['g1', 'g2', 'd1'])
  })

  it('on the way from the tiles into the artifacts: the deck first, the grid as it deals out', () => {
    expect(zoomThumbClaim({ dir: 'items', v: -0.52, deck: DECK, seen: SEEN })).toEqual(['d1', 'd2', 'g1', 'g2'])
  })

  it('at the crew, a card or a full view: nothing, for neither is drawn there', () => {
    for (const v of [0, 1, 2, 3]) expect(zoomThumbClaim({ dir: 'agents', v, deck: DECK, seen: SEEN }), `v ${v}`).toEqual([])
  })
})
