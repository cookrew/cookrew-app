import type { AddressSpaceHint } from '../local-network'
import type { HelloReply } from './switch'

/**
 * WHY A FAILED PROBE HAS TO SAY WHY.
 *
 * THE INCIDENT. The owner's phone, on the relay page at cookrew.dev, opened
 * the "why this path" panel and found four LAN candidates with the same three
 * words under every one of them — "no answer" — above a 13,328 ms relay round
 * trip. Four rows that could not be told apart, and no way to tell them apart
 * afterwards either: `askHello` returned `null` for an 800 ms timeout, for a
 * TypeError thrown in 1 ms by a browser policy, for a refused certificate and
 * for a 421. One value for five different problems with five different fixes,
 * so the panel could not say which one it was and neither could anybody
 * reading a screenshot of it.
 *
 * So a failed probe now carries its own verdict, and the four kinds are chosen
 * because they send a reader to four different places:
 *
 *   blocked — the BROWSER refused before the request ever left. Local Network
 *             Access without a prompt, a CSP, mixed content. The fix is in
 *             site settings; the Mac is irrelevant.
 *
 *   network — DNS, TLS, connection refused, a Mac that is asleep. The fix is
 *             on the network or on the Mac.
 *
 *   timeout — it was reached and did not answer inside the deadline. A slow
 *             Wi-Fi, not a blocked one.
 *
 *   http    — something answered with a status. 421 is the endpoint-bound
 *             hello refusing a relayed challenge; a 404 is somebody ELSE's
 *             server on port 8643.
 *
 * HOW BLOCKED IS TOLD FROM NETWORK, given that both arrive as a bare
 * TypeError with the same message: by the CLOCK. A browser that refuses a
 * request by policy refuses it synchronously, before a socket is opened, and
 * the rejection lands in single-digit milliseconds. A DNS lookup, a TCP
 * handshake or a TLS negotiation cannot. 50 ms is far above the first and far
 * below the second on every device this runs on, so the split is a wide gap
 * rather than a fine judgement — and it is a HINT, spelled as one: the panel's
 * permission line above the rows is the authoritative statement, and
 * plane-switch.ts still re-reads the permission after a race that went quiet.
 */

/** The four ways one probe can fail, and they are four different next steps. */
export type HelloFailureKind = 'timeout' | 'blocked' | 'network' | 'http'

/** One variant's turn at the same address: what it claimed, how it died, how fast. */
export interface HelloAttempt {
  readonly hint: AddressSpaceHint
  readonly kind: HelloFailureKind
  readonly ms: number
}

/** The candidate said something, and it parsed. Whether it is the Mac is not this file's question. */
export interface HelloAnswered {
  readonly ok: true
  readonly reply: HelloReply
  /**
   * WHICH VARIANT ANSWERED, and therefore the only one the session may keep
   * using: a plane that adopts an address the hinted request cannot reach would
   * fail every fetch after the hello succeeded (Chrome 152 behind a system
   * proxy, 2026-09-08 — see local-network.ts · AddressSpaceHint).
   *
   * Absent where nothing recorded it, which reads exactly as it always did:
   * the address decides the annotation.
   */
  readonly hint?: AddressSpaceHint
}

export interface HelloFailed {
  readonly ok: false
  readonly kind: HelloFailureKind
  /**
   * EVERY VARIANT THAT WAS TRIED, in the order they were tried.
   *
   * One entry is the ordinary case. Two means the hinted request was refused
   * before it connected and the probe asked again without the annotation — and
   * two entries both saying 'blocked' is the signature the panel turns into
   * "refused with and without the hint", which sends a reader somewhere
   * different from a plain refusal.
   */
  readonly attempts?: readonly HelloAttempt[]
  /** Present only for 'http' — the status something actually answered with. */
  readonly status?: number
  /** How long the failure took to arrive. It is the evidence for `kind`. */
  readonly ms: number
  /**
   * The error's own name and the start of its message, and NEVER a URL.
   *
   * A detail is for a reader who has already been told the kind and wants the
   * browser's own words; it is not an address book. Some browsers put the
   * request URL in the message of a TLS or CORS failure, and this panel is
   * screenshotted and pasted into chats — so anything address-shaped is
   * dropped before the string is kept.
   */
  readonly detail?: string
}

export type HelloResult = HelloAnswered | HelloFailed

/**
 * A TypeError faster than this never touched the network — see the docblock.
 * Exported so a test can pin the boundary rather than re-guess it.
 */
export const BLOCKED_UNDER_MS = 50

/** As much of an error message as a row can carry. */
export const DETAIL_MAX = 80

/**
 * Anything that looks like it could name a machine.
 *
 * Deliberately broad, and it will eat an innocent "e.g." along with a
 * hostname. A detail with a word missing is a smaller harm than a detail with
 * somebody's home address in it, and the kind carries the meaning anyway.
 */
const ADDRESSY = /:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+|:\d{2,5}(?:\b|\/)/i

const scrub = (message: string): string =>
  message
    .split(/\s+/)
    .filter((word) => word.length > 0 && !ADDRESSY.test(word))
    .join(' ')

/** A thrown value's name, for a value that may not be an Error at all. */
const errorName = (error: unknown): string =>
  error instanceof Error && typeof error.name === 'string' && error.name.length > 0
    ? error.name
    : 'Error'

const errorMessage = (error: unknown): string =>
  error instanceof Error && typeof error.message === 'string' ? error.message : ''

/** `TypeError: Failed to fetch`, scrubbed and cut. Undefined when nothing is left. */
export const helloDetail = (error: unknown): string | undefined => {
  const said = scrub(errorMessage(error)).slice(0, DETAIL_MAX)
  const name = errorName(error)
  const detail = said.length > 0 ? `${name}: ${said}` : name
  return detail.length > 0 ? detail : undefined
}

/** Did the browser refuse this by policy, rather than the network by absence? */
const refusedByPolicy = (error: unknown, ms: number): boolean =>
  error instanceof TypeError && ms < BLOCKED_UNDER_MS

export interface HelloFailureInput {
  readonly error: unknown
  readonly ms: number
  /** True when OUR deadline fired. The only abort this code can cause. */
  readonly timedOut: boolean
}

/**
 * One thrown probe, read as one of the three non-HTTP kinds.
 *
 * The deadline is asked FIRST and by its own flag rather than by the error's
 * name: an abort produced by our own timer is a timeout whatever the browser
 * chose to call the exception, and reading `AbortError` off a value we did not
 * construct is how this would start lying on the next browser.
 */
export const classifyHelloFailure = (input: HelloFailureInput): HelloFailed => {
  const ms = Math.max(0, Math.round(input.ms))
  if (input.timedOut || errorName(input.error) === 'AbortError') {
    return { ok: false, kind: 'timeout', ms }
  }
  const detail = helloDetail(input.error)
  const kind: HelloFailureKind = refusedByPolicy(input.error, ms) ? 'blocked' : 'network'
  return { ok: false, kind, ms, ...(detail ? { detail } : {}) }
}

/** Something answered, and what it answered with was not a hello we can use. */
export const helloHttpFailure = (status: number, ms: number, detail?: string): HelloFailed => ({
  ok: false,
  kind: 'http',
  status,
  ms: Math.max(0, Math.round(ms)),
  ...(detail ? { detail } : {})
})

/**
 * A monotonic clock where there is one, and a wall clock where there is not.
 *
 * Lifted out of plane-race.ts so the probe and the row that describes it are
 * measured the same way; a web view without a `performance` object was already
 * handled there and is handled here.
 */
export const monotonicNow = (): number => {
  try {
    const clock = (globalThis as { performance?: { now?: () => number } }).performance
    if (typeof clock?.now === 'function') return clock.now()
  } catch {
    // Date is a worse clock and a perfectly good one for telling 6 ms from 90.
  }
  return Date.now()
}
