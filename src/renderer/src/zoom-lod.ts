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
export function useLodLayout(nodes: LodNode[]): {
  activeIds: Set<string>
  rects: Record<string, ScreenRect>
  /** Most-covered active node — the one a single shared composer targets. */
  primaryId: string | null
} {
  const { x: vx, y: vy, zoom } = useViewport()
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)
  const domNode = useStore((s) => s.domNode)
  const settled = useViewportSettled()
  const prevActive = useRef<Set<string>>(new Set())

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

  // Phone (remote) mode: exactly ONE full view, taking the WHOLE stage.
  // Small screens can't afford the card-aspect letterbox, and on a phone
  // several cards can cross the coverage threshold at once — mounting every
  // one would stack fullscreen overlays (the topmost, not the intended card,
  // gets the touches) while each stacked xterm holds a PTY stream, exhausting
  // the browser's 6-per-origin connection pool and hanging all other fetches.
  // Only the best-covered card mounts; the overlay's ResizeObserver then
  // refits the terminal (PTY resize) to the phone size.
  if (isRemoteMode() && activeIds.size > 0) {
    const selected = [...activeIds].reduce((best, id) =>
      (coverages[id] ?? 0) > (coverages[best] ?? 0) ? id : best
    )
    const only = new Set([selected])
    rects[selected] = { x: bounds.left, y: bounds.top, width: paneWidth, height: paneHeight }
    prevActive.current = only
    return { activeIds: only, rects, primaryId: selected }
  }

  prevActive.current = activeIds
  const primaryId =
    activeIds.size > 0
      ? [...activeIds].reduce((best, id) =>
          (coverages[id] ?? 0) > (coverages[best] ?? 0) ? id : best
        )
      : null
  return { activeIds, rects, primaryId }
}
