// The terminal level as a scene: mount it with a full path and the agent's
// real terminal comes up over it (the pool's frame layer); unmount it and the
// terminal fades and blurs back into its warm document. It COMMITS ONLY FOR A
// FAILURE: React selects `failed` alone, which stays the same object while a
// dive opens and shows. The "Opening …" line is not React state — it listens
// to the pool and flips its own `hidden`, so a dive costs this level no
// commits. When a dive fails it offers RETRY and the classic OPEN, which is
// the desktop's own companion at its base.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { StrataPath } from '../../shared/strata'
import type { EmbedState } from '../seams'
import { fleetStore } from '../fleet/use-fleet'
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

/** The pool's seam state, whole: for parts that draw all of it. Selecting is cheaper. */
export const useEmbedState = (): EmbedState => {
  const pool = embedPool()
  return useSyncExternalStore(pool.subscribe, pool.state)
}

/** QA's fuller view (frames, timings). */
export const useEmbedView = (): EmbedView => {
  const pool = embedPool()
  return useSyncExternalStore(pool.subscribe, pool.getSnapshot)
}

const isFor = (item: { machineId: string; agentId: string } | null, path: Required<StrataPath>) =>
  item !== null && item.machineId === path.machine && item.agentId === path.agent

const agentName = (path: Required<StrataPath>): string =>
  fleetStore()
    .getSnapshot()
    .find((m) => m.id === path.machine)
    ?.levels?.workspaces.find((w) => w.id === path.workspace)
    ?.agents.find((a) => a.id === path.agent)?.name ?? 'the agent'

export function TerminalLevel({ path }: { path: Required<StrataPath> }) {
  const pool = embedPool()
  // Selected alone: the failure keeps its identity through every in-between state.
  const failure = useSyncExternalStore(pool.subscribe, () => pool.getSnapshot().failed)
  const failed = failure && isFor(failure, path) ? failure : null
  const [attempt, setAttempt] = useState(0)
  const opening = useRef<HTMLDivElement>(null)

  useEffect(() => {
    pool.open(path).catch((error: unknown) => {
      // The pool keeps the failure; a superseded dive is nobody's error.
      if (isEmbedError(error) && error.detail === SUPERSEDED) return
    })
    return () => pool.close()
    // One dive per agent, and one per RETRY.
  }, [path.machine, path.workspace, path.agent, attempt])

  // Outside React: show "Opening …" only while this dive is the one opening.
  useEffect(() => {
    const line = opening.current
    if (!line) return
    const sync = () => {
      const open = isFor(pool.state().opening, path)
      if (line.hidden === !open) return
      line.hidden = !open
      if (open) line.textContent = `Opening ${agentName(path)}…`
    }
    sync()
    return pool.subscribe(sync)
    // `failed` remounts the line after a RETRY, so the listener follows it.
  }, [pool, path.machine, path.workspace, path.agent, failed === null])

  if (!failed) {
    return <div ref={opening} role="status" aria-live="polite" hidden style={{ padding: 24, font: '14px/1.5 ui-monospace, monospace', opacity: 0.7 }} />
  }
  const why = (failed.detail ? COPY[failed.detail] : undefined) ?? COPY[failed.code] ?? COPY.unreachable
  const machine = fleetStore().getSnapshot().find((m) => m.id === path.machine)
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
