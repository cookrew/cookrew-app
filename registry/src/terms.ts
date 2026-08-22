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
export interface PaymentNonces {
  /** Mint a nonce for this binding, remembering what it was issued for. */
  mint(binding: string, now: number, ttlMs: number): string
  /** What a nonce was issued for, or null if unknown or expired. */
  bindingOf(nonce: string, now: number): string | null
}

export class MemoryPaymentNonces implements PaymentNonces {
  private readonly issued = new Map<string, { binding: string; exp: number }>()

  mint(binding: string, now: number, ttlMs: number): string {
    const nonce = randomBytes(32).toString('base64url')
    this.issued.set(nonce, { binding, exp: now + ttlMs })
    for (const [key, entry] of this.issued) if (entry.exp < now) this.issued.delete(key)
    return nonce
  }

  bindingOf(nonce: string, now: number): string | null {
    const entry = this.issued.get(nonce)
    if (entry === undefined || entry.exp < now) return null
    return entry.binding
  }
}

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
export function quoteFor(
  deps: QuoteDeps,
  input: { presetId: string; identityId: string; pricing: PresetPricing | undefined; payTo: string | null }
): Terms | null {
  if (input.pricing === undefined || input.payTo === null) return null
  const at = deps.now()
  return {
    amount: input.pricing.amount,
    asset: input.pricing.asset,
    chain: deps.config.chain,
    payTo: input.payTo,
    nonce: deps.nonces.mint(
      purchaseBinding(input.identityId, input.presetId),
      at,
      deps.config.ttlMs
    ),
    expiry: at + deps.config.ttlMs
  }
}
