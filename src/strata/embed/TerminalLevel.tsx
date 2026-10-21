// The terminal level as a scene: mount it with a full path and the agent's
// real terminal comes up over it (the pool's frame layer); unmount it and the
// terminal blurs back into its warm document. While the dive is in flight it
// shows who is coming; when the dive fails it offers RETRY and the classic
// OPEN, which is the desktop's own companion at its base.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { StrataPath } from '../../shared/strata'
import { useFleet } from '../fleet/use-fleet'
import { embedPool } from './browser-pool'
import { isEmbedError, SUPERSEDED, type EmbedView } from './embed-pool'

const COPY: Record<string, string> = {
  'not-found': 'That agent is not on this machine any more.',
  offline: 'That machine is offline.',
  unauthorized: 'This browser is not paired with that machine.',
  unreachable: 'That machine could not be reached.',
  outdated: 'That machine runs an older Cookrew without this view.',
  refused: 'That machine turned the terminal away just now — it may be busy.',
  timeout: 'That machine did not answer in time.'
}

export const useEmbedView = (): EmbedView => {
  const pool = embedPool()
  return useSyncExternalStore(pool.subscribe, pool.getSnapshot)
}

export function TerminalLevel({ path }: { path: Required<StrataPath> }) {
  const view = useEmbedView()
  const machine = useFleet().find((m) => m.id === path.machine)
  const agent = machine?.levels?.workspaces.find((w) => w.id === path.workspace)?.agents.find((a) => a.id === path.agent)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const pool = embedPool()
    pool.open(path).catch((error: unknown) => {
      // The pool keeps the failure in its view; a superseded dive is nobody's error.
      if (isEmbedError(error) && error.detail === SUPERSEDED) return
    })
    return () => pool.close()
    // One dive per agent, and one per RETRY.
  }, [path.machine, path.workspace, path.agent, attempt])

  // Ids are unique only within a machine: a dive is always machine AND agent.
  const failed = view.failed?.machineId === path.machine && view.failed.agentId === path.agent ? view.failed : null
  if (!failed) {
    const opening = view.opening?.machineId === path.machine && view.opening.agentId === path.agent
    return (
      <div role="status" aria-live="polite" style={{ padding: 24, font: '14px/1.5 ui-monospace, monospace', opacity: 0.7 }}>
        {opening ? `Opening ${agent?.name ?? 'the agent'}…` : null}
      </div>
    )
  }
  const why = (failed.detail ? COPY[failed.detail] : undefined) ?? COPY[failed.code] ?? COPY.unreachable
  return (
    <div role="alert" style={{ padding: 24, font: '14px/1.5 ui-monospace, monospace', display: 'grid', gap: 12, maxWidth: 420 }}>
      <p style={{ margin: 0 }}>{why}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
        {machine && (
          <a href={machine.base} target="_blank" rel="noopener">
            Open classic
          </a>
        )}
      </div>
    </div>
  )
}
