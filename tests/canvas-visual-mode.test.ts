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
  it('cycles through all three states', () => {
    expect(nextCanvasVisualMode('all')).toBe('no-cables')
    expect(nextCanvasVisualMode('no-cables')).toBe('agents')
    expect(nextCanvasVisualMode('agents')).toBe('all')
  })

  it('falls back to all for an unknown persisted value', () => {
    expect(canvasVisualModeOf('stale')).toBe('all')
    expect(canvasVisualModeOf(null)).toBe('all')
  })

  it('keeps every preset terminal in agents-only, including Shell', () => {
    expect(visibleCanvasNodes(nodes, 'agents').map((node) => node.id)).toEqual(['shell', 'claude'])
  })

  it('preserves array identity in all/no-cables and omits edges in reduced modes', () => {
    expect(visibleCanvasNodes(nodes, 'all')).toBe(nodes)
    expect(visibleCanvasNodes(nodes, 'no-cables')).toBe(nodes)
    expect(visibleCanvasEdges(edges, 'all')).toBe(edges)
    expect(visibleCanvasEdges(edges, 'no-cables')).toEqual([])
    expect(visibleCanvasEdges(edges, 'agents')).toEqual([])
    expect(visibleCanvasEdges(edges, 'no-cables')).toBe(visibleCanvasEdges(edges, 'agents'))
  })

  it('replaces the lock slot with the three-state visual control', () => {
    expect(appSource).toContain('<Controls position="bottom-right" showInteractive={false}>')
    expect(appSource).toContain('className={`canvas-visual-toggle mode-${canvasVisualMode}`}')
    expect(appSource).toContain('nodes={renderedNodes}')
    expect(appSource).toContain('edges={renderedEdges}')
  })
})
