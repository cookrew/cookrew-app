import type { IncomingMessage } from 'node:http'
import type { RegistryStore } from './store'
import type { IdentityService } from './identity'
import type { Verdict } from './server'
import type { Terms } from './terms'
import { priceFor, quoteFrom, type QuoteDeps } from './terms'
import type { PayoutStore } from './payouts'
import type { Facilitator } from './facilitator'
import { needsFreshQuote, isRetryable, parsePaymentProof, verifyPayment } from './payment'

/**
 * THE DECISION FUNCTION (P2-A2) — the only place an answer is chosen.
 *
 * The order is fixed and each step answers before the next runs:
 *
 *   exists? → public? → identity? → entitlement? → [M2: priced?] → serve
 *
 * M2 inserts 402 between entitlement and serve, reads `X-Payment` when present,
 * and lets the client retry the same idempotent GET. Nothing above it moves.
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
    const visibility = store.visibilityOf(presetId)
    if (visibility === null) return { code: 404 }
    // A public preset never sees the gate. Discovery and free download are not
    // things identity should cost (A2).
    if (visibility === 'public') return { code: 200 }

    const token = bearer(request)
    if (token === null) {
      // No credential offered: ask for one. The challenge rides in the header
      // the spec names, so a client reads one place for "what next".
      return { code: 401, challenge: identity.challenge() }
    }

    const claims = identity.verifyToken(token)
    if (claims === null) {
      // Malformed, mis-signed and EXPIRED are one answer on purpose. They are
      // all "your credential is not currently good", the remedy is identical,
      // and distinguishing them would tell an attacker which half of a forgery
      // was wrong.
      return { code: 401, challenge: identity.challenge() }
    }

    // D4 / R9: authenticated but the token does not cover this. 403, NEVER 401.
    // A 401 tells the client its identity is the problem, so it re-authenticates,
    // presents the same token and loops. 401 means prove who you are; 403 means
    // you did, and it is still no — a client may retry the first and must never
    // retry the second.
    // R26: `scope`, not a stand-in. The reason names what is actually wrong,
    // and it is the one 403 a client can resolve on its own — so naming it
    // precisely is what lets the client re-ceremony instead of surfacing.
    if (claims.scope !== 'download') return { code: 403, reason: 'scope' }

    // ENTITLEMENT. M1 had none: a verified identity was entitled to every
    // identified preset. A3 puts the real check HERE — a receipt read — and
    // when it lands it answers 200 ABOVE the price step, which is what stops a
    // buyer signing again on every fetch.

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
          { nonces: pricing.nonces, facilitator: pricing.facilitator, now: pricing.now },
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
