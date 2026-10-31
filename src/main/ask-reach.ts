// WHO A NAME CAN REACH — the card a teammate's `ask`, `check`, `note …` or
// `browser …` names, and whether reaching it must lay a cable.
//
// Owner, 2026-10-31: inside one workspace any teammate may ask any agent,
// note or browser, and the inquiry itself creates the cable. The wire stops
// being a permission granted in advance and becomes the record of who has
// asked whom — which is what the stage already reads it as (an agent's
// browsers and notes are the ones wired to it, terminal-attachments.ts).
//
// Two sources, in this order:
//   1. what the caller is already wired to, wherever it lives — a mirrored
//      edge reaches across workspaces, and a wired card always wins a name
//      clash so nothing that worked before resolves differently now;
//   2. every card on the caller's OWN canvas, found by name and wired.
// A card on another workspace's canvas is never reached unwired, and a
// caller without a canvas (a served session) is held to source 1.
import type { CanvasNode } from '../shared/model'
import type { WorkspaceNodeHit } from './store'

export type ReachKind = 'terminal' | 'note' | 'browser'

export interface ReachHit {
  node: CanvasNode
  workspaceId: string
  /** True when the caller is not wired to it yet: reaching it lays the cable. */
  wire: boolean
}

export interface ReachInput {
  selfId: string
  name: string
  kind: ReachKind
  /** The caller's existing cables, resolved across workspaces. */
  wired: readonly WorkspaceNodeHit[]
  /** The caller's own canvas; null when it may not reach beyond its wires. */
  canvas: { workspaceId: string; nodes: readonly CanvasNode[] } | null
}

export function reachByName(input: ReachInput): ReachHit | null {
  const wanted = input.name.toLowerCase()
  const matches = (node: CanvasNode): boolean =>
    node.id !== input.selfId && node.kind === input.kind && node.name.toLowerCase() === wanted
  const wired = input.wired.find((hit) => matches(hit.node))
  if (wired) return { node: wired.node, workspaceId: wired.workspaceId, wire: false }
  if (input.canvas === null) return null
  const local = input.canvas.nodes.find(matches)
  return local ? { node: local, workspaceId: input.canvas.workspaceId, wire: true } : null
}
