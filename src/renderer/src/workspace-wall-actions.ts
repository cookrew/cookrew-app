import type { TeamMeta, WorkspaceList } from '../../shared/model'

/**
 * WHAT THE WALL CAN DO TO A WORKSPACE, decided without a DOM.
 *
 * These rules lived in the header dropdown's event handlers, where nothing
 * could check them. The dropdown is gone — the wall is the one place a
 * workspace is picked, made, given directories or removed — and the rules
 * came here so the wall enforces exactly the ones the dropdown did.
 */

export type RemovePlan =
  | { ok: false; reason: 'last' | 'unknown' }
  | { ok: true; switchTo: string | null }

/**
 * Removing the workspace you are IN switches away first — the backend also
 * guards this, but the wall does it so the canvas never vanishes from under
 * the person looking at it. The last workspace can never be removed: there
 * must always be somewhere to stand.
 */
export function planRemove(list: WorkspaceList, id: string): RemovePlan {
  if (!list.workspaces.some((w) => w.id === id)) return { ok: false, reason: 'unknown' }
  if (list.workspaces.length <= 1) return { ok: false, reason: 'last' }
  if (id !== list.activeId) return { ok: true, switchTo: null }
  const other = list.workspaces.find((w) => w.id !== id)
  return { ok: true, switchTo: other?.id ?? null }
}

/** "3 agents · Sep 20" — a template's size and age in one line. */
export function templateLabel(team: TeamMeta): string {
  const when = new Date(team.savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${team.terminalCount} agent${team.terminalCount === 1 ? '' : 's'} · ${when}`
}

/**
 * Picking a template pre-fills the name from the team, so the workspace reads
 * as an instance of it — but never over a name the person has already typed.
 */
export function nameAfterTemplate(current: string, team: string | null): string {
  if (team && !current.trim()) return team
  return current
}
