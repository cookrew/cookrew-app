import type { Node } from '@xyflow/react'
import type { CanvasNode } from '../../shared/model'
import { DRAG_HANDLE_SELECTOR } from './nodes/drag-surface'

/**
 * ReactFlow nodes derived from the canvas state — with IDENTITY PRESERVED for
 * nodes that did not change.
 *
 * WHY. Every workspace broadcast (a rename, a tab edit, a session-id bind, an
 * add/remove — frequent during agent work) ships a whole new state over IPC, so
 * every CanvasNode arrives as a fresh deserialized object; reference equality is
 * gone at the renderer boundary. The old toFlowNodes mapped ALL of them into
 * brand-new { data, style } objects, so ReactFlow saw new `data` identity for
 * every node and re-rendered all ~91 cards even when one changed. reconcile
 * compares content and REUSES the previous flow node object for anything
 * unchanged, so a single-node edit re-renders a single card.
 */

/** Structural equality for the JSON-safe CanvasNode (no functions, no cycles). */
export function canvasNodeEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!canvasNodeEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!canvasNodeEqual(ao[k], bo[k])) return false
  }
  return true
}

/** Build one ReactFlow node from a canvas node. */
export function toFlowNode(n: CanvasNode): Node {
  return {
    id: n.id,
    type: n.kind,
    position: n.position,
    data: { node: n },
    style: { width: n.size.width, height: n.size.height },
    dragHandle: DRAG_HANDLE_SELECTOR
  }
}

/**
 * Reconcile the current flow nodes against a new canvas state. A node whose
 * content AND selected state are unchanged keeps its EXACT previous flow node
 * object (so ReactFlow skips it); everything else is rebuilt. `selected` is
 * applied here because a bare rebuild would drop it (toFlowNode carries none).
 */
export function reconcileFlowNodes(
  prev: Node[],
  nodes: CanvasNode[],
  selected: ReadonlySet<string>
): Node[] {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  return nodes.map((node) => {
    const existing = prevById.get(node.id)
    const isSelected = selected.has(node.id)
    if (
      existing &&
      (existing.selected ?? false) === isSelected &&
      canvasNodeEqual((existing.data as { node: CanvasNode }).node, node)
    ) {
      return existing // unchanged — identity preserved, no re-render
    }
    const flow = toFlowNode(node)
    return isSelected ? { ...flow, selected: true } : flow
  })
}
