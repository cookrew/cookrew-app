/**
 * THE ZOOM NAVIGATOR'S DEVICES, main side (renderer: zoom/use-zoom-fleet.ts).
 *
 *   zoom-fleet:subscribe     hold this desktop's levels feed; every LevelsEvent
 *   zoom-fleet:unsubscribe   is pushed on zoom-fleet:event — a snapshot first,
 *                            then deltas, from the same service the companion's
 *                            /api/levels stream serves, so the window and the
 *                            phone cannot drift apart
 *   zoom-fleet:machines      the account's desktops (shared/zoom-fleet.ts),
 *                            from the registry under this Mac's session
 *   zoom-fleet:gauges        this desktop's machine gauges, or null; the one
 *                            watch the phone's route reads (machine-gauges.ts)
 *
 * A hold is refcounted per sender, and released without a word when the page
 * reloads, the renderer crashes or the webContents ends (the board hold's
 * rules). Every subscribe reopens the service stream, so a subscriber that
 * just arrived starts from a snapshot like the first one did. A subscribe
 * before the companion server has started answers false: the renderer asks
 * again.
 */
import type { AccountRefusal, AccountResult } from '../shared/account-v2'
import type { LevelsEvent } from '../shared/strata'
import { parseAccountMachines, type AccountMachines, type AccountMachinesRefusal } from '../shared/zoom-fleet'
import { navigationEndsHold, type NavigationDetails } from './board-hold'
import { sharedGaugeWatch } from './machine-gauges'
import type { LevelsService } from './levels/service'

export const ZOOM_FLEET_EVENT_CHANNEL = 'zoom-fleet:event'

/** The slice of Electron's WebContents the hold needs — fakeable. */
export interface FleetSender {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: LevelsEvent): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface FleetHolds {
  /** One more hold for this sender, and a fresh snapshot to it. False when no service is up. */
  subscribe(sender: FleetSender): boolean
  /** One hold fewer; the last one closes the stream. False when the sender held nothing. */
  unsubscribe(sender: FleetSender): boolean
  /** Senders currently holding. */
  count(): number
}

interface Hold {
  count: number
  stream: () => void
  release: () => void
}

export function createFleetHolds(service: () => LevelsService | null): FleetHolds {
  const holds = new Map<number, Hold>()

  const openStream = (levels: LevelsService, sender: FleetSender): (() => void) =>
    levels.subscribe((event) => {
      if (!sender.isDestroyed()) sender.send(ZOOM_FLEET_EVENT_CHANNEL, event)
    })

  const open = (levels: LevelsService, sender: FleetSender): Hold => {
    const gone = (): void => release()
    const navigated = (details: unknown): void => {
      if (navigationEndsHold(details as NavigationDetails | undefined)) release()
    }
    const hold: Hold = { count: 1, stream: openStream(levels, sender), release: () => undefined }
    // A release from an earlier cycle cannot end a newer hold: the map must still point at this one.
    const release = (): void => {
      if (holds.get(sender.id) !== hold) return
      holds.delete(sender.id)
      hold.stream()
      sender.removeListener('destroyed', gone)
      sender.removeListener('render-process-gone', gone)
      sender.removeListener('did-start-navigation', navigated)
    }
    hold.release = release
    sender.on('destroyed', gone)
    sender.on('render-process-gone', gone)
    sender.on('did-start-navigation', navigated)
    return hold
  }

  return {
    subscribe: (sender) => {
      const levels = service()
      if (!levels) return false
      try {
        const held = holds.get(sender.id)
        if (!held) {
          holds.set(sender.id, open(levels, sender))
          return true
        }
        // The new stream first: a build that throws leaves the window its old one.
        const stream = openStream(levels, sender)
        held.stream()
        held.stream = stream
        held.count += 1
        return true
      } catch (error) {
        console.error('Zoom fleet stream could not open:', error)
        return false
      }
    },
    unsubscribe: (sender) => {
      const held = holds.get(sender.id)
      if (!held) return false
      held.count -= 1
      if (held.count <= 0) held.release()
      return true
    },
    count: () => holds.size
  }
}

export interface AccountMachinesDeps {
  /** Accounts.authed: one call under this Mac's session; the token never leaves it. */
  authed: (pathname: string) => Promise<AccountResult<unknown>>
  /** This Mac's registry desktop id; null with no account. */
  deviceId: () => string | null
}

const refusalOf = (reason: AccountRefusal): AccountMachinesRefusal =>
  reason === 'no_account' || reason === 'session-expired' ? 'signed-out' : reason === 'offline' ? 'offline' : 'refused'

/** The account's desktops, this Mac marked current; a refusal by name, never a throw. */
export async function accountMachines(deps: AccountMachinesDeps): Promise<AccountMachines> {
  try {
    const answer = await deps.authed('/v2/me/desktops')
    if (!answer.ok) return { ok: false, reason: refusalOf(answer.reason) }
    const machines = parseAccountMachines(answer.value, deps.deviceId())
    return machines ? { ok: true, machines } : { ok: false, reason: 'malformed' }
  } catch (error) {
    console.error('The account’s desktops could not be asked for:', error)
    return { ok: false, reason: 'failed' }
  }
}

/** ipcMain.handle's shape (restore.ts · IpcHandleFn). */
type Handle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void

const senderOf = (event: unknown): FleetSender | null => {
  const sender = (event as { sender?: unknown } | null)?.sender
  return typeof sender === 'object' && sender !== null ? (sender as FleetSender) : null
}

export interface ZoomFleetIpcDeps extends AccountMachinesDeps {
  /** This desktop's levels service (mobile-server.ts · localLevelsService); null before the companion starts. */
  service: () => LevelsService | null
}

export function registerZoomFleetIpc(handle: Handle, deps: ZoomFleetIpcDeps): FleetHolds {
  const holds = createFleetHolds(deps.service)
  handle('zoom-fleet:subscribe', (event) => {
    const sender = senderOf(event)
    return sender ? holds.subscribe(sender) : false
  })
  handle('zoom-fleet:unsubscribe', (event) => {
    const sender = senderOf(event)
    return sender ? holds.unsubscribe(sender) : false
  })
  handle('zoom-fleet:machines', () => accountMachines(deps))
  handle('zoom-fleet:gauges', () =>
    sharedGaugeWatch()
      .read()
      .catch((error: unknown) => {
        console.error('The machine gauges could not be read:', error)
        return null
      })
  )
  return holds
}
