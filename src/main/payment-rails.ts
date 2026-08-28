export type RailSettlement = 'ok' | 'refused' | 'unverifiable'

export interface PaymentTermsEnvelope {
  x402Version: 1
  accepts: unknown[]
}

export interface StripeCheckoutTerms {
  scheme: 'stripe-checkout'
  network: 'stripe'
  amountUsd: string
  currency: 'usd'
  payUrl: string
}

/** One quote menu. A missing rail shortens it; only no rails makes it null. */
export function combinePaymentTerms(
  x402: PaymentTermsEnvelope | null,
  stripe: StripeCheckoutTerms | null
): PaymentTermsEnvelope | null {
  const accepts = [...(x402?.accepts ?? []), ...(stripe === null ? [] : [stripe])]
  return accepts.length === 0 ? null : { x402Version: 1, accepts }
}

export interface RailSettleDeps {
  x402(payment: string): Promise<RailSettlement>
  stripe(payment: string): Promise<RailSettlement>
}

function stripeSession(payment: string): { stripe: false } | { stripe: true; session: string | null } {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payment, 'base64').toString('utf8'))
  } catch {
    return { stripe: false }
  }
  if (typeof value !== 'object' || value === null || (value as { rail?: unknown }).rail !== 'stripe') {
    return { stripe: false }
  }
  const session = (value as { session?: unknown }).session
  return {
    stripe: true,
    session: typeof session === 'string' && /^cs_[A-Za-z0-9_]+$/.test(session) ? session : null
  }
}

/** Dispatch the existing X-Payment header without teaching the gate either rail. */
export async function railSettle(
  deps: RailSettleDeps,
  payment: string
): Promise<RailSettlement> {
  const envelope = stripeSession(payment)
  if (!envelope.stripe) return deps.x402(payment)
  if (envelope.session === null) return 'refused'
  return deps.stripe(payment)
}
