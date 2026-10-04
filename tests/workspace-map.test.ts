import { describe, expect, it } from 'vitest'
import { EMPTY_MAP, workspaceMap } from '../src/shared/workspace-map'
import type { CanvasNode, WorkspaceState } from '../src/shared/model'

/**
 * A PICTURE OF THE CANVAS YOU ARE STANDING IN, drawn from its own state.
 *
 * The wall shows every workspace as a screen carrying a photograph, and the
 * photograph is taken by Electron at the moment the wall opens — so the phone,
 * which has no window to photograph and is forbidden from triggering a capture
 * on the Mac (the Mac may be showing something else entirely), never
 * contributes one. Its own screen therefore read NO SNAPSHOT YET, forever,
 * for the one workspace the reader was actually in (IMG_3470, 2026-09-28).
 *
 * The renderer already HOLDS that workspace's state, so the picture does not
 * need a camera, a route or a byte on the wire: it is the node rectangles,
 * where they sit relative to each other. A photograph of a canvas at overview
 * zoom IS a field of rectangles, so the two read as the same picture.
 *
 * NORMALISED, so the drawing needs no knowledge of the canvas coordinates it
 * came from, and ROUNDED, because a sub-pixel in a 196 px thumbnail is noise
 * with a decimal point on it. Pure: the arithmetic is the whole feature.
 */

const node = (over: Partial<CanvasNode> & { id: string }): CanvasNode =>
  ({
    kind: 'note',
    name: over.id,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    ...over,
  }) as CanvasNode

const state = (nodes: CanvasNode[]): WorkspaceState =>
  ({ id: 'w', name: 'W', dir: '/w', nodes, connections: [] }) as unknown as WorkspaceState

describe('the map of a canvas', () => {
  it('normalises the nodes into its own box, keeping their relative places', () => {
    const map = workspaceMap(
      state([
        node({ id: 'a', position: { x: 1000, y: 1000 }, size: { width: 200, height: 100 } }),
        node({ id: 'b', position: { x: 3000, y: 2000 }, size: { width: 200, height: 100 } }),
      ])
    )
    expect(map.cells).toHaveLength(2)
    // The left-most, top-most node starts the box.
    expect(map.cells[0]).toMatchObject({ x: 0, y: 0 })
    // The other sits at the far corner, minus its own extent.
    const [, far] = map.cells
    expect(far.x + far.w).toBe(map.width)
    expect(far.y + far.h).toBe(map.height)
  })

  it('keeps the canvas’s aspect, so a wide board does not read as a square one', () => {
    const wide = workspaceMap(
      state([
        node({ id: 'a', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }),
        node({ id: 'b', position: { x: 3900, y: 900 }, size: { width: 100, height: 100 } }),
      ])
    )
    expect(wide.width / wide.height).toBeCloseTo(4, 1)
  })

  it('carries each node’s kind, so the drawing can tell an agent from a note', () => {
    const map = workspaceMap(
      state([
        node({ id: 'a', kind: 'terminal' }),
        node({ id: 'b', kind: 'browser', position: { x: 500, y: 0 } }),
        node({ id: 'c', kind: 'note', position: { x: 0, y: 500 } }),
      ])
    )
    expect(map.cells.map((c) => c.kind).sort()).toEqual(['browser', 'note', 'terminal'])
  })

  it('carries no names, no content and no addresses — it is a shape', () => {
    const map = workspaceMap(
      state([node({ id: 'secret', name: 'Production keys', kind: 'note' })])
    )
    expect(JSON.stringify(map)).not.toContain('secret')
    expect(JSON.stringify(map)).not.toContain('Production keys')
  })

  it('rounds to whole units — a thumbnail has no use for a decimal', () => {
    const map = workspaceMap(
      state([
        node({ id: 'a', position: { x: 0, y: 0 }, size: { width: 333, height: 333 } }),
        node({ id: 'b', position: { x: 777, y: 111 }, size: { width: 333, height: 333 } }),
      ])
    )
    for (const cell of map.cells) {
      for (const n of [cell.x, cell.y, cell.w, cell.h]) expect(Number.isInteger(n)).toBe(true)
    }
  })

  it('is empty for an empty canvas, and for one that is not there at all', () => {
    expect(workspaceMap(state([]))).toEqual(EMPTY_MAP)
    expect(workspaceMap(null)).toEqual(EMPTY_MAP)
  })

  it('places a single node rather than dividing by a zero span', () => {
    const map = workspaceMap(state([node({ id: 'only' })]))
    expect(map.cells).toHaveLength(1)
    expect(map.width).toBeGreaterThan(0)
    expect(map.height).toBeGreaterThan(0)
    for (const n of Object.values(map.cells[0])) {
      if (typeof n === 'number') expect(Number.isFinite(n)).toBe(true)
    }
  })

  it('never draws a cell too small to see', () => {
    // One enormous note beside a normal card would otherwise scale the card
    // to nothing, and a picture with an invisible node in it is a wrong one.
    const map = workspaceMap(
      state([
        node({ id: 'huge', position: { x: 0, y: 0 }, size: { width: 20000, height: 20000 } }),
        node({ id: 'tiny', position: { x: 21000, y: 0 }, size: { width: 60, height: 40 } }),
      ])
    )
    for (const cell of map.cells) {
      expect(cell.w).toBeGreaterThan(0)
      expect(cell.h).toBeGreaterThan(0)
    }
  })
})
