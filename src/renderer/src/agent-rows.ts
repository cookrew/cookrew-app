import {
  checkpointViewModel,
  turnViewOf,
  type LatestCheckpoint,
  type TurnViewModel,
} from './turn-view-model'
import type { ActivityClock } from './activity-clock'
import type { AgentRegistryEntry } from './agent-registry'
import { turnFailure } from '../../shared/turn-failure'
import type { TerminalActivity } from '../../shared/turn'
import type { CanvasNode, TerminalNodeData } from '../../shared/model'
import type { LaunchFailure } from '../../shared/launch-failure'

/**
 * Rows for the agents sidebar: the durable roster (who exists, everywhere)
 * joined to live turn state (what they are doing, here). Pure — no React, no
 * bridge — so the ordering and the 228→handful collapse are testable on their
 * own.
 *
 * The registry id IS the terminal node id (agent-registry.ts: "keys
 * everything"), which is what makes the join a lookup rather than a match.
 */

export type AgentPhase = 'working' | 'waiting' | 'failed' | 'done' | 'offline' | 'quiet'

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
  /** A finished turn whose reply nobody has looked at yet (the tracker's `replied`, cleared on view). */
  unread?: boolean
  /** Bound from the SAME selector the canvas card uses. */
  turn: TurnViewModel | null
  turnCount: number
  /** THE BRIEF the card was recruited for (TerminalNodeData.brief) — display only; null or absent when none or unknown here. */
  brief?: string | null
  /** Why it is not running, when that is more than resting. */
  failure?: LaunchFailure | null
  /** The model service's words, when it refused the last turn. */
  refused?: string | null
  /**
   * THE sort key, descending. Start time while a turn is in flight, last
   * output once it is done — never a value that moves on its own, or the list
   * reorders under the pointer (see sortKeyOf).
   */
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
  /**
   * Each agent's LATEST CHECKPOINT, from the same tail read the canvas card
   * uses when the live tracker has nothing (trace-perf T1). After a restart
   * the tracker knows nothing about an agent that has not spoken since, and a
   * board that read only the tracker folded the whole crew into QUIET while
   * every card on the canvas showed its last turn. Absent → tracker only.
   */
  checkpoints?: Record<string, LatestCheckpoint | null>
  now: number
  /** TV density puts what needs you first; interactive densities do not. */
  floatWaiting?: boolean
  /** Facet filter. Null/undefined shows every workspace. */
  workspaceId?: string | null
  /**
   * terminalId → when that agent last DID something (activity-clock.ts). This
   * is what "jump to the top" ranks on. Without it the rows fall back to the
   * turn's own timestamps, which is correct but coarser.
   */
  changedAt?: ActivityClock
  /** terminalId → brief, read off the loaded workspace's nodes (the registry carries none). */
  briefs?: Record<string, string>
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
  // A refused turn wants a person as much as a question does.
  failed: 0,
}

/** A turn worth showing: something was asked, replied, or is on screen. */
export function hasTurn(activity: TerminalActivity | undefined): boolean {
  if (!activity) return false
  if (activity.prompt !== null || activity.reply !== null) return true
  return (activity.lines ?? []).some((l) => l.trim().length > 0)
}

/**
 * The agents whose row would otherwise be empty: in the loaded workspace (a
 * checkpoint can only be tailed for a terminal this app holds) with nothing
 * tracked. These are the ids the board asks the trace reader about — never
 * the whole cross-workspace roster, which would be one file watch per agent
 * that ever existed.
 */
export function checkpointWanted(
  roster: readonly AgentRegistryEntry[],
  activities: Record<string, TerminalActivity>,
): string[] {
  return roster.filter((entry) => entry.active && !hasTurn(activities[entry.id])).map((e) => e.id)
}

/**
 * Fallback sort key when no activity clock is supplied, and it must still hold
 * still. `updatedAt` is stamped at
 * serialization time (turn-tracker.activityOf) and the tracker pushes every
 * 250ms while an agent works, so it advances four times a second whether or
 * not anything changed — ordering on it made the list churn continuously.
 *
 * An in-flight turn therefore ranks by when it STARTED, which is fixed for the
 * turn's whole life. A finished one ranks by its last output, which has
 * already stopped moving.
 */
function sortKeyOf(activity: TerminalActivity | undefined): number | null {
  if (!activity) return null
  const inTurn = activity.phase === 'thinking' || activity.phase === 'waiting'
  return (inTurn ? activity.turnStartedAt : null) ?? activity.updatedAt
}

function phaseOf(
  activity: TerminalActivity | undefined,
  active: boolean,
  turn: TurnViewModel | null,
): AgentPhase {
  if (!active) return 'offline'
  // Nothing tracked, but a checkpoint on file: a finished turn, which is what
  // the canvas card calls it too. Nothing at all is one of the 220 that have
  // never run here.
  if (!activity) return turn === null ? 'quiet' : 'done'
  // Its last words say the provider refused it: quiet, and no more done than that.
  if ((activity.phase === 'replied' || activity.phase === 'idle') && turnFailure(activity)) return 'failed'
  switch (activity.phase) {
    case 'thinking':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'replied':
      return 'done'
    case 'idle':
      // Idle with a turn behind it has something to show. Same test as the
      // live/quiet split, so phase and bucket can never disagree.
      return turn === null ? 'quiet' : 'done'
  }
}

function rowOf(
  entry: AgentRegistryEntry,
  activity: TerminalActivity | undefined,
  checkpoint: LatestCheckpoint | null | undefined,
  changedAt: number | undefined,
  brief: string | null,
): AgentRow {
  // The live tracker wins the moment it has anything; the checkpoint is the
  // fallback, through the same view model the card binds (T1).
  const turn = hasTurn(activity) ? turnViewOf(activity) : checkpointViewModel(checkpoint ?? null)
  const phase = phaseOf(activity, entry.active, turn)
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
    phase,
    unread: activity?.phase === 'replied',
    turn,
    turnCount: activity?.turnCount ?? 0,
    brief,
    failure: entry.failure ?? null,
    refused: phase === 'failed' && activity ? turnFailure(activity) : null,
    lastActivityAt: changedAt ?? sortKeyOf(activity) ?? entry.spawnedAt,
  }
}

/**
 * THE ROW AN UNCHANGED AGENT ALREADY HAS. Every activity push rebuilt a row
 * for every agent in every workspace (about 370 on the owner's Mac), each
 * deriving its turn view again, though a push changes one or two agents
 * (profiled while zooming: buildAgentRows 557 ms in 13 s). The activity store
 * replaces an agent's object only when it changes, and the roster's entries
 * hold still between registry pushes, so the same inputs by identity give
 * back the same row object, which also lets memoised views skip it.
 */
interface RowInputs {
  entry: AgentRegistryEntry
  activity: TerminalActivity | undefined
  checkpoint: LatestCheckpoint | null | undefined
  changedAt: number | undefined
  brief: string | null
  row: AgentRow
}
const lastRows = new Map<string, RowInputs>()

function rowFor(
  entry: AgentRegistryEntry,
  activity: TerminalActivity | undefined,
  checkpoint: LatestCheckpoint | null | undefined,
  changedAt: number | undefined,
  brief: string | null,
): AgentRow {
  const last = lastRows.get(entry.id)
  if (
    last &&
    last.entry === entry &&
    last.activity === activity &&
    last.checkpoint === checkpoint &&
    last.changedAt === changedAt &&
    last.brief === brief
  ) {
    return last.row
  }
  const row = rowOf(entry, activity, checkpoint, changedAt, brief)
  lastRows.set(entry.id, { entry, activity, checkpoint, changedAt, brief, row })
  return row
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
  const {
    roster,
    activities,
    checkpoints = {},
    floatWaiting = false,
    workspaceId = null,
    changedAt = {},
    briefs = {},
  } = input
  const workspaces = facetsOf(roster)

  const rows = roster
    .filter((entry) => workspaceId === null || entry.workspaceId === workspaceId)
    .map((entry) =>
      rowFor(entry, activities[entry.id], checkpoints[entry.id], changedAt[entry.id], briefs[entry.id] ?? null),
    )
  // Agents that left the roster take their rows with them.
  if (lastRows.size > roster.length * 2 + 64) {
    const present = new Set(roster.map((entry) => entry.id))
    for (const id of lastRows.keys()) if (!present.has(id)) lastRows.delete(id)
  }

  // A row is quiet when there is nothing to say about it — no turn tracked
  // and no checkpoint on file. Everything else earns a place on the timeline,
  // including agents that died mid-task, which are exactly the ones worth
  // noticing.
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

/** A terminal card the roster has no row for yet: a quiet row, so it is still counted and drawn. */
export function quietRowOf(t: TerminalNodeData, workspace: { readonly id: string; readonly name: string }): AgentRow {
  return {
    id: t.id,
    name: t.name,
    preset: t.preset,
    role: t.role ?? null,
    orch: t.orch === true,
    active: true,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    cwd: t.cwd,
    spawnedAt: 0,
    phase: 'quiet',
    turn: null,
    turnCount: 0,
    brief: t.brief ?? null,
    lastActivityAt: 0
  }
}

/**
 * THE CREW OF THE OPEN WORKSPACE, ONE LIST FOR EVERY VIEW OF IT (owner,
 * 2026-11-01: the agent group and the crew view disagreed on who was in it,
 * how many, and in what state). One row per terminal card, in card order:
 * its roster row when there is one (phase, turn, unread, as useCrewRows reads
 * them, with the last checkpoint behind them), a quiet row when there is not.
 * The card's own name, harness and lead flag win, as the crew view draws them.
 * The zoom view (zoom-model.ts), the stage and the agent group read this.
 */
export function crewOf(
  nodes: readonly CanvasNode[],
  rows: readonly AgentRow[],
  workspace: { readonly id: string; readonly name: string }
): AgentRow[] {
  const rowOf = new Map(rows.map((r) => [r.id, r]))
  const out: AgentRow[] = []
  for (const n of nodes) {
    if (n.kind !== 'terminal') continue
    const row = rowOf.get(n.id)
    out.push(row ? { ...row, name: n.name, preset: n.preset, orch: n.orch === true, brief: row.brief ?? n.brief ?? null } : quietRowOf(n, workspace))
  }
  return out
}
