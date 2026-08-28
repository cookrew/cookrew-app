import type { ServedPaymentRail } from './served-payment-rails'

export type StripeMode = 'test' | 'live'

export interface ServedPaymentStatus {
  x402: { ready: false } | { ready: true; payTo: string }
  stripe: { ready: false } | { ready: true; mode: StripeMode }
}

export type PaymentConfigReason = 'invalid-pay-to' | 'invalid-stripe-key' | 'write-failed'

export type PaymentConfigResult = { ok: true } | { ok: false; reason: PaymentConfigReason }

export type PaymentConfigReply =
  | { ok: true; status: ServedPaymentStatus }
  | { ok: false; reason: PaymentConfigReason }

export const EMPTY_SERVED_PAYMENT_STATUS: ServedPaymentStatus = Object.freeze({
  x402: Object.freeze({ ready: false }),
  stripe: Object.freeze({ ready: false })
})

export function isPayToAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim())
}

export function stripeSecretMode(value: string): StripeMode | null {
  const match = value.trim().match(/^sk_(test|live)_[A-Za-z0-9]{16,}$/)
  return match ? (match[1] as StripeMode) : null
}

export function readyPaymentRails(status: ServedPaymentStatus): readonly ServedPaymentRail[] {
  const rails: ServedPaymentRail[] = []
  if (status.x402.ready) rails.push('x402')
  if (status.stripe.ready) rails.push('stripe')
  return rails
}
