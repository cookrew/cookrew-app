import {
  directAddressSpaceInit,
  isLocalOrigin,
  type AddressSpaceHint,
  type AddressSpaceInit
} from '../local-network'
import {
  classifyHelloFailure,
  helloHttpFailure,
  monotonicNow,
  type HelloAttempt,
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
 * The variant the FIRST request carries, derived from the address it dials.
 *
 * `targetAddressSpace` is an assertion the browser CHECKS, so it is derived and
 * never assumed: a tailnet candidate on 100.64/10 is public by every browser's
 * reckoning, and claiming it local would fail the probe instead of permitting
 * it. Same question isLocalOrigin answers for the annotation itself.
 */
const firstHint = (url: string): AddressSpaceHint => (isLocalOrigin(url) ? 'local' : 'none')

/**
 * One `fetch` with a deadline, answering WHAT WENT WRONG rather than null.
 *
 * Its own AbortController and its own timer, so a second call is a genuinely
 * separate request with a full deadline rather than the tail of the first one's.
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
const oneHello = async (
  url: string,
  nonce: string,
  options: AskHelloOptions,
  hint: AddressSpaceHint
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
      ...(hint === 'local' ? directAddressSpaceInit() : {}),
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

/**
 * THE FIRST REQUEST TO THE HOUSE — with the hint, and then once without it.
 *
 * THE INCIDENT: Chrome 152 behind a system proxy, on the owner's Mac,
 * 2026-09-08. The probe to `192-168-2-40.<id>.d.cookrew.dev:8643` annotated
 * `targetAddressSpace: 'local'` failed in 32 ms with `TypeError: Failed to
 * fetch`, the permission stayed 'prompt', and no dialog was ever shown. A proxy
 * hides the resolved address from Chrome, so the target is classified public,
 * and Local Network Access fails a request whose declared space does not match
 * — before the prompt, before the socket. The identical request WITHOUT the
 * annotation is public → public, which is simply allowed, and the proxy's
 * DIRECT rule for d.cookrew.dev hands it to the Mac.
 *
 * SO THE HINTED REQUEST STAYS FIRST AND KEEPS ITS PLACE. On a proxy-less
 * network it is the one and only thing that raises the permission prompt, and
 * dropping it would trade a working prompt for a workaround. The fallback is
 * therefore a SECOND request, not a replacement.
 *
 * AND ONLY FOR 'blocked'. That kind means a TypeError under 50 ms — the
 * browser refusing by policy before a socket existed, which is the only failure
 * the annotation can be the cause of. A timeout was reached and did not answer;
 * a 'network' failure got as far as DNS, TLS or a refused connection; an 'http'
 * status means something answered. Retrying any of those would double the cost
 * of every dead candidate in the race for nothing.
 *
 * THE NONCE IS REUSED DELIBERATELY. The first request never arrived — that is
 * what 'blocked' means — so the Mac has not seen it, cannot have echoed it, and
 * a fresh one would only make the two attempts harder to line up.
 */
export const askHello = async (
  url: string,
  nonce: string,
  options: AskHelloOptions = {}
): Promise<HelloResult> => {
  const hint = firstHint(url)
  const first = await oneHello(url, nonce, options, hint)
  if (first.ok) return { ...first, hint }
  const refused: HelloAttempt = { hint, kind: first.kind, ms: first.ms }
  if (hint !== 'local' || first.kind !== 'blocked') return { ...first, attempts: [refused] }
  const again = await oneHello(url, nonce, options, 'none')
  if (again.ok) return { ...again, hint: 'none' }
  // The second verdict is the verdict — it is the more recent fact and it may
  // be a different kind entirely, which is itself the diagnosis: a request that
  // gets as far as the network without the hint was refused BY the hint.
  return { ...again, attempts: [refused, { hint: 'none', kind: again.kind, ms: again.ms }] }
}
