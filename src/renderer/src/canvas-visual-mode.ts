import type { Edge, Node } from '@xyflow/react'

/**
 * The canvas view ladder. `harness` is the DEFAULT: the cables routed around
 * the cards and bundled where they share a run (cable-route.ts) are what a
 * fresh canvas shows, because tidy cables are the software's own behaviour and
 * not a mode someone has to find. One tap hides them, one more shows agents
 * only, and `all` — every cable drawn straight, as it was — is still on the
 * ladder for anyone who wants to audit the raw wiring. In harness mode
 * ReactFlow is handed NO edges — its per-edge components cannot share a run
 * between two cables — and the CableHarness layer draws the whole set.
 */
export type CanvasVisualMode = 'harness' | 'no-cables' | 'agents' | 'all' | 'anatomy'

const MODES: readonly CanvasVisualMode[] = ['harness', 'no-cables', 'agents', 'all', 'anatomy']
const NO_EDGES: Edge[] = []
/** Stable identity: a fresh [] every call would defeat the caller's memo. */
const NO_NODES: Node[] = []

/** The persisted choice if it is one of ours; the harness otherwise. */
export function canvasVisualModeOf(value: string | null): CanvasVisualMode {
  return MODES.includes(value as CanvasVisualMode) ? (value as CanvasVisualMode) : 'harness'
}

export function nextCanvasVisualMode(mode: CanvasVisualMode): CanvasVisualMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

/** Preserve the original array in modes that show every node. */
export function visibleCanvasNodes(nodes: Node[], mode: CanvasVisualMode): Node[] {
  // `anatomy` draws the whole board itself, as one isometric figure over the
  // pane, so ReactFlow is handed nothing to draw: two sets of cards on one
  // canvas would fight over the same taps.
  if (mode === 'anatomy') return NO_NODES
  return mode === 'agents' ? nodes.filter((node) => node.type === 'terminal') : nodes
}

/**
 * Only `all` lets ReactFlow draw cables. The reduced modes omit them to save
 * the render work; `harness` omits them because a separate layer draws them.
 */
export function visibleCanvasEdges(edges: Edge[], mode: CanvasVisualMode): Edge[] {
  return mode === 'all' ? edges : NO_EDGES
}
