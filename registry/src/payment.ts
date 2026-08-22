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
 *   unverifiable
 *             WE could not check. The facilitator is unreachable or would not
 *             answer, so nothing is known about the buyer's money — least of all
 *             that it is bad. Reporting our outage as a fact about their payment
 *             is a lie that costs someone real money and teaches them to
 *             distrust a receipt they are holding. Ruled distinct by Commander,
 *             2026-08-22, and the whole reason it exists is that the next action
 *             differs: invalid means stop and check your wallet; unverifiable
 *             means try again, yours may be fine.
 *
 * NEVER 403. 402 is caller-recoverable and 403 is not, which is the whole reason
 * the codes bind cleanly (spec §2), and D4/R9's rule that a client never loops
 * on a 403 depends on it. Every failure here means "the payment did not happen",
 * which is exactly the state 402 describes. Answering 403 would tell the client
 * to stop trying and send the buyer to an author who cannot help.
 */

export type PaymentFailure = 'invalid' | 'expired' | 'replayed' | 'unverifiable'

/**
 * The vocabulary, listed so it can be asserted DISJOINT from the 403 reasons.
 * Both ride in a `reason` field on the same gate; the status code already
 * disambiguates them, and disjointness means even a client that ignored the
 * status could not mistake one for the other.
 */
export const PAYMENT_FAILURES = ['invalid', 'expired', 'replayed', 'unverifiable'] as const

/**
 * IS THE BUYER'S CORRECT NEXT MOVE TO TRY AGAIN WITH THE SAME PROOF?
 *
 * Carried on the wire as a boolean beside the reason, and that redundancy is
 * the point: a client that has never heard of a reason we add later still
 * knows whether to retry. The M1 forward-compat rule says an unknown reason
 * renders as a sentence — but retryability cannot be guessed from a token, and
 * guessing it wrong is what tells somebody their payment failed when it did not.
 */
export function isRetryable(reason: PaymentFailure): boolean {
  return reason === 'unverifiable'
}

/**
 * SHOULD THE ANSWER CARRY A FRESH QUOTE?
 *
 * Only when paying again is genuinely the next step. `unverifiable` and
 * `replayed` must NOT mint one: the first means the money may already have
 * moved and we simply cannot see it, the second means it certainly has. In both
 * cases a new nonce is an invitation to pay twice for one preset, which is a
 * worse outcome than the failure it was trying to be helpful about.
 */
export function needsFreshQuote(reason: PaymentFailure): boolean {
  return reason === 'invalid' || reason === 'expired'
}

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
  /**
   * THE DURABLE RECORD OF WHAT HAS ALREADY BEEN BOUGHT (A4).
   *
   * The receipt store satisfies this. Replay defence lives here rather than in
   * the quote store for two reasons: it survives a restart, which is what
   * Magpie flagged when it lived in a Map; and a receipt IS the purchase, so
   * asking anything else would be asking a second record of the same fact and
   * inviting the two to disagree.
   *
   * It also fails in the safe direction. If a receipt was never written, the
   * nonce is not spent and a retry can settle again — the proof names the same
   * transaction, so re-verifying it moves no money a second time. The opposite
   * arrangement, a spend marked without a receipt, would tell a buyer whose
   * money had moved that they were replaying, while owning nothing.
   */
  purchased: { hasNonce(nonce: string): boolean }
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

  // ALREADY BOUGHT? Asked first, and asked of the durable record. A restart
  // must not turn a replay into an `invalid`, which is what happened while the
  // spent set lived only in memory.
  if (deps.purchased.hasNonce(proof.nonce)) return { ok: false, reason: 'replayed' }

  const state = deps.nonces.stateOf(proof.nonce, at)
  // A quote we never issued is not a replay — nothing was bought with it — so
  // it is invalid. Keeping these apart is the distinction C16 checks.
  if (state === 'unknown') return { ok: false, reason: 'invalid' }
  if (state === 'expired') return { ok: false, reason: 'expired' }

  // The quote was issued for one buyer and one preset. Without this it is a
  // bearer token: anyone could pay somebody else's terms and claim the
  // entitlement it bought.
  if (deps.nonces.bindingOf(proof.nonce) !== purchaseBinding(input.identityId, input.presetId)) {
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

  // Nothing is marked here. The caller records the RECEIPT, and that recording
  // is what makes the quote spent — one act, one record, no second bookkeeping
  // to fall out of step with it.
  return { ok: true }
}
