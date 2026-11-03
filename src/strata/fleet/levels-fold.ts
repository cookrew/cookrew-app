// Folding a desktop's levels stream into its snapshot, immutably. A delta whose
// rev is not exactly the held rev + 1 is a GAP: the caller drops the stream and
// resyncs, because a missed delta cannot be recovered from the ones after it.
import type { LevelsAgent, LevelsEvent, LevelsSnapshot, LevelsWorkspace } from '../../shared/strata'

export type FoldResult = { ok: true; levels: LevelsSnapshot } | { ok: false; reason: 'gap' | 'no-base' }

const withAgents = (workspace: LevelsWorkspace, agents: LevelsAgent[]): LevelsWorkspace => ({
  ...workspace,
  agents,
  counts: { ...workspace.counts, agents: agents.length }
})

const upsertAgent = (workspace: LevelsWorkspace, agent: LevelsAgent): LevelsWorkspace =>
  workspace.agents.some((a) => a.id === agent.id)
    ? withAgents(workspace, workspace.agents.map((a) => (a.id === agent.id ? agent : a)))
    : withAgents(workspace, [...workspace.agents, agent])

const upsertWorkspace = (workspaces: LevelsWorkspace[], workspace: LevelsWorkspace): LevelsWorkspace[] =>
  workspaces.some((w) => w.id === workspace.id)
    ? workspaces.map((w) => (w.id === workspace.id ? workspace : w))
    : [...workspaces, workspace]

/** Focus moves the 'focused' state with it: exactly one workspace is in memory. */
const refocus = (workspaces: LevelsWorkspace[], focusedId: string | null): LevelsWorkspace[] =>
  workspaces.map((w) => {
    const state = w.id === focusedId ? 'focused' : 'background'
    return w.state === state ? w : { ...w, state }
  })

const applyDelta = (levels: LevelsSnapshot, event: Exclude<LevelsEvent, { type: 'snapshot' }>): LevelsSnapshot => {
  switch (event.type) {
    case 'agent': {
      const workspaces = levels.workspaces.map((w) => (w.id === event.workspaceId ? upsertAgent(w, event.agent) : w))
      return { ...levels, rev: event.rev, workspaces }
    }
    case 'workspace':
      return { ...levels, rev: event.rev, workspaces: upsertWorkspace(levels.workspaces, event.workspace) }
    case 'workspace-gone': {
      const workspaces = levels.workspaces.filter((w) => w.id !== event.workspaceId)
      const focusedWorkspaceId = levels.focusedWorkspaceId === event.workspaceId ? null : levels.focusedWorkspaceId
      return { ...levels, rev: event.rev, workspaces, focusedWorkspaceId }
    }
    case 'focus':
      return {
        ...levels,
        rev: event.rev,
        focusedWorkspaceId: event.workspaceId,
        workspaces: refocus(levels.workspaces, event.workspaceId)
      }
  }
}

/**
 * A snapshot always lands and replaces everything, whatever its rev: the
 * stream opens with one, a restarted desktop starts its revs over, and a live
 * desktop sends one mid-stream at rev + 1 for a machine-only change or a
 * burst of more than 48 deltas. A delta lands only on rev + 1. Seating
 * changes (an agent added, removed or moved) arrive as whole 'workspace' events.
 */
export const foldLevels = (levels: LevelsSnapshot | null, event: LevelsEvent): FoldResult => {
  if (event.type === 'snapshot') return { ok: true, levels: event.snapshot }
  if (!levels) return { ok: false, reason: 'no-base' }
  if (event.rev !== levels.rev + 1) return { ok: false, reason: 'gap' }
  return { ok: true, levels: applyDelta(levels, event) }
}
