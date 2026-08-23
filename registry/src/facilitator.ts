/**
 * THE FACILITATOR SEAM (M2-A2).
 *
 * The registry does exactly two things with money and neither involves
 * touching it: it asks for terms, and it asks whether a proof settled. Chain
 * RPC, transfer construction and confirmation depth live on the other side of
 * this interface — none of it belongs in a process whose other job is serving
 * signed bytes.
 *
 * INJECTED, so tests never reach a network. That is not only hygiene: a test
 * that needs a chain is a test nobody runs, and the cases that matter here
 * (expired, replayed, refused) are precisely the ones a real chain makes hard
 * to produce on demand.
 *
 * WHAT A COMPROMISED FACILITATOR COSTS, stated as precisely as the log's limit:
 * it can mint entitlements nobody paid for. That is a loss to AUTHORS and it is
 * real. What it cannot do is alter a preset — the client verifies the author's
 * signature and hashes itself (A5) — or forge attribution, which needs a
 * countersigned ceremony it has no part in. The money component's blast radius
 * is bounded to money.
 */

import type { PaymentFailure } from './payment'

/**
 * What the registry asks about. Every field the terms named is here, because
 * the question is not "did a transfer happen" but "did THIS transfer happen":
 * a proof that moved the right amount to the wrong address, or the right
 * address on the wrong chain, is not payment for this preset.
 */
export interface SettlementRequest {
  /** The on-chain reference the buyer's proof carries. */
  tx: string
  /** The AUTHOR's address. Funds moved buyer → author; we were never in it. */
  payTo: string
  amount: string
  asset: 'USDC'
  /**
   * Named separately from the amount, and checked. A transfer to the correct
   * address on the WRONG CHAIN is money gone with a successful receipt — every
   * party's local view says success — which is the worst failure shape in this
   * feature and the reason chain is in the terms at all.
   */
  chain: string
  /** Bound, so a proof cannot be lifted between buyers or between presets. */
  identityId: string
  presetId: string
  nonce: string
}

export type SettlementResult =
  | { ok: true }
  /**
   * The facilitator names one of the SAME three reasons the gate answers with.
   * Sharing the vocabulary rather than inventing a second one is deliberate: a
   * translation layer between two failure vocabularies is where a distinction
   * quietly collapses, and Magpie's C16 blocks on exactly that collapse.
   */
  | { ok: false; reason: PaymentFailure }

export interface Facilitator {
  settle(request: SettlementRequest): SettlementResult
}
