import type { Node, NodeChange } from '@xyflow/react'

/**
 * Edge snapping for card gestures. While a card is resized or dragged, its
 * moving edges magnetically align flush with the edges of the other windows
 * on the canvas, so cards can be fitted side-by-side without pixel-hunting.
 * Pure module — App.tsx routes every NodeChange batch through
 * snapCardChanges before applying it to the React Flow store.
 */

/** Snap radius in screen pixels (converted to flow units via zoom). */
export const MOUSE_SNAP_PX = 8
/** Wider magnet for coarse pointers — fingers land ~2× less precisely. */
export const TOUCH_SNAP_PX = 18

/** Per-card minimum sizes — must mirror each card's NodeResizer props. */
const MIN_SIZE: Record<string, { width: number; height: number }> = {
  terminal: { width: 240, height: 140 },
  note: { width: 180, height: 120 },
  browser: { width: 220, height: 160 }
}

export interface SnapGuide {
  axis: 'x' | 'y'
  /** Flow coordinate of the guide line on its axis. */
  at: number
  /** Span of the line along the other axis (covers both aligned cards). */
  from: number
  to: number
}

export interface SnapResult {
  changes: NodeChange[]
  guides: SnapGuide[]
  /** True while a resize or drag gesture is in progress. */
  active: boolean
  /** Ids of an in-progress card drag; [] when no drag is happening. */
  dragIds: string[]
  /** True on the batch that finishes a drag gesture. */
  dragEnded: boolean
  /** Set on the final change of a resize — the node to persist. */
  resizeEndedId: string | null
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type PositionChange = Extract<NodeChange, { type: 'position' }>
type DimensionChange = Extract<NodeChange, { type: 'dimensions' }>

function styleLength(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function rectOf(node: Node): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? styleLength(node.style?.width) ?? node.measured?.width ?? 0,
    height: node.height ?? styleLength(node.style?.height) ?? node.measured?.height ?? 0
  }
}

interface EdgeCandidate {
  /** Flow coordinate of a neighbour's edge on the snapping axis. */
  at: number
  owner: Rect
}

function edgeCandidates(others: Rect[]): { vertical: EdgeCandidate[]; horizontal: EdgeCandidate[] } {
  return {
    vertical: others.flatMap((r) => [
      { at: r.x, owner: r },
      { at: r.x + r.width, owner: r }
    ]),
    horizontal: others.flatMap((r) => [
      { at: r.y, owner: r },
      { at: r.y + r.height, owner: r }
    ])
  }
}

function nearestEdge(candidates: EdgeCandidate[], value: number, threshold: number): EdgeCandidate | null {
  let best: EdgeCandidate | null = null
  let bestDist = threshold
  for (const candidate of candidates) {
    const dist = Math.abs(candidate.at - value)
    if (dist <= bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

function guideFor(axis: 'x' | 'y', at: number, resized: Rect, owner: Rect): SnapGuide {
  return axis === 'x'
    ? { axis, at, from: Math.min(resized.y, owner.y), to: Math.max(resized.y + resized.height, owner.y + owner.height) }
    : { axis, at, from: Math.min(resized.x, owner.x), to: Math.max(resized.x + resized.width, owner.x + owner.width) }
}

function passthrough(changes: NodeChange[]): SnapResult {
  return { changes, guides: [], active: false, dragIds: [], dragEnded: false, resizeEndedId: null }
}

/**
 * Intercepts a NodeChange batch. Resize batches get their moving edges
 * snapped to nearby edges of other nodes; drag batches get the whole
 * selection shifted so its best-aligned edge sits flush with a neighbour.
 * Gesture-end batches are rewritten with the snapped store values (XYDrag
 * and XYResizer report their own unsnapped geometry on pointer-up).
 * activeDragIds distinguishes a drag-end batch from keyboard nudges, which
 * carry the same dragging:false flag and must pass through untouched.
 * radiusPx is the screen-space magnet radius — pass TOUCH_SNAP_PX on
 * coarse-pointer devices so the phone companion snaps as readily as a mouse.
 */
export function snapCardChanges(
  changes: NodeChange[],
  nodes: Node[],
  zoom: number,
  activeDragIds: ReadonlySet<string>,
  radiusPx: number = MOUSE_SNAP_PX
): SnapResult {
  const threshold = radiusPx / Math.max(zoom, 0.01)

  const dragChanges = changes.filter(
    (c): c is PositionChange => c.type === 'position' && c.dragging === true && c.position !== undefined
  )
  if (dragChanges.length > 0) return snapDrag(changes, dragChanges, nodes, threshold)

  // Drag release: XYDrag re-emits its internal (unsnapped) positions with
  // dragging:false — pin the snapped store positions instead.
  if (activeDragIds.size > 0) {
    const isDragEnd = (c: NodeChange): c is PositionChange =>
      c.type === 'position' && !c.dragging && activeDragIds.has(c.id)
    if (changes.some(isDragEnd)) {
      const pinned = changes.map((c) => {
        if (!isDragEnd(c)) return c
        const node = nodes.find((n) => n.id === c.id)
        return node ? { ...c, position: { ...node.position } } : c
      })
      return { ...passthrough(pinned), dragEnded: true }
    }
  }

  return snapResize(changes, nodes, threshold)
}

/** Shift the dragged selection so its best-aligned edge snaps flush. */
function snapDrag(
  changes: NodeChange[],
  dragChanges: PositionChange[],
  nodes: Node[],
  threshold: number
): SnapResult {
  const dragIds = dragChanges.map((c) => c.id)
  const dragIdSet = new Set(dragIds)
  const others = nodes
    .filter((n) => !dragIdSet.has(n.id))
    .map(rectOf)
    .filter((r) => r.width > 0 && r.height > 0)
  const { vertical, horizontal } = edgeCandidates(others)

  // Dragged rects at the positions this batch is about to apply.
  const moving = dragChanges.flatMap((c) => {
    const node = nodes.find((n) => n.id === c.id)
    if (!node || c.position === undefined) return []
    const rect = rectOf(node)
    return rect.width > 0 && rect.height > 0 ? [{ ...rect, x: c.position.x, y: c.position.y }] : []
  })
  if (moving.length === 0) {
    return { changes, guides: [], active: true, dragIds, dragEnded: false, resizeEndedId: null }
  }

  interface AxisSnap {
    delta: number
    at: number
    rect: Rect
    owner: Rect
  }

  const bestSnap = (
    candidates: EdgeCandidate[],
    edgesOf: (r: Rect) => number[]
  ): AxisSnap | null => {
    let best: AxisSnap | null = null
    for (const rect of moving) {
      for (const edge of edgesOf(rect)) {
        const snap = nearestEdge(candidates, edge, threshold)
        if (snap && (best === null || Math.abs(snap.at - edge) < Math.abs(best.delta))) {
          best = { delta: snap.at - edge, at: snap.at, rect, owner: snap.owner }
        }
      }
    }
    return best
  }

  const snapX = bestSnap(vertical, (r) => [r.x, r.x + r.width])
  const snapY = bestSnap(horizontal, (r) => [r.y, r.y + r.height])
  const dx = snapX?.delta ?? 0
  const dy = snapY?.delta ?? 0

  const snapped =
    dx === 0 && dy === 0
      ? changes
      : changes.map((c) =>
          dragChanges.includes(c as PositionChange) && (c as PositionChange).position !== undefined
            ? {
                ...c,
                position: {
                  x: (c as PositionChange).position!.x + dx,
                  y: (c as PositionChange).position!.y + dy
                }
              }
            : c
        )

  const guides: SnapGuide[] = []
  if (snapX) guides.push(guideFor('x', snapX.at, { ...snapX.rect, x: snapX.rect.x + dx, y: snapX.rect.y + dy }, snapX.owner))
  if (snapY) guides.push(guideFor('y', snapY.at, { ...snapY.rect, x: snapY.rect.x + dx, y: snapY.rect.y + dy }, snapY.owner))

  return { changes: snapped, guides, active: true, dragIds, dragEnded: false, resizeEndedId: null }
}

/** Snap the moving edge(s) of a NodeResizer gesture. */
function snapResize(changes: NodeChange[], nodes: Node[], threshold: number): SnapResult {
  const dimChange = changes.find((c): c is DimensionChange => c.type === 'dimensions')

  // Final change of the gesture: XYResizer reports its own (unsnapped)
  // dimensions — rewrite them with the snapped values already in the store
  // so releasing the pointer doesn't undo an engaged snap.
  if (dimChange && dimChange.resizing === false) {
    const node = nodes.find((n) => n.id === dimChange.id)
    if (!node) return { ...passthrough(changes), resizeEndedId: dimChange.id }
    const rect = rectOf(node)
    const finalChanges = changes.map((c) =>
      c === dimChange ? { ...c, dimensions: { width: rect.width, height: rect.height } } : c
    )
    return { ...passthrough(finalChanges), resizeEndedId: dimChange.id }
  }

  if (!dimChange || dimChange.resizing !== true || !dimChange.dimensions) {
    return passthrough(changes)
  }

  const node = nodes.find((n) => n.id === dimChange.id)
  if (!node) return { ...passthrough(changes), active: true }

  const posChange = changes.find(
    (c): c is PositionChange => c.type === 'position' && c.id === dimChange.id
  )

  const prev = rectOf(node)
  const min = MIN_SIZE[node.type ?? ''] ?? { width: 40, height: 40 }
  const others = nodes
    .filter((n) => n.id !== node.id)
    .map(rectOf)
    .filter((r) => r.width > 0 && r.height > 0)
  const { vertical, horizontal } = edgeCandidates(others)

  let x = posChange?.position?.x ?? prev.x
  let y = posChange?.position?.y ?? prev.y
  let width = dimChange.dimensions.width
  let height = dimChange.dimensions.height
  const guides: SnapGuide[] = []

  const leftMoving = posChange !== undefined && x !== prev.x
  const topMoving = posChange !== undefined && y !== prev.y

  if (leftMoving) {
    // Left edge follows the pointer; the right edge stays fixed.
    const right = x + width
    const snap = nearestEdge(vertical, x, threshold)
    if (snap && right - snap.at >= min.width) {
      x = snap.at
      width = right - snap.at
      guides.push(guideFor('x', snap.at, { x, y, width, height }, snap.owner))
    }
  } else if (width !== prev.width) {
    const snap = nearestEdge(vertical, x + width, threshold)
    if (snap && snap.at - x >= min.width) {
      width = snap.at - x
      guides.push(guideFor('x', snap.at, { x, y, width, height }, snap.owner))
    }
  }

  if (topMoving) {
    const bottom = y + height
    const snap = nearestEdge(horizontal, y, threshold)
    if (snap && bottom - snap.at >= min.height) {
      y = snap.at
      height = bottom - snap.at
      guides.push(guideFor('y', snap.at, { x, y, width, height }, snap.owner))
    }
  } else if (height !== prev.height) {
    const snap = nearestEdge(horizontal, y + height, threshold)
    if (snap && snap.at - y >= min.height) {
      height = snap.at - y
      guides.push(guideFor('y', snap.at, { x, y, width, height }, snap.owner))
    }
  }

  const snappedChanges = changes.map((c) => {
    if (c === dimChange) return { ...c, dimensions: { width, height } }
    if (c === posChange) return { ...c, position: { x, y } }
    return c
  })

  return { changes: snappedChanges, guides, active: true, dragIds: [], dragEnded: false, resizeEndedId: null }
}
