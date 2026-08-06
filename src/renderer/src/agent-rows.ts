import { turnViewOf, type TurnViewModel } from './turn-view-model'
import type { AgentRegistryEntry } from './agent-registry'
import type { TerminalActivity } from '../../shared/turn'

/**
 * Rows for the agents sidebar: the durable roster (who exists, everywhere)
 * joined to live turn state (what they are doing, here). Pure — no React, no
 * bridge — so the ordering and the 228→handful collapse are testable on their
 * own.
 *
 * The registry id IS the terminal node id (agent-registry.ts: "keys
 * everything"), which is what makes the join a lookup rather than a match.
 */

export type AgentPhase = 'working' | 'waiting' | 'done' | 'offline' | 'quiet'

export interface AgentRow {
  id: string
  name: string
  preset: string
  role: string | null
  orch: boolean
  active: boolean
  workspaceId: string
  workspaceName: string
  cwd: string
  spawnedAt: number
  phase: AgentPhase
  /** Bound from the SAME selector the canvas card uses. */
  turn: TurnViewModel | null
  turnCount: number
  /** THE sort key. Descending. */
  lastActivityAt: number
}

export interface WorkspaceFacet {
  id: string
  name: string
  total: number
}

export interface AgentRowsInput {
  roster: AgentRegistryEntry[]
  /** TurnTracker state — the LOADED workspace only; others have no entry. */
  activities: Record<string, TerminalActivity>
  now: number
  /** TV density puts what needs you first; interactive densities do not. */
  floatWaiting?: boolean
  /** Facet filter. Null/undefined shows every workspace. */
  workspaceId?: string | null
}

export interface AgentRows {
  /** Agents with something to show, most recently active first. */
  live: AgentRow[]
  /** Agents that have never run a turn here — the collapse. */
  quiet: AgentRow[]
  /** Counted over the whole roster, so filtering never rewrites the facets. */
  workspaces: WorkspaceFacet[]
}

/** Ordering used only when floatWaiting is on. */
const FLOAT_RANK: Record<AgentPhase, number> = {
  waiting: 0,
  working: 1,
  done: 2,
  offline: 3,
  quiet: 4,
}

/** A turn worth showing: something was asked, replied, or is on screen. */
function hasTurn(activity: TerminalActivity | undefined): boolean {
  if (!activity) return false
  if (activity.prompt !== null || activity.reply !== null) return true
  return (activity.lines ?? []).some((l) => l.trim().length > 0)
}

function phaseOf(activity: TerminalActivity | undefined, active: boolean): AgentPhase {
  if (!active) return 'offline'
  if (!activity) return 'quiet'
  switch (activity.phase) {
    case 'thinking':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'replied':
      return 'done'
    case 'idle':
      // Idle with a turn behind it has something to show; idle with nothing
      // tracked is one of the 220 that have never run here. Same test as the
      // live/quiet split, so phase and bucket can never disagree.
      return hasTurn(activity) ? 'done' : 'quiet'
  }
}

function rowOf(entry: AgentRegistryEntry, activity: TerminalActivity | undefined): AgentRow {
  return {
    id: entry.id,
    name: entry.name,
    preset: entry.preset,
    role: entry.role,
    orch: entry.orch,
    active: entry.active,
    workspaceId: entry.workspaceId,
    workspaceName: entry.workspaceName,
    cwd: entry.cwd,
    spawnedAt: entry.spawnedAt,
    phase: phaseOf(activity, entry.active),
    turn: hasTurn(activity) ? turnViewOf(activity) : null,
    turnCount: activity?.turnCount ?? 0,
    lastActivityAt: activity?.updatedAt ?? entry.spawnedAt,
  }
}

/** Facets over the WHOLE roster, in first-seen order. */
function facetsOf(roster: AgentRegistryEntry[]): WorkspaceFacet[] {
  const byId = new Map<string, WorkspaceFacet>()
  for (const entry of roster) {
    const seen = byId.get(entry.workspaceId)
    if (seen) byId.set(entry.workspaceId, { ...seen, total: seen.total + 1 })
    else
      byId.set(entry.workspaceId, {
        id: entry.workspaceId,
        name: entry.workspaceName,
        total: 1,
      })
  }
  return [...byId.values()]
}

export function buildAgentRows(input: AgentRowsInput): AgentRows {
  const { roster, activities, floatWaiting = false, workspaceId = null } = input
  const workspaces = facetsOf(roster)

  const rows = roster
    .filter((entry) => workspaceId === null || entry.workspaceId === workspaceId)
    .map((entry) => rowOf(entry, activities[entry.id]))

  // A row is quiet when there is nothing to say about it — no turn tracked at
  // all. Everything else earns a place on the timeline, including agents that
  // died mid-task, which are exactly the ones worth noticing.
  const quiet = rows.filter((row) => row.turn === null).sort((a, b) => b.spawnedAt - a.spawnedAt)

  const live = rows
    .filter((row) => row.turn !== null)
    .sort((a, b) =>
      floatWaiting && FLOAT_RANK[a.phase] !== FLOAT_RANK[b.phase]
        ? FLOAT_RANK[a.phase] - FLOAT_RANK[b.phase]
        : b.lastActivityAt - a.lastActivityAt,
    )

  return { live, quiet, workspaces }
}
