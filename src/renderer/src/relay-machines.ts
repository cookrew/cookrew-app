/**
 * THE ACCOUNT'S DESKTOPS, FROM THE PHONE — straight from cookrew.dev.
 *
 * Served through the relay (`/relay/@user/desktop/<id>/`), this page IS
 * cookrew.dev, and the account cookie that let it through is same-origin: the
 * desktops list is one request to the registry, and nothing about it crosses
 * to the Mac. Whichever transport carries the data plane (relay, LAN, WebRTC)
 * does not matter here; the page's origin does not move.
 *
 * A page the Mac serves itself (LAN by address, tailnet) holds no account
 * cookie and cannot ask: 'unavailable', not an error.
 */
import { parseAccountMachines, type AccountMachines } from '../../shared/zoom-fleet'
import { desktopIdFromBase } from './pairing-scope'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export async function relayAccountMachines(base: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<AccountMachines> {
  const current = desktopIdFromBase(base)
  if (current === null) return { ok: false, reason: 'unavailable' }
  let response: Response
  try {
    response = await fetchImpl('/v2/me/desktops', { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (response.status === 401) return { ok: false, reason: 'signed-out' }
  if (!response.ok) return { ok: false, reason: 'refused' }
  try {
    const machines = parseAccountMachines(await response.json(), current)
    return machines ? { ok: true, machines } : { ok: false, reason: 'malformed' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
