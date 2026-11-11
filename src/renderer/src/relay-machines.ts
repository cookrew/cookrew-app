/**
 * THE ACCOUNT'S MACHINES, FROM THE CONSOLE — straight from the registry.
 *
 * The console is signed in to the account, so the list is one request to the
 * registry's API with its session; nothing about it crosses to any machine.
 * Which transport carries a machine's own data (relay, LAN, the direct link)
 * does not matter here.
 *
 * A page a machine serves itself (for a machine with no account) has no
 * session and nobody to ask: 'unavailable', not an error.
 */
import { parseAccountMachines, type AccountMachines } from '../../shared/zoom-fleet'
import type { MachineScope } from './machine-scope'
import { CROSS_ORIGIN_NO_COOKIE } from './data-plane'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export async function relayAccountMachines(scope: MachineScope, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<AccountMachines> {
  const relay = scope.relay
  if (relay === null) return { ok: false, reason: 'unavailable' }
  const session = relay.session()
  if (session === null || session === '') return { ok: false, reason: 'signed-out' }
  let response: Response
  try {
    response = await fetchImpl(`${relay.origin}/v2/me/desktops`, { ...CROSS_ORIGIN_NO_COOKIE, headers: { authorization: `Bearer ${session}` } })
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (response.status === 401) return { ok: false, reason: 'signed-out' }
  if (!response.ok) return { ok: false, reason: 'refused' }
  try {
    // The machine in scope, if any, is "this one"; at the Devices level none is.
    const machines = parseAccountMachines(await response.json(), scope.machineId)
    return machines ? { ok: true, machines } : { ok: false, reason: 'malformed' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
