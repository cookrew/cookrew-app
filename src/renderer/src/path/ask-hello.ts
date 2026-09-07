import { addressSpaceInitFor, type AddressSpaceInit } from '../local-network'
import {
  classifyHelloFailure,
  helloHttpFailure,
  monotonicNow,
  type HelloResult
} from './hello-result'
import type { HelloReply } from './switch'

/**
 * THE ONE PROBE THE COMPANION MAKES DIRECTLY AT A MAC.
 *
 * Split out of switch.ts because it is a different KIND of thing from the
 * rules there: switch.ts holds decisions with no browser in them, and this is
 * a `fetch` with a deadline, an address-space annotation and a stopwatch. It
 * sits beside the verdict it produces (hello-result.ts), which is what a
 * reader of either one wants next.
 */

/**
 * How long a candidate has to answer.
 *
 * It is on the same Wi-Fi or it is not; an address that needs longer than this
 * is not the fast path this is looking for, and a phone must not stall on a
 * black hole while the working path sits idle.
 */
export const HELLO_TIMEOUT_MS = 800

export interface AskHelloOptions {
  readonly timeoutMs?: number
  /** A monotonic clock, injected so a failure's `ms` is a fact a test can set. */
  readonly now?: () => number
  /**
   * ASK FOR VERSION 2, by telling the Mac which endpoint this client thinks it
   * dialled. It is a HINT and never the signed value: the Mac signs what IT
   * saw, and refuses with 421 when the two disagree — which is the cheap end
   * of catching a relayed challenge. Omit it and the Mac answers version 1,
   * exactly as it always did, which is what the navigating switch wants: it
   * dials bare addresses the Mac has published no name for.
   */
  readonly origin?: string
}

/**
 * One `fetch` with a deadline, answering WHAT WENT WRONG rather than null.
 *
 * THE FIRST REQUEST TO THE HOUSE, and therefore the one that raises Chrome's
 * Local Network Access prompt. The annotation is derived from the URL rather
 * than assumed, because `targetAddressSpace` is an assertion the browser then
 * CHECKS: a tailnet candidate on 100.64/10 is public by every browser's
 * reckoning, and claiming it local would fail the probe instead of permitting
 * it. See addressSpaceInitFor.
 *
 * Whether the prompt should be allowed to appear AT ALL is a different
 * question, answered before the race starts (see the permission policy in
 * plane-switch.ts). This function only makes the request it is asked to make.
 *
 * IT USED TO RETURN NULL FOR EVERYTHING — an 800 ms timeout, a TypeError
 * thrown in 1 ms by a browser policy, a refused certificate, a 421 — and that
 * is the whole reason the owner's panel showed four LAN candidates saying "no
 * answer" and could not be read. The verdict is now a value; hello-result.ts
 * holds why it is spelled the way it is.
 */
export const askHello = async (
  url: string,
  nonce: string,
  options: AskHelloOptions = {}
): Promise<HelloResult> => {
  const now = options.now ?? monotonicNow
  const started = now()
  const since = (): number => Math.max(0, now() - started)
  const abort = new AbortController()
  // Set by OUR timer and read in the catch: an abort we caused is a timeout
  // whatever name the browser gives the exception it throws for it.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, options.timeoutMs ?? HELLO_TIMEOUT_MS)
  const asked =
    options.origin === undefined ? '' : `&origin=${encodeURIComponent(options.origin)}`
  try {
    const response = await fetch(`${url}/api/hello?nonce=${encodeURIComponent(nonce)}${asked}`, {
      ...addressSpaceInitFor(url),
      signal: abort.signal,
      // No cookies and no credentials: the answer is a public fact about the
      // Mac, and sending anything else to an address that has not yet proved
      // it IS the Mac would be sending it to whatever answered.
      credentials: 'omit',
      cache: 'no-store'
    } as AddressSpaceInit)
    if (!response.ok) return helloHttpFailure(response.status, since())
    // A body that will not parse is still an ANSWER — a captive portal's login
    // page is the common one — so it is reported by its status rather than
    // classified by the clock, which would call a fast portal a refusal and
    // send the reader to their site settings for a problem that is not there.
    const reply = await response.json().catch(() => null)
    if (reply === null || typeof reply !== 'object') {
      return helloHttpFailure(response.status, since(), 'the answer was not a hello')
    }
    return { ok: true, reply: reply as HelloReply }
  } catch (error) {
    return classifyHelloFailure({ error, ms: since(), timedOut })
  } finally {
    clearTimeout(timer)
  }
}
