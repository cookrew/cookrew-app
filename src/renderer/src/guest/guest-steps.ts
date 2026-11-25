import { stageSelect } from '../stage/stage-select'
import { zoomStore } from '../zoom/zoom-store'
import type { ConsoleRoute } from '../console/console-route'
import type { ZoomSyncDeps } from '../console/zoom-sync'
import type { GuestCommand, GuestEntry, GuestLeave } from '../../../shared/machine-guest'

/**
 * A GUEST MACHINE'S STEPS (GuestMachine.tsx): where it stands for zoom-sync,
 * its way out, and the window's title line stepping through it from outside.
 */

/** The router zoom-sync writes to: where the guest stands, and the way out told to the window. */
export function guestRouter(machine: string, entry: GuestEntry, leave: (why: GuestLeave) => void): ZoomSyncDeps['router'] {
  let route: ConsoleRoute = { kind: 'machine', machine, workspace: entry.workspace, agent: entry.agent, side: entry.side }
  return {
    get: () => route,
    go: (next) => {
      if (next.kind !== 'machine') return leave('devices')
      route = next
    }
  }
}

/** The window's title line, stepped from outside the guest (HeaderRoute.tsx · the inside route). */
export function runGuestCommand(command: GuestCommand, leave: (why: GuestLeave) => void): void {
  const at = zoomStore.get()
  if (command.kind === 'device') return zoomStore.go(at.v <= -1 ? -2 : -1, at.dir)
  if (command.kind === 'workspace') {
    stageSelect.clear()
    return zoomStore.go(1, 'agents')
  }
  // Back as the bar's ‹ goes; with nowhere further to go, out of the machine.
  if (!zoomStore.back('button')) leave('devices')
}
