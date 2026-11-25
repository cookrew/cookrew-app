import { useEffect, useState } from 'react'
import App from '../App'
import { authStore } from '../auth-gate'
import { takeSeat } from '../device-seat'
import { zoomStore } from '../zoom/zoom-store'
import { applyRouteToZoom, followZoom, type ZoomSyncDeps } from '../console/zoom-sync'
import { workspaceWatch } from '../console/workspace-watch'
import type { GuestLeave } from '../../../shared/machine-guest'
import { guestBridge } from './guest-bridge'
import { guestRouter, runGuestCommand } from './guest-steps'
import type { GuestParts } from './guest-wiring'

/**
 * ANOTHER MACHINE IN THIS DESKTOP'S WINDOW: the whole app, exactly as the
 * console draws it (console/ConsoleMachine.tsx), for the one machine the guest
 * was opened for (guest-wiring.ts). Its agents are worked here as this
 * desktop's own are: the same stage, cards, terminals, box and bar.
 *
 * What the guest adds around it, in place of the console's address: the level
 * it opens on is the window's ask (`entry`), and the zoom's outermost stop is
 * not a level of a machine: arriving there is leaving it, and the window's own
 * Devices stop takes over (zoom-sync.ts, with a router that tells the window).
 * The window's title line steps through it by command.
 */

const tell = (why: GuestLeave): void => guestBridge()?.report({ kind: 'leave', why })

export default function GuestMachine({ parts }: { parts: GuestParts }): React.JSX.Element {
  // Before the app's first render: the seat and the level the window asked for.
  const [sync] = useState(() => {
    const { entry } = parts
    if (entry.workspace !== null) takeSeat(entry.workspace)
    const workspace = workspaceWatch()
    const deps: ZoomSyncDeps = { machine: parts.machine, router: guestRouter(parts.machine, entry, tell), zoom: zoomStore, workspace }
    applyRouteToZoom(deps)
    // An artifact asked for (the bar's face of one): its full view, in its workspace's artifacts.
    if (entry.item !== null) {
      zoomStore.focusItem(entry.item)
      zoomStore.go(1, 'items')
    }
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

  useEffect(() => guestBridge()?.onCommand((command) => runGuestCommand(command, tell)), [])

  // No key held here for that machine: nothing on it can be read, and the window says so.
  useEffect(() => {
    if (!parts.keyHeld) tell('no-key')
  }, [parts.keyHeld])

  // That machine no longer takes this desktop's key (forgotten there): the window takes the guest down.
  useEffect(() => {
    const store = authStore()
    const refused = (blocked: { scope: string } | null): void => {
      if (blocked !== null && blocked.scope !== 'read-only') tell('key-refused')
    }
    refused(store.blocked())
    return store.subscribe(refused)
  }, [])

  return <App />
}
