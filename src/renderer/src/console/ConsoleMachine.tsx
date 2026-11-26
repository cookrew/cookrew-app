import { useEffect, useState } from 'react'
import App from '../App'
import { authStore } from '../auth-gate'
import { startMachineSession } from '../machine-session'
import { zoomStore } from '../zoom/zoom-store'
import { setMachineOpener } from '../zoom/machine-opener'
import type { ConsoleParts } from './console-wiring'
import { applyRouteToZoom, followZoom, type ZoomSyncDeps } from './zoom-sync'
import { workspaceWatch } from './workspace-watch'

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

  // Another machine opened from inside this one (a face on the bar): the console's own address for it.
  useEffect(() => {
    setMachineOpener(({ machine: other, entry }) =>
      parts.router.go({ kind: 'machine', machine: other.id, workspace: entry.workspace ?? null, agent: entry.workspace ? (entry.agent ?? null) : null, side: entry.side ?? (entry.item ? 'items' : 'agents') })
    )
    return () => setMachineOpener(null)
  }, [parts.router])

  return <App />
}
