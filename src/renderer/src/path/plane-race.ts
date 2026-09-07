import { readHelloReply } from '../../../shared/hello-proof'
import { addressFromTrustedName } from '../../../shared/reach-names'
import type { TrustedNetwork } from '../../../shared/trusted-origin'
import { isLocalOrigin, type AddressSpaceHint } from '../local-network'
import {
  classifyHelloFailure,
  monotonicNow,
  type HelloFailed,
  type HelloResult
} from './hello-result'
import type { PlaneCandidate, PlaneSwitchDeps } from './plane-switch'

/**
 * HOW A TIER IS PROBED, MEASURED, ORDERED AND WRITTEN DOWN.
 *
 * plane-switch.ts holds the DECISION — which candidates, in what order, and
 * what counts as proof. This holds the mechanics that decision leans on, and
 * they are separated because they fail in different ways: a wrong decision
 * sends a pairing token to the wrong machine, a wrong measurement only picks a
 * slower address. Keeping them apart also keeps each file about one thing, and
 * this one is about a clock and a list.
 */

/**
 * One candidate's story, as the "why this path" panel tells it.
 *
 * THE OUTCOMES GREW BECAUSE FOUR OF THEM USED TO BE ONE. Every failed probe
 * arrived as 'no-answer' — a timeout, a browser refusing before it connected,
 * a certificate, a 421 — and the owner's panel therefore showed four LAN
 * candidates that could not be told apart. The four kinds come straight off
 * the probe's own verdict (hello-result.ts) and are never inferred here.
 *
 * 'no-answer' stays in the union and is no longer produced by a race: the
 * store is a shared value and older rows, and any producer that genuinely has
 * nothing more to say, must still be spellable.
 */
export interface PlaneAttempt {
  /** The ADDRESS the trusted label spells — never the label, which is a device id. */
  readonly name: string
  readonly outcome:
    | 'answered'
    | 'no-answer'
    | 'refused'
    | 'unverified'
    | 'timeout'
    | 'blocked'
    | 'network'
    | 'http'
  /** Present only for 'http': the status something on that port actually said. */
  readonly status?: number
  readonly ms: number | null
  readonly plane: 'LAN' | 'TAILNET'
  readonly chosen: boolean
  /** The browser's own words about a failure, scrubbed of anything address-shaped. */
  readonly detail?: string
  /**
   * THE ADDRESS-SPACE VARIANT, where it changes what the row means.
   *
   * 'none' on an answer means the probe only got through after dropping the
   * local-network annotation; 'none' on a 'blocked' row means it was refused
   * with AND without it. Both are the proxy signature (Chrome 152, 2026-09-08),
   * and both send a reader somewhere different from the plain sentence. Absent
   * everywhere it would say nothing — see toldHint.
   */
  readonly hint?: AddressSpaceHint
}

/**
 * `https://192-168-1-24.<id>.d.cookrew.dev:8643` → `192.168.1.24:8643`.
 *
 * The label carries a permanent device identifier and certificate transparency
 * publishes enough of those already; the port is kept because two desktops on
 * one machine are told apart by nothing else. Falls back to the hostname only
 * when the name spells no address, which planeCandidates has already refused —
 * so it is unreachable in practice and is there so this cannot throw.
 */
export const attemptName = (origin: string): string => {
  try {
    const url = new URL(origin)
    const address = addressFromTrustedName(url.hostname)
    const host = address ?? url.hostname
    return url.port ? `${host}:${url.port}` : host
  } catch {
    return origin
  }
}


/** What one tier's race produced: the winner if there was one, and the story. */
interface TierResult {
  readonly won: string | null
  /**
   * THE VARIANT THE WINNER'S HELLO ACTUALLY ANSWERED ON, so the plane can keep
   * talking the way that worked (Chrome 152 behind a system proxy, 2026-09-08 —
   * see local-network.ts · AddressSpaceHint). Undefined where the probe
   * recorded none, which leaves the address to decide as it always did.
   */
  readonly answeredWith?: AddressSpaceHint
  readonly attempts: readonly PlaneAttempt[]
}

/**
 * ONE TIER: probe them all, order by measurement, verify until one proves.
 *
 * The verification stops at the first proof and leaves the rest of the tier
 * unasked — the registry costs a round trip, and the panel's rows already say
 * what happened to them, which is "answered, and we did not need it".
 */
export const raceTier = async (
  tier: readonly PlaneCandidate[],
  kind: TrustedNetwork,
  deviceId: string,
  deps: PlaneSwitchDeps
): Promise<TierResult> => {
  const probes = await probeTier(tier, deviceId, deps, deps.now ?? monotonicNow)
  const plane = kind === 'lan' ? 'LAN' : 'TAILNET'
  const rows = probes.map((probe): PlaneAttempt => ({ ...rowOf(probe), plane, chosen: false }))
  return verifyInOrder(answeredFirst(probes), rows, deviceId, deps)
}

/**
 * One probe, as a row — the ONLY place a verdict becomes a word.
 *
 * A failure's own `ms` is preferred over the tier's stopwatch because it is
 * the number the sentence quotes: "timed out (800 ms)" has to be the deadline
 * that actually fired, not this loop's rounding of it.
 */
const rowOf = (probe: Probe): Omit<PlaneAttempt, 'plane' | 'chosen'> => {
  const name = attemptName(probe.origin)
  // It said something and what it said was not this Mac's hello: a wrong
  // device, a nonce it did not echo, or a signature over somebody else's
  // endpoint. That is "answered and not believed", never "no answer".
  if (probe.kind === 'unreadable') return { name, outcome: 'unverified', ms: Math.round(probe.ms) }
  const hint = probe.hint ? { hint: probe.hint } : {}
  if (probe.kind === 'answered') {
    return { name, outcome: 'answered', ms: Math.round(probe.ms), ...hint }
  }
  const { failure } = probe
  return {
    name,
    outcome: failure.kind,
    ms: failure.ms,
    ...hint,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.detail !== undefined ? { detail: failure.detail } : {})
  }
}

/**
 * Ask the registry about the fastest first, then the next, WITHIN the tier.
 *
 * A name that answers quickly and cannot prove itself must not push the phone
 * down a tier — the next-fastest address on the same network is still better
 * than the next network, and a fast unprovable answer is the exact signature
 * of somebody else's machine on this Wi-Fi.
 *
 * Recursive rather than a mutating loop so each row list is a VALUE. A
 * half-rewritten array shared across two awaits is where a "why this path"
 * panel starts describing a race that did not happen.
 */
const verifyInOrder = async (
  answered: readonly MeasuredReply[],
  rows: readonly PlaneAttempt[],
  deviceId: string,
  deps: PlaneSwitchDeps
): Promise<TierResult> => {
  const [attempt, ...rest] = answered
  if (!attempt) return { won: null, attempts: rows }
  const proved = await deps
    .verify({
      deviceId,
      nonce: attempt.nonce,
      sig: attempt.sig,
      origin: attempt.signedOrigin,
      issuedAtMs: attempt.issuedAtMs
    })
    .catch(() => false)
  const name = attemptName(attempt.origin)
  const attempts = rows.map((row) =>
    row.name === name
      ? { ...row, outcome: proved ? ('answered' as const) : ('unverified' as const), chosen: proved }
      : row
  )
  return proved
    ? {
        won: attempt.origin,
        ...(attempt.answeredWith ? { answeredWith: attempt.answeredWith } : {}),
        attempts
      }
    : verifyInOrder(rest, attempts, deviceId, deps)
}

/** One candidate that said the right words, and how long it took to say them. */
interface MeasuredReply {
  readonly origin: string
  readonly nonce: string
  readonly sig: string
  /** The endpoint the Mac itself signed, and the clock it signed at. */
  readonly signedOrigin: string
  readonly issuedAtMs: number
  readonly ms: number
  /** The address-space variant this answer came back on. See TierResult. */
  readonly answeredWith?: AddressSpaceHint
}

/**
 * One candidate's probe, before anybody decides what to call it.
 *
 * `hint` is the ROW's version of the variant and is not `measured.answeredWith`:
 * the plane needs to know how it got through every time, and a reader only
 * needs telling when the answer is news. See toldHint.
 */
type Probe =
  | {
      readonly kind: 'answered'
      readonly origin: string
      readonly ms: number
      readonly measured: MeasuredReply
      readonly hint?: AddressSpaceHint
    }
  | { readonly kind: 'unreadable'; readonly origin: string; readonly ms: number }
  | {
      readonly kind: 'failed'
      readonly origin: string
      readonly ms: number
      readonly failure: HelloFailed
      readonly hint?: AddressSpaceHint
    }

/**
 * THE VARIANT, ONLY WHERE IT IS NEWS TO A READER.
 *
 * A candidate no browser ever annotates — a CGNAT tailnet address is public by
 * every reckoning — answers 'none' every single time, and a row saying
 * "answered without the local-network hint" there would invent a proxy that is
 * not in the story. So the word is recorded only for a LOCAL address, where
 * 'none' means the probe genuinely fell back, and only for a failure that was
 * refused BOTH ways, which is the signature of the proxy case (Chrome 152,
 * 2026-09-08).
 */
const toldHint = (origin: string, result: HelloResult): AddressSpaceHint | undefined => {
  if (!isLocalOrigin(origin)) return undefined
  if (result.ok) return result.hint
  return (result.attempts?.length ?? 0) > 1 ? 'none' : undefined
}

/**
 * The candidates that said the right words, fastest first, order preserved.
 *
 * SORT IS STABLE. Two addresses that measure the same keep the card's order,
 * because the desktop listed them in the order it prefers and an arbitrary
 * re-shuffle on a tie is a plane that moves for no reason.
 */
const answeredFirst = (probes: readonly Probe[]): readonly MeasuredReply[] =>
  probes
    .filter((probe): probe is Extract<Probe, { kind: 'answered' }> => probe.kind === 'answered')
    .map((probe, index) => ({ probe, index }))
    .sort((a, b) => a.probe.ms - b.probe.ms || a.index - b.index)
    .map(({ probe }) => probe.measured)

/**
 * PROBE ONE TIER AT ONCE, AND KEEP WHAT EACH ONE SAID.
 *
 * In parallel because the candidates within a tier are alternatives, not a
 * queue: probing them in series would make the measurement of the second
 * include the deadline of the first, and with an 800 ms budget each a Mac with
 * two LAN addresses would take 1.6 s to answer a question worth 6 ms. RFC 8305
 * would stagger these by a Connection Attempt Delay once the list grows past
 * three; at two or three the saving is smaller than the added latency, so they
 * go together (see the research verdict on the 800 ms deadline).
 *
 * THE CHEAP CHECKS STAY HERE, before any of this costs the registry a request
 * — and the cheapest of them is the one that matters most: an answer whose
 * SIGNED ORIGIN is not the address we dialled is our own challenge relayed to
 * the real Mac by whatever answered here. The signature would verify. The
 * endpoint would be somebody else's. See src/shared/hello-proof.ts.
 *
 * NOTHING IS THROWN AWAY ANY MORE. This used to answer only the candidates
 * that proved readable, and the row list was rebuilt by asking which ones were
 * missing — which is exactly how four different failures became one word. Each
 * candidate now comes back with what happened to it, in the tier's order.
 */
const probeTier = async (
  tier: readonly PlaneCandidate[],
  deviceId: string,
  deps: PlaneSwitchDeps,
  now: () => number
): Promise<readonly Probe[]> =>
  Promise.all(
    tier.map(async (candidate): Promise<Probe> => {
      const nonce = deps.nonce()
      const started = now()
      const result = await deps
        .hello(candidate.origin, nonce)
        .catch((error): HelloResult => classifyHelloFailure({ error, ms: 0, timedOut: false }))
      const ms = Math.max(0, now() - started)
      const origin = candidate.origin
      const told = toldHint(origin, result)
      const hint = told ? { hint: told } : {}
      if (!result.ok) return { kind: 'failed', origin, ms: result.ms, failure: result, ...hint }
      const read = readHelloReply(result.reply, { origin, deviceId, nonce })
      if (!read.ok) return { kind: 'unreadable', origin, ms }
      return {
        kind: 'answered',
        origin,
        ms,
        ...hint,
        measured: {
          origin,
          nonce,
          sig: read.proof.sig,
          signedOrigin: read.proof.origin,
          issuedAtMs: read.proof.issuedAtMs,
          ms,
          ...(result.hint ? { answeredWith: result.hint } : {})
        }
      }
    })
  )
