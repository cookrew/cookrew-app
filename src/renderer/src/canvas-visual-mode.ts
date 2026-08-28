import type { Edge, Node } from '@xyflow/react'

export type CanvasVisualMode = 'all' | 'no-cables' | 'agents'

const MODES: readonly CanvasVisualMode[] = ['all', 'no-cables', 'agents']
const NO_EDGES: Edge[] = []

export function canvasVisualModeOf(value: string | null): CanvasVisualMode {
  return MODES.includes(value as CanvasVisualMode) ? (value as CanvasVisualMode) : 'all'
}

export function nextCanvasVisualMode(mode: CanvasVisualMode): CanvasVisualMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

/** Preserve the original array in modes that show every node. */
export function visibleCanvasNodes(nodes: Node[], mode: CanvasVisualMode): Node[] {
  return mode === 'agents' ? nodes.filter((node) => node.type === 'terminal') : nodes
}

/** Both reduced modes omit edges entirely, avoiding cable render work. */
export function visibleCanvasEdges(edges: Edge[], mode: CanvasVisualMode): Edge[] {
  return mode === 'all' ? edges : NO_EDGES
}
