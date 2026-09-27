import type { Edge, Node } from '@xyflow/react'

/**
 * The canvas view ladder. `harness` sits right after `all`: one tap from the
 * default shows the same cables routed around the cards and bundled where
 * they share a run (cable-route.ts), one more hides them. In harness mode
 * ReactFlow is handed NO edges — its per-edge components cannot share a run
 * between two cables — and the CableHarness layer draws the whole set.
 */
export type CanvasVisualMode = 'all' | 'harness' | 'no-cables' | 'agents'

const MODES: readonly CanvasVisualMode[] = ['all', 'harness', 'no-cables', 'agents']
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

/**
 * Only `all` lets ReactFlow draw cables. The reduced modes omit them to save
 * the render work; `harness` omits them because a separate layer draws them.
 */
export function visibleCanvasEdges(edges: Edge[], mode: CanvasVisualMode): Edge[] {
  return mode === 'all' ? edges : NO_EDGES
}
