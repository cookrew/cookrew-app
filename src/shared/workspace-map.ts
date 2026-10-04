import type { CanvasNode, WorkspaceState } from './model'

/**
 * A PICTURE OF A CANVAS, DRAWN FROM ITS OWN STATE.
 *
 * The screen wall shows every workspace as a screen carrying a PHOTOGRAPH of
 * its canvas, taken by Electron at the moment the wall opens. The phone has no
 * window to photograph, and it is deliberately forbidden from triggering a
 * capture on the Mac — the Mac may be showing something else entirely, and a
 * capture fired from here would put whatever is on that screen into a
 * workspace's snapshot (remote-api.ts). So the phone contributes no pictures,
 * and its own screen read NO SNAPSHOT YET for the one workspace the reader was
 * actually standing in.
 *
 * It needs no camera. A photograph of a canvas at overview zoom IS a field of
 * rectangles, and the rectangles are already known: every node's position and
 * size. So this is that field, normalised into its own box — the same picture
 * by arithmetic instead of by compositor, available on every surface, for a
 * workspace whose state is in hand, at no cost on the wire.
 *
 * IT IS A SHAPE AND NOTHING ELSE. No names, no note bodies, no addresses: a
 * thumbnail nobody can read is also a thumbnail nobody can read over someone's
 * shoulder, and the picture is the same without them.
 *
 * Pure. The arithmetic is the whole feature, so it is the whole test.
 */

/** One node, as a rectangle in the map's own box. */
export interface WorkspaceMapCell {
  x: number
  y: number
  w: number
  h: number
  kind: CanvasNode['kind']
}

/** A canvas as rectangles, in a box of its own aspect. */
export interface WorkspaceMap {
  /** The box the cells are placed in; its ratio is the canvas's own. */
  width: number
  height: number
  cells: WorkspaceMapCell[]
}

/** Nothing to draw. A separate value so every caller compares against one thing. */
export const EMPTY_MAP: WorkspaceMap = { width: 0, height: 0, cells: [] }

/** The longer side of the box the cells are normalised into. */
const SPAN = 1000
/** No cell smaller than this: a node drawn at zero is a node the picture lost. */
const MIN_CELL = 3

/**
 * The map of a workspace, or EMPTY_MAP when there is nothing to draw.
 *
 * The box keeps the canvas's ASPECT rather than being square, because a wide
 * board squashed into a square reads as a different workspace. The longer side
 * is SPAN and the shorter is scaled from it, so a drawing can use the numbers
 * directly as a viewBox.
 */
export function workspaceMap(state: WorkspaceState | null | undefined): WorkspaceMap {
  const nodes = state?.nodes ?? []
  if (nodes.length === 0) return EMPTY_MAP

  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    const w = Math.max(1, node.size?.width ?? 1)
    const h = Math.max(1, node.size?.height ?? 1)
    const x = node.position?.x ?? 0
    const y = node.position?.y ?? 0
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + w)
    bottom = Math.max(bottom, y + h)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return EMPTY_MAP

  // A single node — or a column of them — spans nothing in one axis. Dividing
  // by that span is the classic way a thumbnail becomes NaN.
  const spanX = Math.max(1, right - left)
  const spanY = Math.max(1, bottom - top)
  const scale = SPAN / Math.max(spanX, spanY)
  const width = Math.max(1, Math.round(spanX * scale))
  const height = Math.max(1, Math.round(spanY * scale))

  const cells = nodes.map((node): WorkspaceMapCell => {
    const x = Math.round(((node.position?.x ?? 0) - left) * scale)
    const y = Math.round(((node.position?.y ?? 0) - top) * scale)
    return {
      x,
      y,
      // Clamped INTO the box as well as up from zero: a rounded edge must not
      // hang a rectangle off the side of the viewBox it was scaled for.
      w: Math.min(Math.max(MIN_CELL, Math.round(Math.max(1, node.size?.width ?? 1) * scale)), width - x),
      h: Math.min(Math.max(MIN_CELL, Math.round(Math.max(1, node.size?.height ?? 1) * scale)), height - y),
      kind: node.kind,
    }
  })
  return { width, height, cells }
}
