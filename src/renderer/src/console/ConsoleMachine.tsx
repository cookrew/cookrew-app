import { useEffect, useState } from 'react'
import App from '../App'
import { cookrew } from '../api'
import { authStore } from '../auth-gate'
import { deviceSeat } from '../device-seat'
import { startMachineSession } from '../machine-session'
import { zoomStore } from '../zoom/zoom-store'
import type { ConsoleParts } from './console-wiring'
import { applyRouteToZoom, followZoom, type ZoomSyncDeps } from './zoom-sync'

/**
 * ONE MACHINE, ON THE CONSOLE: the whole app, exactly as a phone has always
 * seen its Mac, for the machine now in scope. Its own chunk, with everything
 * the app is (the Devices level paints without it).
 *
 * What the console adds around it: the address and the zoom are kept in step
 * (zoom-sync.ts), and a machine that stops taking this browser's key is
 * handed back to the console, which asks its door again (console-runtime.ts).
 *
 * WHAT RUNS FOR THE MACHINE IN SCOPE STARTS WITH THIS CHUNK (machine-session.ts):
 * the search for a nearer way to it than the relay. Imported here and not by
 * the console's entry, so the Devices level loads without it. The module
 * restarts itself at every change of machine from then on and stops when one
 * is left; the one call below is for a machine entered BEFORE this chunk
 * arrived (a cold link straight into a machine), which nobody was listening
 * for. With no machine in scope it starts nothing.
 */
startMachineSession()

/** Which of this machine's workspaces the view is on, as the machine says it. */
function workspaceWatch(): ZoomSyncDeps['workspace'] & { start(): () => void } {
  let current: string | null = deviceSeat()
  const listeners = new Set<() => void>()
  const take = (list: { activeId?: string; seat?: string } | null | undefined): void => {
    const next = deviceSeat() ?? list?.seat ?? list?.activeId ?? null
    if (next === current || next === null || next === '') return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start: () => {
      const api = cookrew()
      const off = api.onWorkspaceList(take)
      void api.listWorkspaces().then(take, () => undefined)
      return off
    }
  }
}

export default function ConsoleMachine({ machine, parts }: { machine: string; parts: ConsoleParts }): React.JSX.Element {
  // Before the app's first render: the view starts on the level the address names.
  const [sync] = useState(() => {
    const workspace = workspaceWatch()
    const deps: ZoomSyncDeps = { machine, router: parts.router, zoom: zoomStore, workspace }
    applyRouteToZoom(deps)
    return { deps, workspace }
  })

  useEffect(() => {
    const offWorkspace = sync.workspace.start()
    const offZoom = followZoom(sync.deps)
    return () => {
      offZoom()
      offWorkspace()
    }
  }, [sync])

  useEffect(() => {
    const store = authStore()
    const refused = (blocked: { scope: string } | null): void => {
      if (blocked !== null && blocked.scope !== 'read-only') parts.runtime.keyRefused(machine)
    }
    refused(store.blocked())
    return store.subscribe(refused)
  }, [machine, parts.runtime])

  return <App />
}
