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
export type NonceState = 'ok' | 'unknown' | 'expired' | 'spent'

export interface PaymentNonces {
  /** Mint a nonce for this binding, remembering what it was issued for. */
  mint(binding: string, now: number, ttlMs: number): string
  /** What a nonce was issued for, or null if unknown or expired. */
  bindingOf(nonce: string, now: number): string | null
  /**
   * What this nonce is right now, WITHOUT consuming it.
   *
   * The four answers are four different things that happened to a buyer, and
   * A2 maps three of them onto three distinct 402 reasons. Collapsing any pair
   * here would collapse them there, which is what Magpie's C16 blocks on.
   */
  stateOf(nonce: string, now: number): NonceState
  /** Mark spent. False if it was already spent — the caller has a replay. */
  spend(nonce: string, now: number): boolean
}

export class MemoryPaymentNonces implements PaymentNonces {
  private readonly issued = new Map<string, { binding: string; exp: number }>()
  /**
   * SPENT NONCES ARE REMEMBERED, NOT DELETED, and that is the single most
   * load-bearing line in this class.
   *
   * Deleting on spend would make a replayed proof read as a nonce we never
   * issued — `replayed` would collapse into `invalid`, the two would become
   * indistinguishable, and Magpie's C16 would BLOCK. It would also be a worse
   * answer: "we have no record of this" and "this already bought something"
   * are different facts about a buyer who may simply have retried.
   *
   * Retention is therefore longer than the quote's TTL rather than equal to it.
   */
  private readonly spent = new Map<string, number>()

  mint(binding: string, now: number, ttlMs: number): string {
    const nonce = randomBytes(32).toString('base64url')
    this.issued.set(nonce, { binding, exp: now + ttlMs })
    this.sweep(now)
    return nonce
  }

  bindingOf(nonce: string, now: number): string | null {
    const entry = this.issued.get(nonce)
    if (entry === undefined || entry.exp < now) return null
    return entry.binding
  }

  stateOf(nonce: string, now: number): NonceState {
    // Spent is checked FIRST. A nonce that bought something and then expired is
    // still a replay, not a stale quote: telling that buyer to re-price would
    // invite them to pay twice.
    if (this.spent.has(nonce)) return 'spent'
    const entry = this.issued.get(nonce)
    if (entry === undefined) return 'unknown'
    return entry.exp < now ? 'expired' : 'ok'
  }

  spend(nonce: string, now: number): boolean {
    if (this.spent.has(nonce)) return false
    if (!this.issued.has(nonce)) return false
    this.spent.set(nonce, now + SPENT_RETENTION_MS)
    return true
  }

  /**
   * An EXPIRED nonce is kept for a while after it lapses, and that retention is
   * the second half of the same lesson as the spent set.
   *
   * Dropping it at the moment it expired made `expired` report as `invalid` —
   * "your quote timed out" became "that is not a payment" — because the record
   * needed to tell them apart had just been swept. C16 caught it: minting the
   * replacement quote ran the sweep, which deleted the very nonce the request
   * was asking about. A buyer who was merely slow deserves a better answer than
   * one who sent garbage.
   */
  private sweep(now: number): void {
    for (const [key, entry] of this.issued) {
      if (entry.exp + EXPIRED_RETENTION_MS < now) this.issued.delete(key)
    }
    for (const [key, until] of this.spent) if (until < now) this.spent.delete(key)
  }
}

/**
 * How long a spent nonce is remembered. Generously longer than any quote TTL,
 * because forgetting one turns a replay into an `invalid` — and in A4 this
 * moves to storage that survives a restart, since replay defence that resets
 * on reboot is process-scoped theatre.
 */
export const SPENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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
