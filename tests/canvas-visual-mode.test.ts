import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  canvasVisualModeOf,
  nextCanvasVisualMode,
  visibleCanvasEdges,
  visibleCanvasNodes
} from '../src/renderer/src/canvas-visual-mode'

const nodes: Node[] = [
  { id: 'shell', type: 'terminal', position: { x: 0, y: 0 }, data: { preset: 'Shell' } },
  { id: 'claude', type: 'terminal', position: { x: 0, y: 0 }, data: { preset: 'Claude' } },
  { id: 'note', type: 'note', position: { x: 0, y: 0 }, data: {} },
  { id: 'browser', type: 'browser', position: { x: 0, y: 0 }, data: {} }
]
const edges: Edge[] = [{ id: 'cable', source: 'shell', target: 'note' }]
const appSource = readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'App.tsx'),
  'utf8'
)

describe('canvas visual modes', () => {
  it('starts on the harness and cycles through all four states', () => {
    // Tidy cables are the default, not a mode to find: a fresh canvas opens on
    // the harness, one tap hides the cables, one more shows agents only, and
    // the raw `all` view is last on the ladder for auditing the wiring.
    expect(nextCanvasVisualMode('harness')).toBe('no-cables')
    expect(nextCanvasVisualMode('no-cables')).toBe('agents')
    expect(nextCanvasVisualMode('agents')).toBe('all')
    expect(nextCanvasVisualMode('all')).toBe('harness')
  })

  it('falls back to the harness for nothing stored or an unknown value, and honours a stored choice', () => {
    expect(canvasVisualModeOf(null)).toBe('harness')
    expect(canvasVisualModeOf('stale')).toBe('harness')
    expect(canvasVisualModeOf('all')).toBe('all')
    expect(canvasVisualModeOf('no-cables')).toBe('no-cables')
  })

  it('keeps every preset terminal in agents-only, including Shell', () => {
    expect(visibleCanvasNodes(nodes, 'agents').map((node) => node.id)).toEqual(['shell', 'claude'])
  })

  it('preserves array identity in all/no-cables and omits edges in reduced modes', () => {
    expect(visibleCanvasNodes(nodes, 'all')).toBe(nodes)
    expect(visibleCanvasNodes(nodes, 'no-cables')).toBe(nodes)
    expect(visibleCanvasNodes(nodes, 'harness')).toBe(nodes)
    expect(visibleCanvasEdges(edges, 'all')).toBe(edges)
    expect(visibleCanvasEdges(edges, 'no-cables')).toEqual([])
    expect(visibleCanvasEdges(edges, 'agents')).toEqual([])
    expect(visibleCanvasEdges(edges, 'no-cables')).toBe(visibleCanvasEdges(edges, 'agents'))
  })

  it('hands ReactFlow no edges in harness mode — the harness layer draws them', () => {
    // ReactFlow's per-edge components cannot share a run between two cables;
    // the layer that can gets the whole list, and ReactFlow gets none, so no
    // cable is drawn twice.
    expect(visibleCanvasEdges(edges, 'harness')).toEqual([])
    expect(visibleCanvasEdges(edges, 'harness')).toBe(visibleCanvasEdges(edges, 'no-cables'))
  })

  it('replaces the lock slot with the visual control and mounts the harness under it', () => {
    expect(appSource).toContain('<Controls position="bottom-right" showInteractive={false}>')
    expect(appSource).toContain('className={`canvas-visual-toggle mode-${canvasVisualMode}`}')
    expect(appSource).toContain('nodes={renderedNodes}')
    expect(appSource).toContain('edges={renderedEdges}')
    expect(appSource).toContain("canvasVisualMode === 'harness' && <CableHarness")
  })
})
