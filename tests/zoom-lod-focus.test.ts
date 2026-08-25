// FIXTURE — "focus on middle card but active fullview is the corner card".
//
// Reported from a canvas where the middle card ("Preset Procedure") is the one
// zoomed to and centred, while the live full view is mounted on a card pinned
// off in the corner, showing as a sliver at the stage edge.
//
// The cause is in what `coverage` measures. useLodLayout scores a card as
//
//     max(min(1, projectedWidth / paneWidth), min(1, projectedHeight / paneHeight))
//
// which is the card's PROJECTED SIZE, not the share of the stage it occupies.
// Pan a card off the edge and its projected size does not change, so its
// coverage does not change either. A card with one pixel on screen scores the
// same 1.0 as the card filling the stage. pickOverlayWinner then keeps the
// already-open card while it is "still covered" — and by this measure it is
// still covered forever, so the overlay never comes back to the card the user
// actually zoomed to.
//
// Nothing here knows which card the user CHOSE. zoomToNode records that in
// App's zoomedNodeIdRef and the arbiter is never told.
//
// Geometry is lifted from the live workspace, and the viewport is produced by
// the same solver zoomToNode drives, so this is the real arithmetic rather than
// a reconstruction of it.

import { getViewportForBounds } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { CARD_FIT_PADDING } from '../src/renderer/src/nodes/card-zoom'
import { mostCovered, pickOverlayWinner, projectToStage } from '../src/renderer/src/zoom-lod'

/** Two real same-row neighbours from the live workspace. */
const MIDDLE = {
  id: 'middle',
  position: { x: 2462.3894427454434, y: 433.1482217608707 },
  size: { width: 720, height: 560 }
}
const CORNER = {
  id: 'corner',
  position: { x: 3990.0000000000005, y: 433.1482217608707 },
  size: { width: 720, height: 560 }
}

const PANE = { width: 1000, height: 575 }
const ENTER_COVERAGE = 0.8

/** The viewport zoomToNode produces for the middle card. */
const focusViewport = (pan = 0) => {
  const bounds = { ...MIDDLE.position, ...MIDDLE.size }
  const v = getViewportForBounds(
    bounds,
    PANE.width,
    PANE.height,
    0.1,
    8,
    CARD_FIT_PADDING
  )
  return { ...v, x: v.x - pan }
}

/** Share of the STAGE a card actually occupies — what "fullview" should mean. */
const stageShare = (node: typeof MIDDLE, viewport: ReturnType<typeof focusViewport>): number => {
  const { visible } = projectToStage(node, viewport, PANE)
  if (visible === null) return 0
  return (visible.width * visible.height) / (PANE.width * PANE.height)
}

describe('FIXTURE: the focused card and the full-view card disagree', () => {
  it('the middle card is the one zoomed to and the one filling the stage', () => {
    const view = focusViewport()
    expect(stageShare(MIDDLE, view)).toBeGreaterThan(0.7)
    expect(projectToStage(MIDDLE, view, PANE).coverage).toBe(1)
  })

  it('ROOT CAUSE: a card fully off the stage scores full coverage', () => {
    // The corner card is not merely small on screen — at this viewport it is
    // not on screen at all. It still scores 1.0, the same as the card the user
    // is looking at, because coverage never asks where the card IS.
    const view = focusViewport()
    expect(stageShare(CORNER, view)).toBe(0)
    expect(projectToStage(CORNER, view, PANE).coverage).toBe(1)
  })

  it('ROOT CAUSE: a sliver at the edge is "active" for the full view', () => {
    // Pan until exactly a 40px sliver of the corner card shows — the state in
    // the report. Occupying under 5% of the stage, it still clears the 0.8
    // entry threshold and is eligible for the full view.
    const at = focusViewport()
    const pan = CORNER.position.x * at.zoom + at.x - (PANE.width - 40)
    const view = focusViewport(pan)

    const corner = projectToStage(CORNER, view, PANE)
    expect(corner.visible?.width).toBeCloseTo(40, 6)
    expect(stageShare(CORNER, view)).toBeLessThan(0.05)
    expect(corner.coverage).toBeGreaterThanOrEqual(ENTER_COVERAGE)
  })

  it('and coverage cannot break the tie, because both score exactly 1', () => {
    // With both at 1.0 the "most covered" winner is decided by iteration order,
    // not by anything the user did.
    expect(mostCovered(['corner', 'middle'], { corner: 1, middle: 1 })).toBe('corner')
  })

  it.fails('THE BUG: the corner card keeps the full view once it has it', () => {
    // prevPrimary = corner, and corner is still "active" by the size-only
    // measure, so the arbiter hands it the overlay again — even though the
    // middle card is the one focused and on screen. This assertion states the
    // behaviour we want and FAILS today; that failure is the fixture.
    //
    // When this starts passing, delete the .fails.
    expect(pickOverlayWinner(['middle', 'corner'], { middle: 1, corner: 1 }, 'corner')).toBe(
      'middle'
    )
  })

  it.fails('THE FIX SHAPE: the arbiter is never told which card was chosen', () => {
    // zoomToNode(id) is the user's choice, recorded in App's zoomedNodeIdRef and
    // then dropped on the floor. Until that id reaches pickOverlayWinner, no
    // coverage rule can distinguish "the card they tapped" from "a card that
    // happens to be big", because by size alone the two are identical — as the
    // ROOT CAUSE cases above show.
    expect(pickOverlayWinner.length).toBeGreaterThanOrEqual(4)
  })
})
