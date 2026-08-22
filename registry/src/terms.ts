import { randomBytes } from 'node:crypto'
import { countersignPayload } from './countersign'
import type { PresetPricing } from '../../src/shared/preset-manifest'

/**
 * THE 402 TERMS (M2-A1) — what a priced preset asks for, on the wire.
 *
 * x402-style, per spec §2 and §4. Every field is a machine value: R14 keeps
 * sentences out of here, and Velvet's `mkt.pay.*` strings interpolate from
 * exactly these six.
 */
/** What a preset costs and who receives it. No nonce, no clock, no side effect. */
export interface PriceFacts {
  amount: string
  asset: 'USDC'
  chain: string
  payTo: string
}

export interface Terms {
  /**
   * A DECIMAL STRING, never a number. Money in a float is a rounding bug with a
   * currency symbol, and this value is copied straight into a transfer.
   */
  amount: string
  asset: 'USDC'
  /**
   * NOT IN COMMANDER'S FIELD LIST, and added deliberately — flagged in the A1
   * report rather than slipped in. USDC exists on many chains, and a transfer
   * to the right address on the wrong chain is money gone with a successful
   * receipt. Spec §2 and §4 both carry it, and deck §7 requires it named
   * SEPARATELY from the amount rather than folded in.
   */
  chain: string
  /** The AUTHOR's address. We are not in the path (Commander, 2026-08-22). */
  payTo: string
  /** Single-use, bound to (identity, preset). A4 makes it survive a restart. */
  nonce: string
  /** Epoch ms. Absolute, so the client owns the countdown (mkt.pay.expires). */
  expiry: number
}

export interface TermsConfig {
  /** Which chain the payTo address is expected to be paid on. */
  chain: string
  /**
   * How long a quote stands. DEV-SETTABLE, and that is a requirement rather
   * than a convenience: Magpie's gate for "expired payment" cannot sleep out a
   * real TTL, so without a settable clock the case is unjudgeable and the gate
   * BLOCKS. Same shape as identity.ts's challengeTtlMs for the same reason.
   */
  ttlMs: number
}

export const DEFAULT_TERMS_CONFIG: TermsConfig = {
  chain: 'base',
  // Long enough to open a wallet and confirm, short enough that a quote is not
  // a standing offer against a price the author may have changed.
  ttlMs: 15 * 60 * 1000
}

/**
 * What a payment nonce is bound to.
 *
 * Reuses the domain-separated countersign payload with its own operation, so a
 * purchase nonce, a publish countersignature and a key-rotation countersignature
 * are three different digests. That reuse is the point: the M1 review found that
 * two operations sharing one unbound payload IS a replay, and a second scheme
 * invented here would be the same bug wearing different clothes.
 *
 * Bound to the BUYER as well as the preset, because a nonce that named only the
 * preset would be a bearer token — anyone could pay one buyer's quote and claim
 * the entitlement.
 */
export function purchaseBinding(identityId: string, presetId: string): string {
  return countersignPayload('purchase', identityId, presetId).toString('hex')
}

/**
 * Outstanding quotes.
 *
 * A1 keeps these in memory and A4 replaces the backing with a durable one —
 * Magpie's second point, ruled: a registry restart must not reset replay
 * defence, or C17 is process-scoped theatre. The interface is shaped for that
 * swap now so A4 is a change of storage rather than a change of design.
 */
/**
 * A quote's own lifecycle, and nothing about whether it was SPENT.
 *
 * `spent` used to live here and moved to the receipt in A4. Two records of the
 * same fact can disagree, and the dangerous direction is memory saying spent
 * while no receipt exists: a buyer whose money moved would be told `replayed`
 * while owning nothing. The receipt IS the purchase, so it is the only thing
 * asked.
 */
export type NonceState = 'ok' | 'unknown' | 'expired'

export interface PaymentNonces {
  /** Mint a nonce for this binding, remembering what it was issued for. */
  mint(binding: string, now: number, ttlMs: number): string
  /** What a quote was issued for, or null if we no longer hold it. */
  bindingOf(nonce: string): string | null
  /**
   * What this quote is right now. Three different things that happened to a
   * buyer, and collapsing any pair here collapses a 402 reason there — which
   * is what Magpie's C16 blocks on.
   */
  stateOf(nonce: string, now: number): NonceState
  /**
   * When this nonce lapses, or null if we no longer hold it.
   *
   * Needed so an answer that must NOT mint a fresh quote can still echo the
   * offer the buyer already holds — `unverifiable` and `replayed` both hand
   * back the terms they have rather than a new invitation to pay.
   */
  expiryOf(nonce: string): number | null
}

export class MemoryPaymentNonces implements PaymentNonces {
  private readonly issued = new Map<string, { binding: string; exp: number }>()

  mint(binding: string, now: number, ttlMs: number): string {
    const nonce = randomBytes(32).toString('base64url')
    this.issued.set(nonce, { binding, exp: now + ttlMs })
    // A lapsed quote is kept AS lapsed for a while: dropping it the moment it
    // expired made `expired` report as `invalid`, because the record needed to
    // tell them apart had just been swept.
    for (const [key, entry] of this.issued) {
      if (entry.exp + EXPIRED_RETENTION_MS < now) this.issued.delete(key)
    }
    return nonce
  }

  bindingOf(nonce: string): string | null {
    return this.issued.get(nonce)?.binding ?? null
  }

  expiryOf(nonce: string): number | null {
    return this.issued.get(nonce)?.exp ?? null
  }

  stateOf(nonce: string, now: number): NonceState {
    const entry = this.issued.get(nonce)
    if (entry === undefined) return 'unknown'
    return entry.exp < now ? 'expired' : 'ok'
  }
}

/**
 * How long a lapsed quote is still remembered AS lapsed. Long enough that a
 * buyer who walked away and came back is told their quote expired rather than
 * that their payment was invalid.
 */
export const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000

export interface QuoteDeps {
  config: TermsConfig
  nonces: PaymentNonces
  now: () => number
}

/**
 * Build the terms for one buyer and one preset.
 *
 * Returns null when the preset cannot be priced — no pricing, or an author with
 * no payout address. The caller decides what that means; this function will not
 * invent a payee.
 */
/**
 * The price facts, WITHOUT a nonce — what a preset costs and who is paid.
 *
 * Separate from `quoteFor` because minting is a side effect and verifying a
 * payment does not need one. Quoting on every request, including ones that
 * already carry a proof, minted a nonce nobody would ever use AND ran the sweep
 * that destroyed the record the proof was about.
 */
export function priceFor(
  deps: Pick<QuoteDeps, 'config'>,
  input: { pricing: PresetPricing | undefined; payTo: string | null }
): PriceFacts | null {
  if (input.pricing === undefined || input.payTo === null) return null
  return {
    amount: input.pricing.amount,
    asset: input.pricing.asset,
    chain: deps.config.chain,
    payTo: input.payTo
  }
}

/** Turn price facts into a standing offer: a fresh single-use nonce and a clock. */
export function quoteFrom(
  deps: QuoteDeps,
  input: { presetId: string; identityId: string; price: PriceFacts }
): Terms {
  const at = deps.now()
  return {
    ...input.price,
    nonce: deps.nonces.mint(
      purchaseBinding(input.identityId, input.presetId),
      at,
      deps.config.ttlMs
    ),
    expiry: at + deps.config.ttlMs
  }
}

export function quoteFor(
  deps: QuoteDeps,
  input: { presetId: string; identityId: string; pricing: PresetPricing | undefined; payTo: string | null }
): Terms | null {
  const price = priceFor(deps, input)
  if (price === null) return null
  return quoteFrom(deps, { presetId: input.presetId, identityId: input.identityId, price })
}
