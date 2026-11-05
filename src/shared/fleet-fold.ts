// Folding a desktop's fleet stream into its snapshot, immutably. A delta whose
// rev is not exactly the held rev + 1 is a GAP: the caller drops the stream and
// resyncs, because a missed delta cannot be recovered from the ones after it.
import type { FleetAgent, FleetEvent, FleetSnapshot, FleetWorkspace } from './fleet'

export type FoldResult = { ok: true; snapshot: FleetSnapshot } | { ok: false; reason: 'gap' | 'no-base' }

const withAgents = (workspace: FleetWorkspace, agents: FleetAgent[]): FleetWorkspace => ({
  ...workspace,
  agents,
  counts: { ...workspace.counts, agents: agents.length }
})

const upsertAgent = (workspace: FleetWorkspace, agent: FleetAgent): FleetWorkspace =>
  workspace.agents.some((a) => a.id === agent.id)
    ? withAgents(workspace, workspace.agents.map((a) => (a.id === agent.id ? agent : a)))
    : withAgents(workspace, [...workspace.agents, agent])

const upsertWorkspace = (workspaces: FleetWorkspace[], workspace: FleetWorkspace): FleetWorkspace[] =>
  workspaces.some((w) => w.id === workspace.id)
    ? workspaces.map((w) => (w.id === workspace.id ? workspace : w))
    : [...workspaces, workspace]

/** Focus moves the 'focused' state with it: exactly one workspace is in memory. */
const refocus = (workspaces: FleetWorkspace[], focusedId: string | null): FleetWorkspace[] =>
  workspaces.map((w) => {
    const state = w.id === focusedId ? 'focused' : 'background'
    return w.state === state ? w : { ...w, state }
  })

const applyDelta = (snapshot: FleetSnapshot, event: Exclude<FleetEvent, { type: 'snapshot' }>): FleetSnapshot => {
  switch (event.type) {
    case 'agent': {
      const workspaces = snapshot.workspaces.map((w) => (w.id === event.workspaceId ? upsertAgent(w, event.agent) : w))
      return { ...snapshot, rev: event.rev, workspaces }
    }
    case 'workspace':
      return { ...snapshot, rev: event.rev, workspaces: upsertWorkspace(snapshot.workspaces, event.workspace) }
    case 'workspace-gone': {
      const workspaces = snapshot.workspaces.filter((w) => w.id !== event.workspaceId)
      const focusedWorkspaceId = snapshot.focusedWorkspaceId === event.workspaceId ? null : snapshot.focusedWorkspaceId
      return { ...snapshot, rev: event.rev, workspaces, focusedWorkspaceId }
    }
    case 'focus':
      return {
        ...snapshot,
        rev: event.rev,
        focusedWorkspaceId: event.workspaceId,
        workspaces: refocus(snapshot.workspaces, event.workspaceId)
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
export const foldFleet = (snapshot: FleetSnapshot | null, event: FleetEvent): FoldResult => {
  if (event.type === 'snapshot') return { ok: true, snapshot: event.snapshot }
  if (!snapshot) return { ok: false, reason: 'no-base' }
  if (event.rev !== snapshot.rev + 1) return { ok: false, reason: 'gap' }
  return { ok: true, snapshot: applyDelta(snapshot, event) }
}
