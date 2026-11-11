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

/**
 * THE LAST LIST ASKED FOR, AND WHEN (bytes 0.6.2). Inside a machine the
 * console asked the registry for the same list twice a minute: once for its
 * Devices list (console-devices.ts) and once for the zoom (use-zoom-fleet.ts).
 * A reader that says how old an answer it will take (`maxAgeMs`) gets the last
 * one instead of asking again; a reader that says nothing (the Devices list,
 * which asks at once when a machine goes quiet) always asks. Held for the
 * session that asked, and only in memory.
 */
let lastList: { readonly key: string; readonly at: number; readonly rows: unknown } | null = null

/** How old a list the zoom takes: the Devices list asks every minute, so it never has to ask itself. */
export const ZOOM_ACCOUNT_MAX_AGE_MS = 65_000

export interface AccountMachinesOptions {
  /** Take the last answer if it is no older than this. Absent: always ask. */
  readonly maxAgeMs?: number
  readonly now?: () => number
}

const machinesOf = (scope: MachineScope, rows: unknown): AccountMachines => {
  // The machine in scope, if any, is "this one"; at the Devices level none is.
  const machines = parseAccountMachines(rows, scope.machineId)
  return machines ? { ok: true, machines } : { ok: false, reason: 'malformed' }
}

export async function relayAccountMachines(scope: MachineScope, fetchImpl: FetchLike = (input, init) => fetch(input, init), options: AccountMachinesOptions = {}): Promise<AccountMachines> {
  const relay = scope.relay
  if (relay === null) return { ok: false, reason: 'unavailable' }
  const session = relay.session()
  if (session === null || session === '') return { ok: false, reason: 'signed-out' }
  const now = options.now ?? Date.now
  const key = `${relay.origin}\n${session}`
  if (options.maxAgeMs !== undefined && lastList !== null && lastList.key === key && now() - lastList.at <= options.maxAgeMs) {
    return machinesOf(scope, lastList.rows)
  }
  let response: Response
  try {
    response = await fetchImpl(`${relay.origin}/v2/me/desktops`, { ...CROSS_ORIGIN_NO_COOKIE, headers: { authorization: `Bearer ${session}` } })
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (response.status === 401) return { ok: false, reason: 'signed-out' }
  if (!response.ok) return { ok: false, reason: 'refused' }
  try {
    const rows: unknown = await response.json()
    const read = machinesOf(scope, rows)
    if (read.ok) lastList = { key, at: now(), rows }
    return read
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
