import { describe, expect, it } from 'vitest'
import type { Node, NodeChange } from '@xyflow/react'
import { snapCardChanges, TOUCH_SNAP_PX } from '../src/renderer/src/card-snap'

function flowNode(id: string, x: number, y: number, width: number, height: number, type = 'terminal'): Node {
  return { id, type, position: { x, y }, data: {}, style: { width, height } }
}

function dim(id: string, width: number, height: number, resizing = true): NodeChange {
  return { id, type: 'dimensions', resizing, dimensions: { width, height } }
}

function pos(id: string, x: number, y: number, dragging?: boolean): NodeChange {
  return { id, type: 'position', position: { x, y }, dragging }
}

const NO_DRAG: ReadonlySet<string> = new Set()

// Card A at (0,0) 300×200; neighbour B to its right at x=400.
const A = flowNode('a', 0, 0, 300, 200)
const B = flowNode('b', 400, 0, 300, 200, 'note')

type DimOut = Extract<NodeChange, { type: 'dimensions' }>
type PosOut = Extract<NodeChange, { type: 'position' }>

describe('snapCardChanges — resize', () => {
  it('passes non-gesture batches through untouched', () => {
    const changes: NodeChange[] = [{ id: 'a', type: 'select', selected: true }]
    const result = snapCardChanges(changes, [A, B], 1, NO_DRAG)
    expect(result.changes).toBe(changes)
    expect(result.active).toBe(false)
    expect(result.resizeEndedId).toBeNull()
  })

  it('snaps the right edge flush to a neighbour left edge within threshold', () => {
    // Dragging bottom-right: width 395 puts the right edge at 395, 5px from B's left (400).
    const result = snapCardChanges([dim('a', 395, 200)], [A, B], 1, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions).toEqual({ width: 400, height: 200 })
    expect(result.active).toBe(true)
    expect(result.guides).toEqual([{ axis: 'x', at: 400, from: 0, to: 200 }])
  })

  it('does not snap outside the threshold', () => {
    const result = snapCardChanges([dim('a', 380, 200)], [A, B], 1, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions).toEqual({ width: 380, height: 200 })
    expect(result.guides).toEqual([])
  })

  it('scales the threshold with zoom', () => {
    // 5 flow units at zoom 2 is 10 screen px — beyond the 8px radius.
    const result = snapCardChanges([dim('a', 395, 200)], [A, B], 2, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions?.width).toBe(395)
  })

  it('widens the magnet for coarse pointers via the radius parameter', () => {
    // Same 10-screen-px gap engages when the touch radius is passed.
    const result = snapCardChanges([dim('a', 395, 200)], [A, B], 2, NO_DRAG, TOUCH_SNAP_PX)
    const change = result.changes[0] as DimOut
    expect(change.dimensions?.width).toBe(400)
  })

  it('snaps the left edge and keeps the right edge fixed', () => {
    // B's right edge is at 700; card C sits right of it and its left handle
    // is dragged to x=697 (right edge fixed at 1000).
    const C = flowNode('c', 720, 0, 280, 200)
    const result = snapCardChanges([pos('c', 697, 0), dim('c', 303, 200)], [A, B, C], 1, NO_DRAG)
    const posOut = result.changes[0] as PosOut
    const dimOut = result.changes[1] as DimOut
    expect(posOut.position).toEqual({ x: 700, y: 0 })
    expect(dimOut.dimensions).toEqual({ width: 300, height: 200 })
  })

  it('snaps top and bottom edges to horizontal neighbours', () => {
    const below = flowNode('d', 0, 260, 300, 100)
    // Bottom edge dragged to 256, 4px from d's top (260).
    const result = snapCardChanges([dim('a', 300, 256)], [A, below], 1, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions).toEqual({ width: 300, height: 260 })
    expect(result.guides).toEqual([{ axis: 'y', at: 260, from: 0, to: 300 }])
  })

  it('refuses snaps that would shrink the card below its minimum size', () => {
    // Neighbour edge at x=140 < terminal min width 240.
    const tiny = flowNode('e', 140, 300, 100, 100)
    const result = snapCardChanges([dim('a', 244, 200)], [A, tiny], 8, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions?.width).toBe(244)
  })

  it('rewrites the gesture-end change with the snapped store size', () => {
    // Store already holds the snapped 400×200; XYResizer reports 395×200.
    const snappedA = flowNode('a', 0, 0, 400, 200)
    const result = snapCardChanges([dim('a', 395, 200, false)], [snappedA, B], 1, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions).toEqual({ width: 400, height: 200 })
    expect(result.active).toBe(false)
    expect(result.resizeEndedId).toBe('a')
  })

  it('picks the nearest edge when several are in range', () => {
    const near = flowNode('f', 396, 300, 100, 100, 'note')
    const result = snapCardChanges([dim('a', 395, 200)], [A, B, near], 1, NO_DRAG)
    const change = result.changes[0] as DimOut
    expect(change.dimensions?.width).toBe(396)
  })
})

describe('snapCardChanges — drag', () => {
  it('snaps a dragged card flush against a neighbour right edge', () => {
    // A dragged so its left edge lands at 705, 5px past B's right edge (700).
    const result = snapCardChanges([pos('a', 705, 40, true)], [A, B], 1, NO_DRAG)
    const change = result.changes[0] as PosOut
    expect(change.position).toEqual({ x: 700, y: 40 })
    expect(result.dragIds).toEqual(['a'])
    expect(result.active).toBe(true)
    expect(result.guides).toContainEqual({ axis: 'x', at: 700, from: 0, to: 240 })
  })

  it('snaps on both axes independently', () => {
    // Left edge 5px from B's left (400), top edge 4px from B's bottom (200).
    const result = snapCardChanges([pos('a', 395, 204, true)], [A, B], 1, NO_DRAG)
    const change = result.changes[0] as PosOut
    expect(change.position).toEqual({ x: 400, y: 200 })
    expect(result.guides).toHaveLength(2)
  })

  it('does not snap a drag outside the threshold', () => {
    const result = snapCardChanges([pos('a', 680, 40, true)], [A, B], 1, NO_DRAG)
    const change = result.changes[0] as PosOut
    expect(change.position).toEqual({ x: 680, y: 40 })
    expect(result.guides).toEqual([])
  })

  it('moves a multi-selection by one shared delta and ignores co-dragged nodes', () => {
    // A and B dragged together (B stays 400 right of A); C is the only
    // candidate. A's right edge (x+300) lands at 597, 3px from C's left (600).
    const C = flowNode('c', 600, 0, 200, 200)
    const result = snapCardChanges(
      [pos('a', 297, 10, true), pos('b', 697, 10, true)],
      [A, B, C],
      1,
      NO_DRAG
    )
    const [aOut, bOut] = result.changes as PosOut[]
    expect(aOut.position).toEqual({ x: 300, y: 10 })
    expect(bOut.position).toEqual({ x: 700, y: 10 })
  })

  it('pins snapped store positions on the drag-end batch', () => {
    // Store holds the snapped x=700; XYDrag re-emits its internal x=705.
    const snappedA = flowNode('a', 700, 40, 300, 200)
    const result = snapCardChanges([pos('a', 705, 40, false)], [snappedA, B], 1, new Set(['a']))
    const change = result.changes[0] as PosOut
    expect(change.position).toEqual({ x: 700, y: 40 })
    expect(result.dragEnded).toBe(true)
    expect(result.active).toBe(false)
  })

  it('leaves keyboard nudges (dragging:false, no active drag) untouched', () => {
    const changes = [pos('a', 305, 0, false)]
    const result = snapCardChanges(changes, [A, B], 1, NO_DRAG)
    expect(result.changes).toBe(changes)
    expect(result.dragEnded).toBe(false)
  })
})
