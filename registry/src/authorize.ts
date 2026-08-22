import type { IncomingMessage } from 'node:http'
import type { RegistryStore } from './store'
import type { IdentityService } from './identity'
import type { Verdict } from './server'
import { quoteFor, type QuoteDeps } from './terms'
import type { PayoutStore } from './payouts'

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
    if (pricing !== undefined && request.method !== 'HEAD') {
      const manifest = store.getManifest(presetId)
      const terms = quoteFor(pricing, {
        presetId,
        identityId: claims.sub,
        pricing: manifest?.pricing,
        payTo: pricing.payouts.addressOf(store.identityOf(presetId) ?? '')
      })
      // A free preset quotes null and falls straight through — the common case
      // costs one map lookup and answers exactly as it did in M1.
      if (terms !== null) return { code: 402, terms }
      // Priced but unquotable means an author with no payout address, which
      // PUBLISH refuses to create (`payout_missing`). Unreachable by
      // construction, and if it ever happens the honest answer is that this
      // registry will not serve this preset — never 200, which would give away
      // something priced, and never a new status code invented at the seam.
      if (manifest?.pricing !== undefined) return { code: 404 }
    }

    return { code: 200 }
  }
}
