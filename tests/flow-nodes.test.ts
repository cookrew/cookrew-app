import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { reconcileFlowNodes, toFlowNode, canvasNodeEqual } from '../src/renderer/src/flow-nodes'
import {
  CARD_DRAG_SURFACE,
  DRAG_HANDLE_SELECTOR,
  TILE_DRAG_SURFACE
} from '../src/renderer/src/nodes/drag-surface'
import type { CanvasNode, TerminalNodeData } from '../src/shared/model'

function term(id: string, patch: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: `Agent ${id}`,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

/** Fresh deserialized copy — mimics the IPC boundary (no shared references). */
function ipc(nodes: CanvasNode[]): CanvasNode[] {
  return JSON.parse(JSON.stringify(nodes))
}

describe('reconcileFlowNodes — identity preservation (the re-render fix)', () => {
  it('reuses the EXACT flow node object when a node is unchanged (even across IPC copies)', () => {
    const a = term('a')
    const b = term('b')
    const prev = reconcileFlowNodes([], [a, b], new Set())
    // A broadcast arrives: same content, but fresh objects (IPC serialized).
    const incoming = ipc([a, b])
    const next = reconcileFlowNodes(prev, incoming, new Set())
    expect(next[0]).toBe(prev[0]) // identity preserved → ReactFlow skips the card
    expect(next[1]).toBe(prev[1])
    // The wrapper must not keep the old workspace payload graph alive.
    expect((next[0].data as { node: CanvasNode }).node).toBe(incoming[0])
    expect((next[1].data as { node: CanvasNode }).node).toBe(incoming[1])
  })

  it('rebuilds ONLY the node that changed; others keep identity', () => {
    const a = term('a')
    const b = term('b')
    const prev = reconcileFlowNodes([], [a, b], new Set())
    const changed = ipc([a, { ...b, name: 'Renamed' }]) as CanvasNode[]
    const next = reconcileFlowNodes(prev, changed, new Set())
    expect(next[0]).toBe(prev[0]) // a unchanged — same object
    expect(next[1]).not.toBe(prev[1]) // b changed — new object
    expect((next[1].data as { node: TerminalNodeData }).node.name).toBe('Renamed')
  })

  it('detects nested changes (position, size, forkOf)', () => {
    const a = term('a')
    const prev = reconcileFlowNodes([], [a], new Set())
    const moved = ipc([{ ...a, position: { x: 10, y: 0 } }]) as CanvasNode[]
    expect(reconcileFlowNodes(prev, moved, new Set())[0]).not.toBe(prev[0])
    const resized = ipc([{ ...a, size: { width: 500, height: 300 } }]) as CanvasNode[]
    expect(reconcileFlowNodes(prev, resized, new Set())[0]).not.toBe(prev[0])
  })

  it('carries selection and re-renders a node when its selected state flips', () => {
    const a = term('a')
    const prev = reconcileFlowNodes([], [a], new Set(['a']))
    expect(prev[0].selected).toBe(true)
    // unchanged content, still selected → identity preserved
    const same = reconcileFlowNodes(prev, ipc([a]), new Set(['a']))
    expect(same[0]).toBe(prev[0])
    // deselected → rebuilt without selected
    const deselected = reconcileFlowNodes(prev, ipc([a]), new Set())
    expect(deselected[0]).not.toBe(prev[0])
    expect(deselected[0].selected).toBeUndefined()
  })

  it('adds new nodes and drops removed ones', () => {
    const a = term('a')
    const prev = reconcileFlowNodes([], [a], new Set())
    const next = reconcileFlowNodes(prev, ipc([a, term('c')]), new Set())
    expect(next.map((n) => n.id)).toEqual(['a', 'c'])
    expect(next[0]).toBe(prev[0]) // a survives with identity
    const removed = reconcileFlowNodes(next, ipc([term('c')]), new Set())
    expect(removed.map((n) => n.id)).toEqual(['c'])
  })

  it('toFlowNode maps the shape ReactFlow expects', () => {
    const flow = toFlowNode(term('x', { position: { x: 5, y: 6 } }))
    expect(flow).toMatchObject({
      id: 'x',
      type: 'terminal',
      position: { x: 5, y: 6 },
      style: { width: 400, height: 300 },
      dragHandle: DRAG_HANDLE_SELECTOR
    })
    expect((flow.data as { node: CanvasNode }).node.id).toBe('x')
  })

  /**
   * The regression this guards: the handle named only the full card's header,
   * so when the overview tile stopped rendering one, notes and browsers could
   * not be dragged at all — at the one zoom where you rearrange a board.
   *
   * There is no DOM here, so this cannot press a pointer down on a tile and
   * watch it move. What it CAN do is hold the two halves together: the
   * components render TILE_DRAG_SURFACE and the handle is built from the same
   * constant, so the only way to break the pair is to narrow the selector —
   * and that is what fails below.
   */
  it('the drag handle covers the overview tile, not just the card header', () => {
    const surfaces = DRAG_HANDLE_SELECTOR.split(',').map((s) => s.trim())
    expect(surfaces).toContain(`.${CARD_DRAG_SURFACE}`)
    expect(surfaces).toContain(`.${TILE_DRAG_SURFACE}`)
    expect(CARD_DRAG_SURFACE).not.toBe(TILE_DRAG_SURFACE)
  })

  it('every node kind carries the same handle — a tile is draggable whatever it holds', () => {
    for (const kind of ['terminal', 'note', 'browser'] as const) {
      const n = { ...term('x'), kind } as unknown as CanvasNode
      expect(toFlowNode(n).dragHandle).toBe(DRAG_HANDLE_SELECTOR)
    }
  })
})

describe('canvasNodeEqual', () => {
  it('true for structurally equal, false on any field diff', () => {
    expect(canvasNodeEqual(term('a'), ipc([term('a')])[0])).toBe(true)
    expect(canvasNodeEqual(term('a'), term('a', { orch: true }))).toBe(false)
    // IPC (JSON) drops undefined keys, so a real node never carries one — two
    // nodes that both lack forkOf compare equal.
    expect(canvasNodeEqual(ipc([term('a', { forkOf: undefined })])[0], term('a'))).toBe(true)
  })

  it('handles arrays (e.g. browser tabs) by order and content', () => {
    expect(canvasNodeEqual({ tabs: [1, 2] }, { tabs: [1, 2] })).toBe(true)
    expect(canvasNodeEqual({ tabs: [1, 2] }, { tabs: [2, 1] })).toBe(false)
    expect(canvasNodeEqual({ tabs: [1] }, { tabs: [1, 2] })).toBe(false)
  })
})
