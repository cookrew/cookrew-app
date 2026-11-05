import { clientBase, clientSlug } from './api-base'

/**
 * WHICH WORKSPACE THIS PHONE IS ON (box user test 2, bug 10; ruling 11-04).
 *
 * Focus was one value on the Mac, so a tap here moved the desktop's screen. It
 * is this device's own now: the phone keeps the id, sends it with every request
 * as `?seat=`, and the Mac answers for that workspace (mobile-api.ts). No seat
 * means the phone has not chosen, and it follows the desktop as it always did.
 *
 * A query parameter, not a header: the same URL survives the relay, the LAN
 * plane and the data channel, and it is the only way an EventSource can say it.
 * Keyed by the served base, because one origin reaches several Macs through the
 * relay and an id means nothing on another machine.
 */
const key = (): string => `cookrew.seat:${clientBase()}`

function stored(): string | null {
  // A client served under a slug is already for one workspace.
  if (clientSlug()) return null
  try {
    return localStorage.getItem(key())
  } catch {
    return null
  }
}

let seat = stored()

export const deviceSeat = (): string | null => seat

export function takeSeat(id: string): void {
  seat = id
  try {
    localStorage.setItem(key(), id)
  } catch {
    // Private mode: the seat lasts as long as this page.
  }
}

function leaveSeat(): void {
  seat = null
  try {
    localStorage.removeItem(key())
  } catch {
    // Nothing kept, so nothing to forget.
  }
}

/** A request path, carrying this device's seat. */
export function seated(path: string): string {
  if (seat === null) return path
  return `${path}${path.includes('?') ? '&' : '?'}seat=${encodeURIComponent(seat)}`
}

/** Give the seat up if its workspace has gone. True when the seat just went. */
export function settleSeat(list: { workspaces: readonly { id: string }[] }): boolean {
  if (seat === null || list.workspaces.some((w) => w.id === seat)) return false
  leaveSeat()
  return true
}
