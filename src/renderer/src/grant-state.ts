import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'
import type { GrantRoster } from '../../main/grant-roster'

/**
 * The grant roster, loaded once per surface and shared by the rows.
 *
 * ONE READ, NOT ONE PER ROW. The agent list is the place access has to be
 * legible at rest — "{n} callers" or "Nobody can call this", answered in a
 * glance — and forty rows each asking main the same question would make that
 * legibility cost forty IPC round trips. So the roster is fetched by the list
 * and handed down.
 *
 * The hook answers `null` when the owner bridge is absent, which is the same
 * answer that makes the whole surface disappear on a phone companion. Rows then
 * render no export control at all rather than an inert one.
 */
export function useGrantRoster(workspaceId: string | null): {
  roster: GrantRoster | null
  refresh: () => Promise<void>
} {
  const [roster, setRoster] = useState<GrantRoster | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = cookrew() as unknown as { grantList?: (id: string) => Promise<GrantRoster> }
    if (!api.grantList || workspaceId === null) {
      setRoster(null)
      return
    }
    try {
      setRoster(await api.grantList(workspaceId))
    } catch {
      // A roster that cannot be read is not an empty roster. Left null, so the
      // rows show nothing rather than claiming "Nobody can call this" about an
      // agent that may well be exported.
      setRoster(null)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { roster, refresh }
}

/** What one agent row needs to know about itself. */
export interface AgentExportState {
  exportable: boolean
  callers: number
  /** Calls running against this agent right now. */
  inFlight: number
}

/**
 * Read one agent's export state out of the roster.
 *
 * `null` roster → null, deliberately, and NOT a default of "not exportable".
 * An unread roster and an unexported agent are different facts, and rendering
 * the second when we only know the first would tell an author their agent is
 * private when it may be reachable from the internet.
 */
export function exportStateOf(
  roster: GrantRoster | null,
  nodeId: string
): AgentExportState | null {
  if (roster === null) return null
  const found = roster.agents.find((a) => a.nodeId === nodeId)
  if (!found) return { exportable: false, callers: 0, inFlight: 0 }
  return { exportable: true, callers: found.callers.length, inFlight: found.inFlight }
}
