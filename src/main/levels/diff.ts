// THE DELTAS between two builds, smallest first that still says everything.
//
//   a workspace that left            → workspace-gone
//   a new workspace, or one whose own
//   fields or seating changed         → workspace (whole, agents included)
//   otherwise, each changed agent     → agent
//   the focus moved                   → focus
//
// "Seating" is the agent ids in order: an agent added, removed or moved is a
// whole-workspace event, because counts and the tray move with it and a
// partial event would leave them stale. Revs are not stamped here — the
// service numbers what this returns, previous + 1 each.

import type { LevelsAgent, LevelsEvent, LevelsWorkspace } from '../../shared/levels'

/** A delta before the service stamps its rev. */
export type LevelsDelta = LevelsEvent extends infer E ? (E extends { rev: number } ? Omit<E, 'rev'> : never) : never

/** Structural equality for the plain JSON rows this module compares. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const seating = (w: LevelsWorkspace): string => w.agents.map((a) => a.id).join('\n')

/** Everything a workspace event carries besides its agents' own rows. */
const shellOf = ({ agents: _agents, ...rest }: LevelsWorkspace): Omit<LevelsWorkspace, 'agents'> => rest

export function diffLevels(
  before: { focusedWorkspaceId: string | null; workspaces: readonly LevelsWorkspace[] },
  after: { focusedWorkspaceId: string | null; workspaces: readonly LevelsWorkspace[] }
): LevelsDelta[] {
  const deltas: LevelsDelta[] = []
  const previous = new Map(before.workspaces.map((w) => [w.id, w]))
  const current = new Set(after.workspaces.map((w) => w.id))
  for (const w of before.workspaces) {
    if (!current.has(w.id)) deltas.push({ type: 'workspace-gone', workspaceId: w.id })
  }
  for (const w of after.workspaces) {
    const old = previous.get(w.id)
    if (!old || seating(old) !== seating(w) || !sameJson(shellOf(old), shellOf(w))) {
      if (!old || !sameJson(old, w)) deltas.push({ type: 'workspace', workspace: w })
      continue
    }
    const oldAgents = new Map<string, LevelsAgent>(old.agents.map((a) => [a.id, a]))
    for (const agent of w.agents) {
      if (!sameJson(oldAgents.get(agent.id), agent)) deltas.push({ type: 'agent', workspaceId: w.id, agent })
    }
  }
  if (before.focusedWorkspaceId !== after.focusedWorkspaceId) deltas.push({ type: 'focus', workspaceId: after.focusedWorkspaceId })
  return deltas
}

/** Stamp deltas with consecutive revs after `rev`. */
export function stampRevs(rev: number, deltas: readonly LevelsDelta[]): LevelsEvent[] {
  return deltas.map((delta, i) => ({ ...delta, rev: rev + i + 1 }) as LevelsEvent)
}
