// "focus on middle card but active fullview is the corner card" — the fixture
// for that report, and now the test for its fix.
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
// Nothing there knew which card the user CHOSE: zoomToNode recorded it in
// App's zoomedNodeIdRef and the arbiter was never told.
//
// Both halves are fixed. pickOverlayWinner now takes the focused id and it
// outranks the stickiness, and a card must hold a minimum SHARE of the stage to
// be eligible at all. The ROOT CAUSE cases below still assert the old
// arithmetic, because that arithmetic is unchanged and is what the new floor
// exists to compensate for.
//
// Geometry is lifted from the live workspace, and the viewport is produced by
// the same solver zoomToNode drives, so this is the real arithmetic rather than
// a reconstruction of it.

import { getViewportForBounds } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { CARD_FIT_PADDING } from '../src/renderer/src/nodes/card-zoom'
import {
  ENTER_STAGE_SHARE,
  EXIT_STAGE_SHARE,
  isFullViewEligible,
  mostCovered,
  pickOverlayWinner,
  projectToStage,
  stageShare as stageShareOf
} from '../src/renderer/src/zoom-lod'

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

/** Share of the STAGE a card actually occupies — via the production function. */
const stageShare = (node: typeof MIDDLE, viewport: ReturnType<typeof focusViewport>): number =>
  stageShareOf(projectToStage(node, viewport, PANE).visible, PANE)

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

  it('FIXED: the focused card takes the full view from the open corner card', () => {
    // Was the bug: prevPrimary = corner, corner still "active" by the size-only
    // measure, so the arbiter handed it back the overlay. The focused id now
    // outranks the stickiness.
    expect(
      pickOverlayWinner(['middle', 'corner'], { middle: 1, corner: 1 }, 'corner', 'middle')
    ).toBe('middle')
  })

  it('FIXED: a sliver is no longer eligible to hold the full view', () => {
    // The other half, asserted through the predicate the hook itself calls —
    // so forgetting to wire the floor in fails here rather than passing on a
    // number nothing consults. Even with no focused card, and even while it is
    // the OPEN card (wasActive), the 40px sliver is out.
    const at = focusViewport()
    const view = focusViewport(CORNER.position.x * at.zoom + at.x - (PANE.width - 40))
    const corner = projectToStage(CORNER, view, PANE)

    expect(corner.coverage).toBeGreaterThanOrEqual(ENTER_COVERAGE) // still "big"
    expect(stageShareOf(corner.visible, PANE)).toBeLessThan(EXIT_STAGE_SHARE) // but not present
    expect(isFullViewEligible(corner.visible, corner.coverage, PANE, false)).toBe(false)
    expect(isFullViewEligible(corner.visible, corner.coverage, PANE, true)).toBe(false)
  })

  it('FIXED: the focused card is eligible, entering and staying', () => {
    // The floor must reject slivers without rejecting the real thing.
    const middle = projectToStage(MIDDLE, focusViewport(), PANE)
    expect(isFullViewEligible(middle.visible, middle.coverage, PANE, false)).toBe(true)
    expect(isFullViewEligible(middle.visible, middle.coverage, PANE, true)).toBe(true)
  })

  it('a card fully off the stage is never eligible', () => {
    const corner = projectToStage(CORNER, focusViewport(), PANE)
    expect(corner.visible).toBeNull()
    expect(isFullViewEligible(corner.visible, corner.coverage, PANE, true)).toBe(false)
  })

  it('the focused card itself clears the stage-share floor, on desktop and phone', () => {
    // The floor has to reject slivers without rejecting the real thing. A card
    // fitted to the stage keeps 74% of it here; on a phone, letterboxed by
    // aspect, 49%. Both are far above the 0.25 entry floor.
    expect(stageShareOf(projectToStage(MIDDLE, focusViewport(), PANE).visible, PANE)).toBeGreaterThan(
      ENTER_STAGE_SHARE
    )

    const phone = { width: 390, height: 620 }
    const bounds = { ...MIDDLE.position, ...MIDDLE.size }
    const v = getViewportForBounds(bounds, phone.width, phone.height, 0.1, 8, CARD_FIT_PADDING)
    expect(stageShareOf(projectToStage(MIDDLE, v, phone).visible, phone)).toBeGreaterThan(
      ENTER_STAGE_SHARE
    )
  })

  it('focus cannot conjure an overlay for a card that is not eligible', () => {
    // Intent outranks geometry, it does not replace it: a focused card still
    // has to be in the active set. Otherwise a tap during the zoom animation
    // would mount a full view over a thumbnail.
    expect(pickOverlayWinner(['corner'], { corner: 1 }, 'corner', 'middle')).toBe('corner')
    expect(pickOverlayWinner([], {}, null, 'middle')).toBeNull()
  })
})
