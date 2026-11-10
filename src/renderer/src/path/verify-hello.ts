import { CROSS_ORIGIN_NO_COOKIE } from '../data-plane'
import { machineScope, type MachineScope } from '../machine-scope'
import type { HelloClaim } from './plane-switch'

/**
 * ASK cookrew.dev WHETHER A REPLY CAME FROM MY MAC.
 *
 * One request, its deadline, and the reasoning for both. Split out of
 * companion.ts because that file is the WIRING — the handful of things the
 * switchers need from a real browser — and this is a rule with a history
 * attached to it, which is exactly the kind of thing that gets lost in a file
 * read for its wiring.
 */

/**
 * A DEADLINE, BECAUSE THIS RUNS ON A TIMER NOBODY IS WATCHING.
 *
 * `askHello` has had one from the start; this request did not, and the two sit
 * in the same race. Measured on a real phone-width Chrome: the relay's own
 * long-lived streams filled the browser's six connections to the registry's
 * origin, this POST never got a socket, and `switchPlaneIfBetter` sat in an
 * await that could not end — so `probing(false)` never ran, the badge stuck on
 * PROBING for ever, the plane never moved, and every minute the timer started
 * another request that also hung and also held a socket, until the companion's
 * own traffic to cookrew.dev died with it.
 *
 * Longer than HELLO_TIMEOUT_MS on purpose: a hello is one hop across the room
 * and this is a round trip to the registry. Long enough for a slow one, short
 * enough that a stall costs a race rather than the session.
 */
export const VERIFY_TIMEOUT_MS = 4000

/**
 * ASK THE REGISTRY WHETHER THAT REPLY CAME FROM MY MACHINE.
 *
 * The page cannot check the signature itself — the device's public key is a
 * fact the registry holds — so it asks. NOT through apiPath: apiPath addresses
 * a machine (through the relay or directly), and this is the one request in
 * the client that is for the registry itself.
 *
 *   ON A PAGE A MACHINE SERVES ITSELF the registry is asked at this page's own
 *   origin, root-relative, as it always was.
 *   ON THE CONSOLE the registry is another origin: its API host, with the
 *   console's session as a bearer and no cookie (machine-scope.ts · relay).
 *   Signed out there is nobody to ask, and nothing is asked.
 *
 * TWO DIFFERENT ANSWERS, AND THEY MUST STAY DIFFERENT:
 *
 *   NO  (returns false)  the registry answered, and does not vouch for it.
 *   COULD NOT ASK (throws)  offline, timed out, rate limited, a session that
 *                           ended or is being renewed, an answer that was not
 *                           the registry's. Nothing was learned.
 *
 * A switch treats both as "do not adopt" (path/plane-race.ts): an unproven
 * address is never trusted. The re-check of a path ALREADY proved does not
 * (path/plane-recheck.ts): a no gives the path up, and "could not ask" leaves
 * it alone. On the console the ask depends on a session renewed every few
 * minutes; folded into a no, every renewal that raced a re-check would throw a
 * working LAN path out.
 */
export class VerifyUnasked extends Error {
  constructor(why: string) {
    super(`the registry could not be asked: ${why}`)
    this.name = 'VerifyUnasked'
  }
}

export const verifyHello = async (claim: HelloClaim, timeoutMs = VERIFY_TIMEOUT_MS, scope: MachineScope = machineScope()): Promise<boolean> => {
  const relay = scope.relay
  const session = relay?.session() ?? null
  if (relay !== null && (session === null || session === '')) throw new VerifyUnasked('no session')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(relay === null ? '/v2/verify-hello' : `${relay.origin}/v2/verify-hello`, {
      method: 'POST',
      ...(relay === null ? { credentials: 'same-origin' as const } : CROSS_ORIGIN_NO_COOKIE),
      headers: { 'content-type': 'application/json', ...(relay === null ? {} : { authorization: `Bearer ${session}` }) },
      cache: 'no-store',
      signal: abort.signal,
      body: JSON.stringify(claim)
    })
  } catch {
    throw new VerifyUnasked('no answer')
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    // The session was not taken: its keeper renews it, so the next ask has one that is.
    if (response.status === 401) relay?.refused?.()
    throw new VerifyUnasked(`HTTP ${response.status}`)
  }
  let body: { ok?: unknown }
  try {
    body = (await response.json()) as { ok?: unknown }
  } catch {
    throw new VerifyUnasked('not the registry’s answer')
  }
  return body.ok === true
}
