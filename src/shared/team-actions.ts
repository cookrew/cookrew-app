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

/**
 * A NAME FOR A SAVE THAT ASKS NO QUESTIONS (R29).
 *
 * SAVE is the clipboard gesture — "instant, no sheet, nothing leaves the
 * machine" — and a prompt for a name is a question. But a name is how the thing
 * is found again on the shelf, so it cannot simply be omitted: an unnamed chip
 * is one the author has to open to identify, which costs more than the prompt
 * saved.
 *
 * So the name is DERIVED, and the shelf's popout carries RENAME for when the
 * derivation is wrong. That is the same trade the OS clipboard makes: paste
 * first, name later, and never block the cheap gesture on a decision.
 *
 * The shape follows the demo's own chip — "RESEARCH +2": the first agent names
 * the set and the remainder is a count. Named after the AGENTS rather than the
 * workspace because the workspace name is the same for every save made in it,
 * so a second save would collide with the first — and a collision is precisely
 * the question this function exists to avoid asking.
 */
export function derivedTeamName(
  state: WorkspaceState,
  ids: readonly string[]
): string {
  const scoped = scopeToSelection(state, ids)
  const named = scoped.nodes
    .filter((n) => n.kind === 'terminal')
    .map((n) => (n as { name?: string }).name?.trim())
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  // Nothing nameable — a selection of notes or browsers. The workspace name is
  // the honest fallback here BECAUSE there is nothing better, and the clash
  // guard still applies to it.
  if (named.length === 0) return state.name ?? 'Saved selection'
  const [first, ...rest] = named
  return rest.length === 0 ? first : `${first} +${rest.length}`
}

/**
 * The name an instant SAVE should use, avoiding a silent overwrite.
 *
 * SAVE asks nothing, and "asks nothing" must not mean "destroys something".
 * The existing bar demands a second explicit press before overwriting a
 * clashing template, and that guard is right for a named save — but a derived
 * name the author never chose must not consume it. So a derivation that
 * collides gets a numeric suffix rather than a confirmation: the author did not
 * pick this name, so they cannot be asked to defend it.
 */
export function uniqueTeamName(
  base: string,
  taken: readonly string[]
): string {
  const slugs = new Set(taken.map((n) => fileSlug(n)))
  if (!slugs.has(fileSlug(base))) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!slugs.has(fileSlug(candidate))) return candidate
  }
  return base
}
