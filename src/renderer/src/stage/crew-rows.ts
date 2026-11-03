// The crew as the board sees it — every workspace, each agent's phase and its
// latest checkpoint — from the board's own sources (RosterPanel.tsx), so an
// avatar's bubble says exactly what its board card said.
import { Fragment, createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useActivitiesEvery } from '../activity-thumb-store'
import { advanceClock, type ActivityClock } from '../activity-clock'
import { useRoster } from '../agent-registry'
import { buildAgentRows, checkpointWanted, crewOf, type AgentRow } from '../agent-rows'
import { useStreamTails } from '../stream/use-stream-tails'
import type { WorkspaceState } from '../../../shared/model'

/** One clock for every relative label on the stage. */
const TICK_MS = 30_000
/**
 * The crew is read at the top of the app, so its activity is coalesced: at
 * most one update this often (activity-thumb-store.ts · useActivitiesEvery).
 */
export const CREW_ACTIVITY_MS = 300

export interface CrewRows {
  live: AgentRow[]
  quiet: AgentRow[]
  now: number
}

export function useCrewRows(workspace: WorkspaceState | null): CrewRows {
  const roster = useRoster()
  const activities = useActivitiesEvery(CREW_ACTIVITY_MS)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const clock = useRef<ActivityClock>({})
  clock.current = advanceClock(clock.current, activities, Date.now())
  const changedAt = clock.current
  const idle = useMemo(() => checkpointWanted(roster, activities), [roster, activities])
  const checkpoints = useStreamTails(idle)
  const briefs = useMemo(() => {
    const out: Record<string, string> = {}
    for (const n of workspace?.nodes ?? []) if (n.kind === 'terminal' && n.brief) out[n.id] = n.brief
    return out
  }, [workspace])
  const rows = useMemo(
    () => buildAgentRows({ roster, activities, checkpoints, now, changedAt, briefs }),
    [roster, activities, checkpoints, now, changedAt, briefs]
  )
  return { live: rows.live, quiet: rows.quiet, now }
}

export interface Crew extends CrewRows {
  /** Every row, live then quiet: the other workspaces' marks are drawn from them. */
  all: AgentRow[]
  /** The open workspace's crew, one row per terminal card (agent-rows.ts · crewOf). */
  crew: AgentRow[]
}

/**
 * The crew, read ONCE for the whole app (App.tsx): the zoom view, the stage
 * and the agent group take it as a prop, so they agree on who is in it and in
 * what state, and the roster's last-checkpoint reads are not run three times.
 */
export function useCrew(workspace: WorkspaceState | null, workspaceId: string | null): Crew {
  const rows = useCrewRows(workspace)
  const all = useMemo(() => [...rows.live, ...rows.quiet], [rows.live, rows.quiet])
  const crew = useMemo(
    () => crewOf(workspace?.nodes ?? [], all, { id: workspaceId ?? '', name: workspace?.name ?? '' }),
    [workspace?.nodes, workspace?.name, workspaceId, all]
  )
  return useMemo(() => ({ ...rows, all, crew }), [rows, all, crew])
}

/**
 * THE CREW, ONE READER, IN CONTEXT. The crew changes with agent activity
 * (coalesced, CREW_ACTIVITY_MS), and while App read it every change
 * re-rendered the whole app — header, dock, menus, every icon — to hand it to
 * three components (about 3.5 renders a second with agents working,
 * profiled 2026-11-01). Read here, only the readers below re-render: App's
 * tree is the same elements and React skips it.
 */
const CrewContext = createContext<Crew | null>(null)

export function CrewProvider({ workspace, workspaceId, children }: { workspace: WorkspaceState | null; workspaceId: string | null; children: ReactNode }): React.JSX.Element {
  const crew = useCrew(workspace, workspaceId)
  return createElement(CrewContext.Provider, { value: crew }, children)
}

/** The provider's crew, or null outside one (a test, the embed): its readers draw without it. */
export function useCrewContext(): Crew | null {
  return useContext(CrewContext)
}

/** Renders `children(crew)` with the provider's crew; re-renders with it. */
export function WithCrew({ children }: { children: (crew: Crew) => ReactNode }): React.JSX.Element {
  const crew = useContext(CrewContext)
  if (crew === null) throw new Error('WithCrew needs a CrewProvider above it')
  return createElement(Fragment, null, children(crew))
}

