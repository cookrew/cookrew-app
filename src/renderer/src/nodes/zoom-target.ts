/**
 * WHERE A TAPPED CARD IS — the rect zoom-to-card flies the viewport to.
 *
 * D1, canvas QA 2026-09-07 (dev 91c7314): "tapping a card does not open it".
 * The correct node id reached the renderer and the stage transform was
 * byte-identical before and after, with no overlay mounted, while ReactFlow's
 * own zoom controls moved the canvas fine.
 *
 * WHY fitView COULD NOT DO THIS. In @xyflow/react 12.11 `fitView({nodes})` does
 * not move anything: it sets `fitViewQueued` and waits for a `setNodes` whose
 * `adoptUserNodes` reports `nodesInitialized`, which is false while ANY
 * non-hidden node lacks a measured size. App.tsx passes
 * `onlyRenderVisibleElements` (aca3556, the mobile-OOM fix), so on a zoomed-in
 * canvas most cards are never mounted, never measured, and the flag never turns
 * true. The queued fit is dropped, its promise never settles — which is also
 * why `setArrivedId` never ran and no full view appeared — and a stale queued
 * fit can later resolve on an unrelated node update, landing on the card tapped
 * before this one. `fitBounds`, `setCenter` and `setViewport` have no such gate:
 * they call panZoom directly. So the fix is to hand fitBounds a rect, and the
 * rect is what this module resolves.
 *
 * The same measurement gap is why the size cannot simply be read from
 * `measured`: an off-screen card has none. flow-nodes.ts always writes the card
 * size into `style`, so the declared size is the dependable floor.
 *
 * Pure, except for `reportMissingZoomTarget` — see its note.
 */

export interface ZoomBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The shape of a ReactFlow node this module reads — structural on purpose, so
 *  a plain `Node` and an `InternalNode` are both acceptable and a test needs no
 *  flow store to build one. */
export interface MeasurableNode {
  id?: string
  position?: { x?: number; y?: number }
  internals?: { positionAbsolute?: { x?: number; y?: number } }
  measured?: { width?: number; height?: number }
  width?: number
  height?: number
  initialWidth?: number
  initialHeight?: number
  style?: { width?: number | string; height?: number | string }
}

/** A CSS length as a number: 720 and '720px' are the same width. */
function asLength(value: number | string | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** The first candidate that names a real, positive extent. */
function extent(candidates: readonly (number | string | undefined)[]): number | null {
  for (const candidate of candidates) {
    const length = asLength(candidate)
    if (length !== null && length > 0) return length
  }
  return null
}

/** Absolute flow position — the parented case is why `positionAbsolute` wins. */
function origin(node: MeasurableNode): { x: number; y: number } | null {
  const absolute = node.internals?.positionAbsolute
  const x = absolute?.x ?? node.position?.x
  const y = absolute?.y ?? node.position?.y
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * The flow-space box of a card, or null when it genuinely cannot be placed.
 *
 * NULL IS LOAD-BEARING. `getViewportForBounds` on a 0x0 box divides by zero and
 * clamps to maxZoom, throwing the canvas across the workspace — so a card with
 * no readable size must be refused, and refused LOUDLY (the whole defect was a
 * silent no-op). See `reportMissingZoomTarget`.
 */
export function nodeZoomBounds(node: MeasurableNode | null | undefined): ZoomBox | null {
  if (!node) return null
  const at = origin(node)
  if (at === null) return null
  const width = extent([node.measured?.width, node.width, node.initialWidth, node.style?.width])
  const height = extent([node.measured?.height, node.height, node.initialHeight, node.style?.height])
  if (width === null || height === null) return null
  return { x: at.x, y: at.y, width, height }
}

/**
 * The box around EVERY card — the overview fit, on the same footing.
 *
 * ReactFlow's own `getNodesBounds` reads `getNodeDimensions`, which calls an
 * unmeasured node 0x0, so under `onlyRenderVisibleElements` the overview would
 * be framed from the positions of the off-screen cards and the sizes of only
 * the on-screen ones — tight by up to a card on the right and the bottom.
 * Resolving each card the same way a tapped one is resolved keeps one rule.
 *
 * Null when nothing can be placed: an empty board has no overview.
 */
export function nodesZoomBounds(nodes: readonly MeasurableNode[]): ZoomBox | null {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    const box = nodeZoomBounds(node)
    if (box === null) continue
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Ids already reported — a tap that cannot land must say so, but a card that
 *  is repeatedly tapped must not flood the console. */
const reported = new Set<string>()

/**
 * Say, ONCE per card, that a zoom had nowhere to go.
 *
 * The impure export in a pure module, and deliberately so: the defect this file
 * exists for was invisible precisely because the failure path printed nothing,
 * so the reporting belongs next to the arithmetic that decides there is a
 * failure rather than at some call site that might forget it.
 */
export function reportMissingZoomTarget(id: string): void {
  if (reported.has(id)) return
  reported.add(id)
  console.warn(
    `Cookrew: zoom-to-card found no bounds for node ${id} — the card is not in the flow store. ` +
      'The viewport was left where it was (D1, canvas QA 2026-09-07).'
  )
}

/** Test seam: forget what has been reported. */
export function resetMissingZoomTargets(): void {
  reported.clear()
}
