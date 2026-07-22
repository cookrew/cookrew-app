import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, useViewport } from '@xyflow/react'
import type { CanvasPosition, CanvasSize } from '../../shared/model'
import { isRemoteMode } from './api'

/**
 * Semantic-zoom (LOD) layout: cards on the canvas are thumbnails by default
 * and swap to their full renderer (live xterm / webview) only while they
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
 * The single node whose full overlay should mount. Only one may mount at a
 * time — several cards cross the coverage threshold when a neighbor is
 * adjacent, and mounting all of them stacks fullscreen overlays so the
 * neighbor sliver steals interaction (Magpie desktop stacking bug). Prefer
 * the card already open (prevPrimary) while it is still covered, so a
 * deliberate zoom stays put over an incidentally-covered neighbor; otherwise
 * the most-covered card wins. Null when nothing crosses the threshold.
 */
export function pickOverlayWinner(
  activeIds: Iterable<string>,
  coverages: Record<string, number>,
  prevPrimary: string | null
): string | null {
  const ids = new Set(activeIds)
  if (ids.size === 0) return null
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
  const [settled, setSettled] = useState(true)
  useEffect(() => {
    setSettled(false)
    const timer = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [x, y, zoom])
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
export function useLodLayout(nodes: LodNode[]): LodLayout {
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
    const sx = node.position.x * zoom + vx
    const sy = node.position.y * zoom + vy
    const sw = node.size.width * zoom
    const sh = node.size.height * zoom

    const left = Math.max(sx, 0)
    const top = Math.max(sy, 0)
    const width = Math.min(sx + sw, paneWidth) - left
    const height = Math.min(sy + sh, paneHeight) - top
    if (width <= 0 || height <= 0) continue
    rects[node.id] = { x: bounds.left + left, y: bounds.top + top, width, height }

    const coverage = Math.max(Math.min(1, sw / paneWidth), Math.min(1, sh / paneHeight))
    coverages[node.id] = coverage
    const wasActive = prevActive.current.has(node.id)
    const threshold = wasActive ? EXIT_COVERAGE : ENTER_COVERAGE
    if (coverage >= threshold && (settled || wasActive)) activeIds.add(node.id)
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
  const winner = pickOverlayWinner(activeIds, coverages, prevPrimary.current)
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
