import type { TeamMeta, WorkspaceState } from './model'
import { fileSlug } from './slug'

/**
 * The Figma model: a SELECTION of canvas elements is the unit of copy/save,
 * and the cables between selected elements travel with it. These helpers are
 * pure and shared — the renderer builds specs/labels from them and main
 * scopes snapshots with them, so the two sides cannot disagree about what a
 * selection contains.
 */

/**
 * The state a scoped template snapshots: selected nodes in canvas order plus
 * ONLY the cables whose both ends are selected — a dangling cable must never
 * travel. A full selection is the identity.
 */
export function scopeToSelection(state: WorkspaceState, ids: readonly string[]): WorkspaceState {
  const included = new Set(ids)
  return {
    ...state,
    nodes: state.nodes.filter((n) => included.has(n.id)),
    connections: state.connections.filter((c) => included.has(c.a) && included.has(c.b))
  }
}

export interface SelectionSummary {
  nodes: number
  terminals: number
  cables: number
}

/** Counts for the selection bar label; stale ids (not on canvas) don't count. */
export function selectionSummary(
  state: WorkspaceState,
  ids: readonly string[]
): SelectionSummary {
  const scoped = scopeToSelection(state, ids)
  return {
    nodes: scoped.nodes.length,
    terminals: scoped.nodes.filter((n) => n.kind === 'terminal').length,
    cables: scoped.connections.length
  }
}

/**
 * The saved team a SAVE with this raw input would OVERWRITE, or null. Team
 * files are keyed by fileSlug of the name, so "Kitchen Copy", "kitchen copy"
 * and "kitchen-copy" all collide — and the empty input (backend falls back
 * to the workspace name) is the likeliest collision of all. The selection
 * bar uses this to demand a second, explicit press before destroying a
 * snapshot.
 */
export function saveClash(
  teams: readonly TeamMeta[],
  rawName: string,
  workspaceName: string
): TeamMeta | null {
  const target = fileSlug(rawName.trim() || workspaceName)
  return teams.find((team) => fileSlug(team.name) === target) ?? null
}
