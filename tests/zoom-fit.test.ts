// Zooming to a card must frame THAT CARD and nothing else.
//
// The owner's report: "not zoomed in enough to show exactly the chosen card
// fullview" — a browser card zoomed to the stage still showed the header of the
// card below it. That is not a rendering bug, it is arithmetic.
//
// Cards are laid out on a grid whose vertical PITCH EQUALS THE CARD HEIGHT: the
// live workspace places "Export UX Demo" at y=4353.15 and "E2E Demo" at
// y=4913.15, both 560 tall. The gutter between them is ZERO. So any padding
// fitView leaves around the framed card is filled by the neighbour that abuts
// it — at 2% of a 760px stage that is a ~15px strip of the next card's header,
// which is exactly what the screenshot showed.
//
// These tests run the REAL viewport solver (@xyflow/react's own
// getViewportForBounds, the one fitView calls) against the REAL geometry, and
// bind to the production constant rather than a copy of it.

import { getViewportForBounds } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { CARD_FIT_PADDING } from '../src/renderer/src/nodes/card-zoom'

/** Node geometry copied from the live workspace, to the decimal. */
const CHOSEN = { x: 3989.9999999999995, y: 4353.148221760871, width: 720, height: 560 }
const BELOW = { x: 3989.9999999999995, y: 4913.148221760871, width: 720, height: 560 }

/** App.tsx's ReactFlow bounds. */
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

interface Stage {
  width: number
  height: number
}

/** Where a flow-space rect lands on screen under a viewport. */
function onScreen(
  rect: { x: number; y: number; width: number; height: number },
  view: { x: number; y: number; zoom: number }
): { top: number; bottom: number; left: number; right: number } {
  return {
    top: rect.y * view.zoom + view.y,
    bottom: (rect.y + rect.height) * view.zoom + view.y,
    left: rect.x * view.zoom + view.x,
    right: (rect.x + rect.width) * view.zoom + view.x
  }
}

const fit = (stage: Stage, padding: number): { x: number; y: number; zoom: number } =>
  getViewportForBounds(CHOSEN, stage.width, stage.height, MIN_ZOOM, MAX_ZOOM, padding)

describe('zoom-to-card frames the chosen card exactly', () => {
  it('the card fills the limiting axis edge to edge', () => {
    // 1400x760 desktop stage: wider than the card's 720:560, so HEIGHT limits.
    const stage = { width: 1400, height: 760 }
    const view = fit(stage, CARD_FIT_PADDING)
    const card = onScreen(CHOSEN, view)
    expect(card.top).toBeCloseTo(0, 6)
    expect(card.bottom).toBeCloseTo(stage.height, 6)
  })

  it('the card BELOW it stays out of frame — the reported bug', () => {
    // With zero gutter, the neighbour's top edge IS the chosen card's bottom
    // edge. It may sit exactly at the fold; a single pixel above it is the
    // sliver the owner photographed.
    const stage = { width: 1400, height: 760 }
    const view = fit(stage, CARD_FIT_PADDING)
    expect(onScreen(BELOW, view).top).toBeGreaterThanOrEqual(stage.height)
  })

  it('holds across stage shapes, not just the one in the screenshot', () => {
    for (const stage of [
      { width: 1400, height: 760 },
      { width: 1728, height: 900 },
      { width: 1024, height: 640 },
      { width: 2560, height: 1300 }
    ]) {
      const view = fit(stage, CARD_FIT_PADDING)
      expect(onScreen(BELOW, view).top).toBeGreaterThanOrEqual(stage.height)
    }
  })

  it('does not crop the card it is framing', () => {
    // "Exactly the card" cuts both ways: fill the frame, but lose no pixel of
    // it. A cover-fit would pass the neighbour test above and fail this one.
    //
    // The 1px tolerance is an upstream artifact, not slop. The workspace stores
    // this card's x as 3989.9999999999995, and getViewportForBounds runs its
    // applied-padding correction through Math.floor — so a left edge landing on
    // -1e-13 floors to -1 and nudges the whole card 1px. Feed the same call a
    // flat 3990 and both axes come out exact. Left as a known 1px, because the
    // alternative is computing the fit bounds ourselves and giving up fitView's
    // handling of measured-vs-declared sizes, parents and node origins.
    for (const stage of [
      { width: 1400, height: 760 },
      { width: 390, height: 620 } // portrait: WIDTH limits here
    ]) {
      const view = fit(stage, CARD_FIT_PADDING)
      const card = onScreen(CHOSEN, view)
      expect(card.top).toBeGreaterThanOrEqual(-1)
      expect(card.left).toBeGreaterThanOrEqual(-1)
      expect(card.bottom).toBeLessThanOrEqual(stage.height + 1)
      expect(card.right).toBeLessThanOrEqual(stage.width + 1)
    }
  })

  it('WITNESS: the old 0.02 padding is what let the neighbour through', () => {
    // Kept as the proof of cause, with the measured number rather than an
    // assumed one: on a 1400x760 stage the solver leaves 7px of slack below the
    // card, and the next card starts at that exact edge, so 7px of its header
    // rendered. Delete this test only alongside the layout that makes it moot.
    const stage = { width: 1400, height: 760 }
    const leaked = stage.height - onScreen(BELOW, fit(stage, 0.02)).top
    expect(leaked).toBeCloseTo(7, 1)
  })
})
