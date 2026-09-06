import { addressFromTrustedName } from '../../../shared/reach-names'
import type { TrustedNetwork } from '../../../shared/trusted-origin'
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

/** One candidate's story, as the "why this path" panel tells it. */
export interface PlaneAttempt {
  /** The ADDRESS the trusted label spells — never the label, which is a device id. */
  readonly name: string
  readonly outcome: 'answered' | 'no-answer' | 'refused' | 'unverified'
  readonly ms: number | null
  readonly plane: 'LAN' | 'TAILNET'
  readonly chosen: boolean
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
  const answered = await measureTier(tier, deviceId, deps, deps.now ?? defaultNow)
  const plane = kind === 'lan' ? 'LAN' : 'TAILNET'
  const rows = tier.map((candidate): PlaneAttempt => {
    const reply = answered.find((one) => one.origin === candidate.origin)
    return {
      name: attemptName(candidate.origin),
      outcome: reply ? 'answered' : 'no-answer',
      ms: reply ? Math.round(reply.ms) : null,
      plane,
      chosen: false
    }
  })
  return verifyInOrder(answered, rows, deviceId, deps)
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
    .verify({ deviceId, nonce: attempt.nonce, sig: attempt.sig })
    .catch(() => false)
  const name = attemptName(attempt.origin)
  const attempts = rows.map((row) =>
    row.name === name
      ? { ...row, outcome: proved ? ('answered' as const) : ('unverified' as const), chosen: proved }
      : row
  )
  return proved
    ? { won: attempt.origin, attempts }
    : verifyInOrder(rest, attempts, deviceId, deps)
}

/** One candidate that said the right words, and how long it took to say them. */
interface MeasuredReply {
  readonly origin: string
  readonly nonce: string
  readonly sig: string
  readonly ms: number
}

const defaultNow = (): number => {
  try {
    const clock = (globalThis as { performance?: { now?: () => number } }).performance
    if (typeof clock?.now === 'function') return clock.now()
  } catch {
    // A web view without a performance object. Date is a worse clock and a
    // perfectly good one for telling 6 ms from 90.
  }
  return Date.now()
}

/**
 * PROBE ONE TIER AT ONCE, AND SORT WHAT ANSWERS BY HOW FAST IT ANSWERED.
 *
 * In parallel because the candidates within a tier are alternatives, not a
 * queue: probing them in series would make the measurement of the second
 * include the deadline of the first, and with an 800 ms budget each a Mac with
 * two LAN addresses would take 1.6 s to answer a question worth 6 ms. RFC 8305
 * would stagger these by a Connection Attempt Delay once the list grows past
 * three; at two or three the saving is smaller than the added latency, so they
 * go together (see the research verdict on the 800 ms deadline).
 *
 * The two cheap checks stay here, before any of this costs the registry a
 * request: the device id says it is the right Mac, and the echoed nonce says
 * the answer was made just now rather than replayed.
 *
 * SORT IS STABLE. Two addresses that measure the same keep the card's order,
 * because the desktop listed them in the order it prefers and an arbitrary
 * re-shuffle on a tie is a plane that moves for no reason.
 */
const measureTier = async (
  tier: readonly PlaneCandidate[],
  deviceId: string,
  deps: PlaneSwitchDeps,
  now: () => number
): Promise<readonly MeasuredReply[]> => {
  const measured = await Promise.all(
    tier.map(async (candidate): Promise<MeasuredReply | null> => {
      const nonce = deps.nonce()
      const started = now()
      const reply = await deps.hello(candidate.origin, nonce).catch(() => null)
      const ms = Math.max(0, now() - started)
      if (!reply || reply.deviceId !== deviceId || reply.nonce !== nonce) return null
      if (typeof reply.sig !== 'string' || reply.sig.length === 0) return null
      return { origin: candidate.origin, nonce, sig: reply.sig, ms }
    })
  )
  return measured
    .filter((reply): reply is MeasuredReply => reply !== null)
    .map((reply, index) => ({ reply, index }))
    .sort((a, b) => a.reply.ms - b.reply.ms || a.index - b.index)
    .map(({ reply }) => reply)
}
