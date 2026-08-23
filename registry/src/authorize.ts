import type { IncomingMessage } from 'node:http'
import { decideGate } from '../../src/shared/gate'
import type { RegistryStore } from './store'
import type { IdentityService, TokenClaims } from './identity'
import type { Verdict } from './server'
import type { Terms } from './terms'
import { priceFor, quoteFrom, type QuoteDeps } from './terms'
import type { PayoutStore } from './payouts'
import type { Facilitator } from './facilitator'
import { needsFreshQuote, isRetryable, parsePaymentProof, verifyPayment } from './payment'
import { balanceOf, entitledTo, type ReceiptStore } from './receipts'

/**
 * THE DOWNLOAD BINDING (P2-A2) — the registry's half of the one gate.
 *
 * The order is fixed and each step answers before the next runs:
 *
 *   exists? → public? → identity? → covers? → entitled? → [M2: priced?] → serve
 *
 * EVERYTHING ABOVE `priced?` IS THE SHARED DECISION. It moved to
 * src/shared/gate.ts in S1 of the ④ lane, because the live-call gate (§9) runs
 * in the owner's app against a different issuer, and "one protocol, two
 * resources" is only true if there is one implementation. What is left here is
 * the binding: which store answers "does it exist", which service verifies a
 * credential, and what this resource requires of a token.
 *
 * M2'S 402 SITS EXACTLY WHERE THE SHARED GATE SAYS IT DOES — between
 * entitlement and serve. decideGate hands back the claims on a 200, which is
 * precisely "everything above price passed, and here is who is asking"; the
 * price step then runs here, in the binding that owns money. The shared gate
 * needed no payment hook to make that true, and it should not grow one: R5
 * says the live-call binding never takes this branch, so a hook there would be
 * a branch one of the two bindings must always decline.
 *
 * The price step reads `X-Payment` when present and lets the client retry the
 * same idempotent GET. Nothing above it moves.
 */

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/** What the price step needs. Absent → this deployment sells nothing (M1). */
export interface PricingDeps extends QuoteDeps {
  payouts: PayoutStore
  /** M2-A3: what this buyer already owns. Read ABOVE the price step. */
  receipts: ReceiptStore
  /**
   * M2-A2. Required alongside pricing, so "priced implies payable" holds by
   * construction: a deployment that could quote a price but never verify a
   * payment would sell things nobody could buy.
   */
  facilitator: Facilitator
}

export function makeAuthorize(
  store: RegistryStore,
  identity: IdentityService,
  pricing?: PricingDeps
): (presetId: string, request: IncomingMessage) => Verdict {
  return (presetId, request) => {
    // exists? → public? → identity? → covers? → entitled?, once, shared.
    const verdict = decideGate<TokenClaims>({
      visibility: store.visibilityOf(presetId),
      credential: bearer(request),
      issuer: identity,
      // D4 / R9: authenticated but the token does not cover this. 403, NEVER
      // 401 — a 401 tells the client its identity is the problem, so it
      // re-authenticates, presents the same token and loops.
      //
      // R26: `scope`, not a stand-in. The reason names what is actually wrong,
      // and it is the one 403 a client can resolve on its own — so naming it
      // precisely is what lets the client re-ceremony instead of surfacing.
      covers: (claims) => (claims.scope === 'download' ? null : 'scope'),
      // M1 has no entitlement service: a verified identity is entitled to every
      // identified preset. M2-A3's real check is OWNERSHIP, and it belongs in
      // the price step below rather than here — see the note there for why its
      // position above the price is the feature.
      entitled: () => null
    })
    // Every refusal is the shared one. Only a 200 continues to the price step.
    if (verdict.code !== 200) return verdict
    // A public preset never sees the gate, and never sees a price: discovery
    // and free download are not things identity should cost (A2), and asking
    // an anonymous caller for money would require knowing who they are.
    if (verdict.claims === null) return { code: 200 }
    const claims = verdict.claims

    // ENTITLEMENT (M2-A3). M1 had none: a verified identity was entitled to
    // every identified preset. This is the real check, and its position is the
    // feature — ABOVE the price step, so a buyer who already owns something
    // gets an ordinary 200 and never reaches payment at all.
    //
    // Without it, every download re-runs the 402 handshake and opening
    // something you bought last week costs a wallet gesture. "A buyer must not
    // sign per fetch" is not a nicety; it is what makes a purchase mean
    // anything after the moment it happens.
    const owned = pricing === undefined ? null : entitlementOf(store, pricing, presetId, claims.sub)
    if (owned === true) return { code: 200 }

    // PRICE (M2-A1). The one new step, and it is the last one before serving:
    // by here we know the preset exists, who is asking, and that their
    // credential covers a download. Anything earlier would be asking for money
    // before knowing whether we would have served the bytes at all.
    // A HEAD IS NOT A PURCHASE, and this line is load-bearing rather than an
    // optimisation. R3 makes the update check a HEAD and R24 says a background
    // check may never raise a sheet — so if the price step ran here, opening
    // the dock would answer 402 and the client would have to swallow a payment
    // demand nobody asked for. A HEAD asks "what is the latest version", which
    // is the question the update badge needs and is not the paid content: the
    // manifest and its blobs are. Answered here rather than in the route,
    // because the route does not get to make payment decisions.
    // ONLY A GET IS A PURCHASE — stated positively, and that matters. Written
    // as `!== 'HEAD'` this passed its first gate and still answered 402 to
    // OPTIONS, POST and to a request whose method was unset: an exclusion list
    // makes every method somebody adds later a purchase by default. The
    // allow-list makes the next one safe without anybody remembering this.
    if (pricing !== undefined && request.method === 'GET') {
      const manifest = store.getManifest(presetId)
      // PRICE FACTS FIRST, and a nonce only when one is actually being offered.
      // Quoting unconditionally minted an offer nobody would use on every
      // request that already carried a proof — and the sweep that ran with it
      // deleted the record of the very nonce being presented, which turned an
      // `expired` into an `invalid`. C16 caught that.
      const price = priceFor(pricing, {
        pricing: manifest?.pricing,
        payTo: pricing.payouts.addressOf(store.identityOf(presetId) ?? '')
      })
      // A free preset prices null and falls straight through — the common case
      // costs one map lookup and answers exactly as it did in M1.
      if (price !== null) {
        const offer = (): Terms =>
          quoteFrom(pricing, { presetId, identityId: claims.sub, price })
        const header = request.headers['x-payment']
        // No proof: the opening move, not a refusal. It carries terms and NO
        // reason — "you have not paid yet" is not a thing that went wrong, and
        // a reason here would make the first ask read as a failure.
        if (header === undefined) return { code: 402, terms: offer() }

        const paid = verifyPayment(
          {
            nonces: pricing.nonces,
            facilitator: pricing.facilitator,
            purchased: pricing.receipts,
            now: pricing.now
          },
          {
            header: Array.isArray(header) ? header[0] : header,
            identityId: claims.sub,
            presetId,
            // Verified against OUR price, our payee and our chain — never
            // against whatever the client believes it owes.
            price
          }
        )
        // 402 again, with a reason, and NEVER 403 — the payment did not happen
        // (or we cannot tell), which is precisely what 402 means. A 403 would
        // tell the client to stop retrying something genuinely retryable.
        //
        // A FRESH QUOTE ONLY WHEN PAYING AGAIN IS THE NEXT STEP. On
        // `unverifiable` the money may already have moved and we simply cannot
        // see it; on `replayed` it certainly has. Minting a new nonce for
        // either would be an invitation to pay twice for one preset — so those
        // two echo the offer the buyer already holds instead.
        if (paid.ok) {
          // The purchase is a fact now. Recorded BEFORE serving, so a crash
          // between the two costs the buyer a retry that finds them entitled —
          // never a payment with nothing to show for it.
          const held = parsePaymentProof(Array.isArray(header) ? header[0] : header)
          const lineage = store.lineageFor(presetId)
          if (held !== null && lineage !== null && !pricing.receipts.hasNonce(held.nonce)) {
            pricing.receipts.record({
              identityId: claims.sub,
              lineage,
              version: manifest?.version ?? 0,
              presetId,
              nonce: held.nonce,
              tx: held.tx,
              amount: price.amount,
              asset: price.asset,
              at: pricing.now()
            })
          }
        }
        if (!paid.ok) {
          const held = parsePaymentProof(Array.isArray(header) ? header[0] : header)
          const heldExpiry = held === null ? null : pricing.nonces.expiryOf(held.nonce)
          const terms: Terms =
            needsFreshQuote(paid.reason) || held === null || heldExpiry === null
              ? offer()
              : { ...price, nonce: held.nonce, expiry: heldExpiry }
          return { code: 402, terms, reason: paid.reason, retryable: isRetryable(paid.reason) }
        }
        // Settled. Fall through to serve: the client retried the same
        // idempotent GET and this is simply the answer continuing.
      } else if (manifest?.pricing !== undefined) {
        // Priced but unquotable — an author with no payout address, which
        // PUBLISH refuses to create (`payout_missing`). Unreachable by
        // construction, and if it ever happens the honest answer is that this
        // registry will not serve this preset: never 200, which would give away
        // something priced, and never a new status code invented at the seam.
        //
        // It sits in the ELSE, and A2's first green test is what put it there.
        // Left below the payment branch it also caught the PAID case — a preset
        // that is still priced after being bought — so a settled payment
        // answered 404. The guard is about having no terms, not about the
        // preset costing money.
        return { code: 404 }
      }
    }

    return { code: 200 }
  }
}

/**
 * Does this buyer already own this preset?
 *
 * Null when the question does not apply — a free preset, or one whose lineage
 * we cannot resolve. True only on a receipt that covers this version.
 */
function entitlementOf(
  store: RegistryStore,
  pricing: PricingDeps,
  presetId: string,
  identityId: string
): boolean | null {
  const manifest = store.getManifest(presetId)
  if (manifest?.pricing === undefined) return null
  const lineage = store.lineageFor(presetId)
  if (lineage === null) return null
  const held = pricing.receipts.forLineage(identityId, lineage)
  return entitledTo(held, { version: manifest.version, pricing: manifest.pricing })
}

/**
 * The prepaid balance for a lineage, in both units (deck §7).
 *
 * Exported for the surfaces that show it — the chip and the top-up sheet — and
 * deliberately NOT consulted by the gate. R5: whether a call may run is the
 * meter's question and it is answered on the call path as 200 or 403. A dry
 * meter must never become a payment demand in the middle of a conversation.
 */
export function balanceFor(
  store: RegistryStore,
  pricing: PricingDeps,
  presetId: string,
  identityId: string,
  spentCents = 0
): ReturnType<typeof balanceOf> | null {
  const manifest = store.getManifest(presetId)
  const lineage = store.lineageFor(presetId)
  if (manifest?.pricing === undefined || lineage === null) return null
  return balanceOf(pricing.receipts.forLineage(identityId, lineage), {
    pricing: manifest.pricing,
    spentCents
  })
}
