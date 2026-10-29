// The crew as the board sees it — every workspace, each agent's phase and its
// latest checkpoint — from the board's own sources (RosterPanel.tsx), so an
// avatar's bubble says exactly what its board card said.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { advanceClock, type ActivityClock } from '../activity-clock'
import { useRoster } from '../agent-registry'
import { buildAgentRows, checkpointWanted, type AgentRow } from '../agent-rows'
import { useStreamTails } from '../stream/use-stream-tails'
import type { WorkspaceState } from '../../../shared/model'

/** One clock for every relative label on the stage. */
const TICK_MS = 30_000

export interface CrewRows {
  live: AgentRow[]
  quiet: AgentRow[]
  now: number
}

export function useCrewRows(workspace: WorkspaceState | null): CrewRows {
  const roster = useRoster()
  const activities = useActivitiesSnapshot()
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
