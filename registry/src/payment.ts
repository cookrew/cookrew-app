import type { Facilitator } from './facilitator'
import { purchaseBinding, type PaymentNonces, type PriceFacts } from './terms'

/**
 * VERIFYING AN X-PAYMENT (M2-A2).
 *
 * Three failures, and they must stay THREE. Magpie's C16 asserts they are
 * distinct and constructible and blocks if they collapse, which is the right
 * gate to hold this to: each names a different thing that happened to a buyer,
 * and each has a different honest next move.
 *
 *   invalid   the proof does not describe a payment for this preset — malformed,
 *             for a nonce we never issued, or refused by the facilitator. The
 *             buyer's money did not move for this.
 *   expired   the quote stood for a while and the buyer took longer. Nothing is
 *             wrong with them or with us; the price simply has to be re-quoted.
 *   replayed  this proof already bought something. Not an accusation by itself —
 *             a retry looks identical from here — but it must not buy twice.
 *
 * NEVER 403. 402 is caller-recoverable and 403 is not, which is the whole reason
 * the codes bind cleanly (spec §2), and D4/R9's rule that a client never loops
 * on a 403 depends on it. Every failure here means "the payment did not happen",
 * which is exactly the state 402 describes. Answering 403 would tell the client
 * to stop trying and send the buyer to an author who cannot help.
 */

export type PaymentFailure = 'invalid' | 'expired' | 'replayed'

/**
 * The vocabulary, listed so it can be asserted DISJOINT from the 403 reasons.
 * Both ride in a `reason` field on the same gate; the status code already
 * disambiguates them, and disjointness means even a client that ignored the
 * status could not mistake one for the other.
 */
export const PAYMENT_FAILURES = ['invalid', 'expired', 'replayed'] as const

export function isPaymentFailure(value: string): value is PaymentFailure {
  return (PAYMENT_FAILURES as readonly string[]).includes(value)
}

/**
 * What `X-Payment` carries: the nonce the terms named, and the transfer that
 * answers it. base64url JSON, x402-style — a header a proxy will not mangle.
 */
export interface PaymentProof {
  nonce: string
  tx: string
}

/**
 * Parse the header. Null for anything that is not a proof — this runs on a
 * value a caller chose, so malformed input is expected rather than exceptional.
 */
export function parsePaymentProof(header: string | undefined): PaymentProof | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return null
  try {
    const raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const { nonce, tx } = raw as Record<string, unknown>
    if (typeof nonce !== 'string' || nonce.length === 0) return null
    if (typeof tx !== 'string' || tx.length === 0) return null
    return { nonce, tx }
  } catch {
    return null
  }
}

/** Build the header a client sends. Exported so tests speak the real wire. */
export function encodePaymentProof(proof: PaymentProof): string {
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url')
}

export interface VerifyPaymentDeps {
  nonces: PaymentNonces
  facilitator: Facilitator
  now: () => number
}

export interface VerifyPaymentInput {
  header: string | undefined
  identityId: string
  presetId: string
  /**
   * The price this payment is answering. FACTS, not a quote: verification does
   * not need a nonce of its own, and asking for one would mint a second offer
   * every time somebody presented a proof.
   */
  price: PriceFacts
}

export type PaymentOutcome =
  | { ok: true }
  | { ok: false; reason: PaymentFailure }

/**
 * THE ORDER IS THE DESIGN, so it is written down rather than left to reading.
 *
 * State is checked BEFORE settlement and the nonce is spent AFTER it. That way
 * a refused settlement leaves the nonce alive: the payment did not happen, so
 * there is nothing to protect against, and burning the quote would force a buyer
 * to re-price for a failure that was not theirs. And `replayed` then means what
 * it says — this proof already BOUGHT something — rather than merely "we have
 * seen this string".
 */
export function verifyPayment(
  deps: VerifyPaymentDeps,
  input: VerifyPaymentInput
): PaymentOutcome {
  const proof = parsePaymentProof(input.header)
  if (proof === null) return { ok: false, reason: 'invalid' }

  const at = deps.now()
  const state = deps.nonces.stateOf(proof.nonce, at)
  // A nonce we never issued is not a replay — nothing was bought with it — so
  // it is invalid. Keeping these apart is the distinction C16 checks.
  if (state === 'unknown') return { ok: false, reason: 'invalid' }
  if (state === 'expired') return { ok: false, reason: 'expired' }
  if (state === 'spent') return { ok: false, reason: 'replayed' }

  // The nonce was issued for one buyer and one preset. Without this a quote is
  // a bearer token: anyone could pay somebody else's terms and claim the
  // entitlement it bought.
  if (deps.nonces.bindingOf(proof.nonce, at) !== purchaseBinding(input.identityId, input.presetId)) {
    return { ok: false, reason: 'invalid' }
  }

  const settled = deps.facilitator.settle({
    tx: proof.tx,
    payTo: input.price.payTo,
    amount: input.price.amount,
    asset: input.price.asset,
    chain: input.price.chain,
    identityId: input.identityId,
    presetId: input.presetId,
    nonce: proof.nonce
  })
  if (!settled.ok) return { ok: false, reason: settled.reason }

  // Spent only now, and only once. A4 makes this survive a restart; until then
  // a reboot forgets, which is why A4 exists rather than being folded in here.
  deps.nonces.spend(proof.nonce, at)
  return { ok: true }
}
