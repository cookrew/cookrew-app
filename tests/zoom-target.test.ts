// TAPPING A CARD MUST MOVE THE VIEWPORT (D1, canvas QA 2026-09-07, dev 91c7314).
//
// The report: a real tap on a card left the stage byte-identical —
// `translate(-24586.3px, -1539.88px) scale(2.94943)` before and after — and no
// full-view overlay ever mounted, while ReactFlow's own zoom in / zoom out /
// fit-view controls did move the canvas. Three cards, three zoom levels.
//
// The cause is not the tap and not d3-zoom. `reactFlow.fitView({nodes:[{id}]})`
// in @xyflow/react 12.11 does NOT move anything itself: it sets
// `fitViewQueued: true` and waits for a `setNodes` whose `adoptUserNodes`
// reports `nodesInitialized`, and that flag is false while ANY non-hidden node
// lacks a measured size. App.tsx passes `onlyRenderVisibleElements` (added by
// aca3556, the mobile-OOM fix), so every card outside the viewport is never
// mounted, never measured, and `nodesInitialized` never becomes true on a
// zoomed-in canvas. The queued fit is therefore never resolved, the promise
// never settles (hence no `setArrivedId`, hence no overlay), and a stale queued
// fit can later fire on an unrelated node update — which is the "earlier taps
// landed on the PREVIOUSLY zoomed card" half of the report.
//
// The repair is to stop asking `fitView` for a node and to fly to the card's
// own rect with `fitBounds`, which acts on panZoom immediately. That makes
// "which rect" the load-bearing arithmetic, and this file is its gate: the
// bounds a card resolves to, and the viewport those bounds produce through
// ReactFlow's own solver (the same one tests/zoom-fit.test.ts pins).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getViewportForBounds } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { nodesZoomBounds, nodeZoomBounds } from '../src/renderer/src/nodes/zoom-target'
import { CARD_FIT_PADDING } from '../src/renderer/src/nodes/card-zoom'

/** App.tsx's ReactFlow bounds. */
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

/** A card exactly as flow-nodes.ts builds it: size lives in `style`, only. */
const styled = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a',
  position: { x: 3990, y: 4353.148221760871 },
  style: { width: 720, height: 560 },
  ...over
})

describe('a card resolves to bounds even when it was never rendered', () => {
  it('prefers the MEASURED box, which is the truth once the card has mounted', () => {
    const bounds = nodeZoomBounds(
      styled({
        measured: { width: 719, height: 561 },
        internals: { positionAbsolute: { x: 10, y: 20 } }
      })
    )
    expect(bounds).toEqual({ x: 10, y: 20, width: 719, height: 561 })
  })

  it('falls back to the DECLARED style size — the case onlyRenderVisibleElements creates', () => {
    // This is the whole point. An off-screen card has `measured.width ===
    // undefined` forever, and `getNodeDimensions` would call it 0x0. The size
    // is still known: toFlowNode writes it into `style`.
    expect(nodeZoomBounds(styled())).toEqual({
      x: 3990,
      y: 4353.148221760871,
      width: 720,
      height: 560
    })
  })

  it('reads a px string, because a style width is allowed to be one', () => {
    const bounds = nodeZoomBounds(styled({ style: { width: '720px', height: '560px' } }))
    expect(bounds?.width).toBe(720)
    expect(bounds?.height).toBe(560)
  })

  it('takes the ABSOLUTE position when the card sits inside a parent', () => {
    const bounds = nodeZoomBounds(
      styled({ position: { x: 5, y: 5 }, internals: { positionAbsolute: { x: 905, y: 705 } } })
    )
    expect(bounds?.x).toBe(905)
    expect(bounds?.y).toBe(705)
  })

  it('honours width/height and initialWidth/initialHeight before style', () => {
    expect(nodeZoomBounds(styled({ width: 300, height: 200 }))?.width).toBe(300)
    expect(nodeZoomBounds(styled({ initialWidth: 300, initialHeight: 200 }))?.height).toBe(200)
  })
})

describe('an unresolvable card yields NULL, so the caller can say so out loud', () => {
  // Silence is the defect. A card with no size at all must not be flown to —
  // getViewportForBounds on a 0x0 box divides by zero and clamps to maxZoom,
  // which would throw the canvas across the workspace.
  it('returns null for a missing node', () => {
    expect(nodeZoomBounds(null)).toBeNull()
    expect(nodeZoomBounds(undefined)).toBeNull()
  })

  it('returns null when no source of size answers', () => {
    expect(nodeZoomBounds({ id: 'a', position: { x: 0, y: 0 } })).toBeNull()
  })

  it('returns null for a zero or negative box rather than a divide by zero', () => {
    expect(nodeZoomBounds(styled({ style: { width: 0, height: 560 } }))).toBeNull()
    expect(nodeZoomBounds(styled({ style: { width: -720, height: 560 } }))).toBeNull()
  })

  it('returns null when the position is unreadable', () => {
    expect(nodeZoomBounds({ id: 'a', style: { width: 720, height: 560 } })).toBeNull()
  })
})

describe('bounds → viewport: the tapped card fills the stage', () => {
  // The end-to-end arithmetic of a tap, through the SAME solver fitBounds uses.
  const stage = { width: 1400, height: 760 }

  const viewportFor = (node: Record<string, unknown>): { x: number; y: number; zoom: number } => {
    const bounds = nodeZoomBounds(node)
    if (bounds === null) throw new Error('unresolvable card')
    return getViewportForBounds(
      bounds,
      stage.width,
      stage.height,
      MIN_ZOOM,
      MAX_ZOOM,
      CARD_FIT_PADDING
    )
  }

  it('frames a never-measured card exactly as it frames a measured one', () => {
    const offScreen = viewportFor(styled())
    const measured = viewportFor(
      styled({ measured: { width: 720, height: 560 }, internals: { positionAbsolute: { x: 3990, y: 4353.148221760871 } } })
    )
    expect(offScreen).toEqual(measured)
  })

  it('puts the card edge to edge on the limiting axis', () => {
    const view = viewportFor(styled())
    const top = 4353.148221760871 * view.zoom + view.y
    const bottom = (4353.148221760871 + 560) * view.zoom + view.y
    expect(top).toBeCloseTo(0, 6)
    expect(bottom).toBeCloseTo(stage.height, 6)
  })

  it('is a real move away from a deep zoom, not the identity transform QA saw', () => {
    // The measured stuck viewport from the incident.
    const stuck = { x: -24586.3, y: -1539.88, zoom: 2.94943 }
    const view = viewportFor(styled())
    expect(view).not.toEqual(stuck)
    expect(Math.abs(view.x - stuck.x)).toBeGreaterThan(1)
  })
})

describe('the OVERVIEW box covers cards the store never measured', () => {
  // ReactFlow's own getNodesBounds calls an unmeasured node 0x0, so the
  // overview would be framed from the POSITIONS of the off-screen cards and
  // the SIZES of only the on-screen ones. Same resolver, one rule.
  const at = (x: number, y: number): Record<string, unknown> =>
    styled({ position: { x, y }, style: { width: 720, height: 560 } })

  it('spans from the first card’s corner to the last card’s far corner', () => {
    expect(nodesZoomBounds([at(0, 0), at(1000, 2000)])).toEqual({
      x: 0,
      y: 0,
      width: 1720,
      height: 2560
    })
  })

  it('includes a card that has no measured size at all', () => {
    const measured = styled({
      position: { x: 0, y: 0 },
      measured: { width: 100, height: 100 },
      style: undefined
    })
    // Without the style fallback this box would stop at 100x100.
    expect(nodesZoomBounds([measured, at(500, 500)])?.width).toBe(1220)
  })

  it('skips an unplaceable card rather than collapsing the board onto 0,0', () => {
    expect(nodesZoomBounds([{ id: 'ghost' }, at(400, 400)])).toEqual({
      x: 400,
      y: 400,
      width: 720,
      height: 560
    })
  })

  it('an empty board has no overview', () => {
    expect(nodesZoomBounds([])).toBeNull()
    expect(nodesZoomBounds([{ id: 'ghost' }])).toBeNull()
  })
})

// A SOURCE PROXY, and only what source text can honestly assert: that the
// canvas no longer asks the deferred API to move the viewport. Everything
// about what it computes is checked above.
describe('the canvas does not call the queued fitView any more', () => {
  const app = readFileSync(join(__dirname, '../src/renderer/src/App.tsx'), 'utf8').replace(
    /\s+/g,
    ' '
  )

  it('never asks fitView for a node — that call is the defect', () => {
    expect(app).not.toContain('fitView({ nodes:')
    expect(app).not.toContain('fitView({nodes:')
  })

  it('has no reactFlow.fitView call left at all', () => {
    expect(app).not.toContain('reactFlow.fitView(')
  })

  it('flies to a card with fitBounds, from resolved bounds', () => {
    expect(app).toContain('rect ?? nodeZoomBounds(reactFlow.getInternalNode(id))')
    expect(app).toContain('reactFlow.fitBounds(bounds, options)')
  })

  it('says so out loud when a tap has nowhere to land', () => {
    expect(app).toContain('reportMissingZoomTarget(id)')
  })
})
