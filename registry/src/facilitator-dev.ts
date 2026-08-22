import type { Facilitator, SettlementRequest, SettlementResult } from './facilitator'

/**
 * A FACILITATOR FOR THE DEV REGISTRY. NOT A PAYMENT SYSTEM.
 *
 * It reaches no chain and verifies no transfer. It exists so the dev registry
 * can demonstrate the whole 402 handshake end to end — and, more importantly,
 * so a gate matrix can CONSTRUCT each failure against the real binary rather
 * than only against an in-process double. A case that can only be produced by
 * mocking is a case nobody has actually seen the server answer.
 *
 * It lives in its own file, under its own name, and is wired only by
 * registry/src/main.ts — which hardcodes `dev: true` and is the development
 * entry point. Nothing here should ever be reachable from a deployment that
 * takes real money; if this ever needs a flag to keep it out of production,
 * that is the signal it has been wired somewhere it does not belong.
 */

/**
 * A tx reference beginning with this settles as REFUSED. That is the whole
 * mechanism, and it is deliberate: without it, a dev facilitator that accepts
 * everything makes facilitator-refusal unconstructible over HTTP, and Magpie's
 * C16 would be asserting distinctness it could only reach in unit tests.
 */
export const DEV_REFUSE_PREFIX = 'refuse-'

export function devFacilitator(): Facilitator {
  return {
    settle(request: SettlementRequest): SettlementResult {
      if (request.tx.startsWith(DEV_REFUSE_PREFIX)) return { ok: false, reason: 'invalid' }
      // Everything the terms named must be present and non-empty. It proves
      // nothing about a transfer; it does prove the gate handed the facilitator
      // a complete, bound request rather than a partly-filled one — which is a
      // real class of bug and the only thing a chainless stand-in CAN check.
      const complete =
        request.tx.length > 0 &&
        request.payTo.length > 0 &&
        request.amount.length > 0 &&
        request.chain.length > 0 &&
        request.identityId.length > 0 &&
        request.presetId.length > 0 &&
        request.nonce.length > 0
      return complete ? { ok: true } : { ok: false, reason: 'invalid' }
    }
  }
}
