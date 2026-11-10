/**
 * THE PHONE ASKING A DESKTOP FOR ITS GAUGES.
 *
 * NOT `req`. A 401 through `req` reports to the auth store, which sends the
 * page to the re-pair screen, and the gauges are refused to a read-only token
 * on purpose: a wall TV at the devices stop must keep showing its fleet, not
 * lose it to a gauge. Every kind of no here is the same no-reading. A hung
 * exchange is abandoned too, since it holds one of the relay's slots.
 *
 * ANOTHER DESKTOP goes through the relay on demand, one question at a time, to
 * that Mac's own /api/fleet/gauges: nothing is filed with the registry, which
 * only carries the asking. That Mac admits by its OWN token, which the phone
 * holds as `cr_token:<id>` if the owner ever paired it there. Holding none,
 * nobody is asked. This Mac's token never goes to another Mac: a credential
 * sent to a machine it was not minted for is the bug pairing-scope.ts exists
 * to prevent.
 */
import { parseMachineGauges, type MachineGauges } from '../../shared/machine-gauges'
import { tokenKeyForBase } from './pairing-scope'
import { CROSS_ORIGIN_NO_COOKIE } from './data-plane'
import { machineBaseOf, relayHeadersFor, type MachineScope } from './machine-scope'

export const GAUGES_API_PATH = '/api/fleet/gauges'
/** Past this the exchange is given back: the next question is a few seconds away anyway. */
export const GAUGE_FETCH_TIMEOUT_MS = 10_000

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Storage can be refused; a refusal means no token. */
export function storedDesktopToken(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** A reading, or null for every way of not getting one. */
export async function fetchGauges(
  path: string,
  token: string | null,
  fetcher: FetchLike,
  relay: Record<string, string> = {}
): Promise<MachineGauges | null> {
  // A plain abort, NOT AbortSignal.timeout: its TimeoutError reads as a dead link
  // in plane-fetch.ts, and a Mac too swapped to answer in time must not flip the
  // phone's data plane. Giving up on a gauge is this caller's choice.
  const giveUp = new AbortController()
  const deadline = setTimeout(() => giveUp.abort(), GAUGE_FETCH_TIMEOUT_MS)
  try {
    const response = await fetcher(path, {
      cache: 'no-store',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...relay },
      signal: giveUp.signal
    })
    return response.ok ? parseMachineGauges(await response.json()) : null
  } catch {
    return null
  } finally {
    clearTimeout(deadline)
  }
}


/**
 * ANOTHER MACHINE'S GAUGES, from the console: at that machine's own address on
 * the relay, with this browser's own token FOR THAT MACHINE and the account
 * session the relay wants beside it. Never this machine's token: a token is
 * for the machine that minted it. A page with no relay (a machine's own page)
 * has nobody to ask through.
 */
export async function relayDesktopGauges(
  scope: MachineScope,
  machineId: string,
  storedToken: (key: string) => string | null,
  fetcher: FetchLike = (input, init) => fetch(input, { ...init, ...CROSS_ORIGIN_NO_COOKIE })
): Promise<MachineGauges | null> {
  const target = machineBaseOf(machineId, scope)
  if (target === null) return null
  const token = storedToken(tokenKeyForBase(target))
  return token ? fetchGauges(`${target}${GAUGES_API_PATH}`, token, fetcher, relayHeadersFor(scope)) : null
}
