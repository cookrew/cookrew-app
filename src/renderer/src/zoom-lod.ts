import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, useViewport } from '@xyflow/react'
import type { CanvasPosition, CanvasSize } from '../../shared/model'
import { isRemoteMode } from './api'

/**
 * Semantic-zoom (LOD) layout: cards on the canvas are thumbnails by default
 * and swap to their full renderer (live xterm / browser surface) only while they
 * occupy >= 80% of the stage in at least one dimension. Zooming back out
 * returns them to thumbnails. Notes never take part.
 */

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

interface LodNode {
  id: string
  position: CanvasPosition
  size: CanvasSize
}

/** Runtime guard for persisted/API data, which is not protected by TS types. */
export function hasLodGeometry(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  const candidate = node as Partial<LodNode>
  return (
    typeof candidate.id === 'string' &&
    Number.isFinite(candidate.position?.x) &&
    Number.isFinite(candidate.position?.y) &&
    Number.isFinite(candidate.size?.width) &&
    Number.isFinite(candidate.size?.height) &&
    (candidate.size?.width ?? 0) > 0 &&
    (candidate.size?.height ?? 0) > 0
  )
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Pane {
  width: number
  height: number
}

/**
 * Project a node onto the stage: the part of it actually on screen, and the
 * coverage score the overlay arbitration runs on.
 *
 * Extracted from useLodLayout unchanged, so a test can see what the hook sees.
 * Note what `coverage` measures and what it does NOT: it is the node's
 * PROJECTED SIZE against the pane, so a card panned entirely off the stage
 * still scores whatever it would score if it were centred. `visible` is the
 * on-stage part, and the two can disagree completely — see
 * tests/zoom-lod-focus.test.ts.
 */
export function projectToStage(
  node: LodNode,
  viewport: Viewport,
  pane: Pane
): { visible: ScreenRect | null; coverage: number } {
  const sx = node.position.x * viewport.zoom + viewport.x
  const sy = node.position.y * viewport.zoom + viewport.y
  const sw = node.size.width * viewport.zoom
  const sh = node.size.height * viewport.zoom

  const left = Math.max(sx, 0)
  const top = Math.max(sy, 0)
  const width = Math.min(sx + sw, pane.width) - left
  const height = Math.min(sy + sh, pane.height) - top

  return {
    visible: width > 0 && height > 0 ? { x: left, y: top, width, height } : null,
    coverage: Math.max(Math.min(1, sw / pane.width), Math.min(1, sh / pane.height))
  }
}

/** The id with the highest recorded coverage; first wins ties (stable). */
export function mostCovered(
  ids: Iterable<string>,
  coverages: Record<string, number>
): string | null {
  let best: string | null = null
  let bestCoverage = -1
  for (const id of ids) {
    const coverage = coverages[id] ?? 0
    if (coverage > bestCoverage) {
      best = id
      bestCoverage = coverage
    }
  }
  return best
}

/**
 * Share of the stage a card actually occupies. Distinct from `coverage`, which
 * is the card's projected SIZE and says nothing about where it is: a card
 * panned to a sliver at the edge keeps full coverage but has a tiny share.
 */
export function stageShare(visible: ScreenRect | null, pane: Pane): number {
  if (visible === null) return 0
  return (visible.width * visible.height) / (pane.width * pane.height)
}

/**
 * A card must hold this much of the stage to take the full view, and keep this
 * much to hold it. Hysteresis, like ENTER/EXIT_COVERAGE, so panning across the
 * boundary doesn't flicker.
 *
 * Coverage alone cannot express this. It is a max over the two dimensions, so a
 * card reduced to a 40px full-height sliver still scores 1.0 — the same as the
 * card filling the stage. The numbers sit in a wide gap: a card fitted to the
 * stage holds 74% of it on desktop and 49% on a phone (letterboxed by aspect),
 * while the slivers this rejects hold under 10%.
 */
export const ENTER_STAGE_SHARE = 0.25
export const EXIT_STAGE_SHARE = 0.15

/**
 * May this card mount the full view? Big enough AND actually on the stage.
 *
 * The second half is the one that matters: a card's projected size does not
 * change as it is panned off, so coverage alone keeps calling it eligible right
 * up to its last pixel — which is how an off-stage card held the full view
 * while the focused card filled the screen.
 */
export function isFullViewEligible(
  visible: ScreenRect | null,
  coverage: number,
  pane: Pane,
  wasActive: boolean
): boolean {
  if (visible === null) return false
  const coverageFloor = wasActive ? EXIT_COVERAGE : ENTER_COVERAGE
  const shareFloor = wasActive ? EXIT_STAGE_SHARE : ENTER_STAGE_SHARE
  return coverage >= coverageFloor && stageShare(visible, pane) >= shareFloor
}

/**
 * Final gate on mounting the full view: eligible by geometry, AND the viewport
 * has stopped moving.
 *
 * "Stopped moving" has three sources. `settled` is a SETTLE_MS debounce, which
 * is all a manual wheel-zoom can offer. `wasActive` keeps an open card tracking
 * the viewport every frame instead of unmounting mid-pan. `hasArrived` is the
 * precise one: a zoom-to-card animation reports its own completion, so a
 * deliberately-tapped card does not have to wait out a debounce guessing at
 * what the animation already knows.
 */
export function admitsFullView(
  eligible: boolean,
  settled: boolean,
  wasActive: boolean,
  hasArrived: boolean
): boolean {
  return eligible && (settled || wasActive || hasArrived)
}

/**
 * The single node whose full overlay should mount. Only one may mount at a
 * time — several cards cross the coverage threshold when a neighbor is
 * adjacent, and mounting all of them stacks fullscreen overlays so the
 * neighbor sliver steals interaction (Magpie desktop stacking bug).
 *
 * `focusedId` is the card the user deliberately zoomed to (zoomToNode) and it
 * outranks everything, because it is the only input here that reflects intent
 * rather than geometry. Without it the arbiter could not tell the card someone
 * tapped from a card that merely happens to be big, and the full view would
 * stay stuck on whatever opened first — the reported bug. It is a required
 * argument so that no caller can silently forget to say.
 *
 * Below that, prefer the card already open (prevPrimary) while it is still
 * covered, so an incidentally-covered neighbor can't steal an open card;
 * otherwise the most-covered card wins. Null when nothing is eligible.
 */
export function pickOverlayWinner(
  activeIds: Iterable<string>,
  coverages: Record<string, number>,
  prevPrimary: string | null,
  focusedId: string | null
): string | null {
  const ids = new Set(activeIds)
  if (ids.size === 0) return null
  if (focusedId !== null && ids.has(focusedId)) return focusedId
  if (prevPrimary !== null && ids.has(prevPrimary)) return prevPrimary
  return mostCovered(ids, coverages)
}

/** Enter/exit hysteresis so the full view doesn't flicker at the boundary. */
const ENTER_COVERAGE = 0.8
const EXIT_COVERAGE = 0.72
/** The full view mounts only once the viewport stops moving for this long. */
const SETTLE_MS = 120

/** True while the viewport has been still for SETTLE_MS. */
function useViewportSettled(): boolean {
  const { x, y, zoom } = useViewport()
  // A pane-size flap is motion too. Watching only x/y/zoom left a
  // zero-cooldown hole (Pilot's phone-crash hunt, 2026-08-27): a one-render
  // geometry change dropped the overlay winner AND re-admitted it on the very
  // next render, because the drop itself never re-armed this debounce — each
  // cycle a full xterm mount, six transcript fetches and a resize burst.
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)
  const [settled, setSettled] = useState(true)
  useEffect(() => {
    setSettled(false)
    const timer = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [x, y, zoom, paneWidth, paneHeight])
  return settled
}

/**
 * Window-space rects (clamped to the stage) plus the set of node ids whose
 * projected size crosses the fullscreen coverage threshold. A node already
 * showing its full view keeps tracking the viewport every frame; a node
 * entering waits for the viewport to settle, so the zoom animation plays on
 * the thumbnail and the full view fades in at the end.
 */
export interface LodLayout {
  activeIds: Set<string>
  rects: Record<string, ScreenRect>
  /** Most-covered active node — the one a single shared composer targets. */
  primaryId: string | null
}

/**
 * ONE instance arbitrates ALL full-view overlays (terminals AND browsers —
 * Magpie E2: two per-kind instances each picked their own remote winner, so
 * a browser view stacked over the terminal overlay and stole every tap).
 * App owns the single call over the combined node list; layers consume it.
 */
export function useLodLayout(
  nodes: LodNode[],
  allowAutoOpen = true,
  focusedId: string | null = null,
  arrivedId: string | null = null
): LodLayout {
  const { x: vx, y: vy, zoom } = useViewport()
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)
  const domNode = useStore((s) => s.domNode)
  const settled = useViewportSettled()
  const prevActive = useRef<Set<string>>(new Set())
  const prevPrimary = useRef<string | null>(null)

  // The stage doesn't move during pan/zoom — only re-measure when its size
  // changes, not on every viewport frame.
  const bounds = useMemo(
    () => domNode?.getBoundingClientRect() ?? { left: 0, top: 0 },
    [domNode, paneWidth, paneHeight]
  )

  const rects: Record<string, ScreenRect> = {}
  const activeIds = new Set<string>()
  const coverages: Record<string, number> = {}

  for (const node of nodes) {
    if (!hasLodGeometry(node)) continue
    const { visible, coverage } = projectToStage(
      node,
      { x: vx, y: vy, zoom },
      { width: paneWidth, height: paneHeight }
    )
    if (visible === null) continue
    rects[node.id] = {
      x: bounds.left + visible.x,
      y: bounds.top + visible.y,
      width: visible.width,
      height: visible.height
    }

    coverages[node.id] = coverage
    const wasActive = prevActive.current.has(node.id)
    const pane = { width: paneWidth, height: paneHeight }
    const eligible = isFullViewEligible(visible, coverage, pane, wasActive)
    if (admitsFullView(eligible, settled, wasActive, node.id === arrivedId)) {
      activeIds.add(node.id)
    }
  }

  // Exactly ONE full overlay mounts at a time — BOTH desktop and phone. Several
  // cards cross the coverage threshold when a neighbor is adjacent; mounting
  // every one stacks fullscreen overlays so the neighbor sliver steals the
  // interaction (rail clicks land on the wrong overlay — Magpie desktop
  // stacking bug). The winner sticks to the card already open so a deliberate
  // zoom wins over an incidentally-covered neighbor. On phone the winner also
  // takes the WHOLE stage (no card-aspect letterbox; each stacked xterm would
  // also hold a PTY stream, exhausting the 6-per-origin pool) — desktop keeps
  // the card-aspect rect. The overlay's ResizeObserver refits the PTY.
  // allowAutoOpen gates PASSIVE opens: on a phone the overview is deliberately
  // zoomed in (to bound how many cards render — mobile OOM fix), which by
  // coverage alone is indistinguishable from a deliberate tap, so a big card in
  // the overview would auto-open and trap the view. The caller passes false
  // until the user taps a card (zoomToNode), so the overview never opens one.
  // PHONE PIN (black-box round 4, 2026-08-27): a deliberately-zoomed card is
  // held open until the user leaves — eligibility flaps have no vote. The
  // canvas is ALIVE under the overlay (agents move cards, broadcasts
  // reposition them), so a one-render geometry dip kept evicting the card
  // mid-read: with the remount bypass it was the crash loop, without it the
  // owner was dumped back to the canvas nine seconds into reading. There is
  // no wheel on a phone — the ONLY honest exits are Back/ESC (zoomBack
  // clears focusedId) and the card ceasing to exist. Desktop keeps coverage
  // exits: wheel-zoom-out closing the overlay is its normal gesture.
  if (
    isRemoteMode() &&
    allowAutoOpen &&
    focusedId !== null &&
    nodes.some((n) => n.id === focusedId)
  ) {
    // Existence, not visibility: a broadcast can move the card off-viewport
    // while the owner is reading it, and the pinned overlay fills the whole
    // pane regardless of where the card itself sits.
    const only = new Set([focusedId])
    rects[focusedId] = { x: bounds.left, y: bounds.top, width: paneWidth, height: paneHeight }
    prevActive.current = only
    prevPrimary.current = focusedId
    return { activeIds: only, rects, primaryId: focusedId }
  }
  const winner = allowAutoOpen
    ? pickOverlayWinner(activeIds, coverages, prevPrimary.current, focusedId)
    : null
  if (winner === null) {
    prevActive.current = new Set()
    prevPrimary.current = null
    return { activeIds: new Set(), rects, primaryId: null }
  }
  const only = new Set([winner])
  if (isRemoteMode()) {
    rects[winner] = { x: bounds.left, y: bounds.top, width: paneWidth, height: paneHeight }
  }
  prevActive.current = only
  prevPrimary.current = winner
  return { activeIds: only, rects, primaryId: winner }
}
