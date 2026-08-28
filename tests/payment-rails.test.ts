import { describe, expect, it, vi } from 'vitest'
import {
  combinePaymentTerms,
  railSettle,
  type PaymentTermsEnvelope,
  type StripeCheckoutTerms
} from '../src/main/payment-rails'

const x402: PaymentTermsEnvelope = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', network: 'base-sepolia' }]
}
const stripe: StripeCheckoutTerms = {
  scheme: 'stripe-checkout',
  network: 'stripe',
  amountUsd: '2.50',
  currency: 'usd',
  payUrl: '/research/api/call/pay'
}

describe('one quote, two independent rails', () => {
  it('keeps x402 first and appends card checkout', () => {
    expect(combinePaymentTerms(x402, stripe)).toEqual({
      x402Version: 1,
      accepts: [x402.accepts[0], stripe]
    })
  })

  it('a missing rail shortens the menu instead of causing a 503', () => {
    expect(combinePaymentTerms(x402, null)).toEqual(x402)
    expect(combinePaymentTerms(null, stripe)).toEqual({ x402Version: 1, accepts: [stripe] })
  })

  it('returns null only when neither rail can quote', () => {
    expect(combinePaymentTerms(null, null)).toBeNull()
  })
})

const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')

describe('X-Payment rail dispatch', () => {
  it('routes the existing x402 payload unchanged', async () => {
    const payment = encoded({ x402Version: 1, scheme: 'exact', payload: {} })
    const x402Settle = vi.fn(async () => 'ok' as const)
    const stripeSettle = vi.fn(async () => 'ok' as const)

    expect(await railSettle({ x402: x402Settle, stripe: stripeSettle }, payment)).toBe('ok')
    expect(x402Settle).toHaveBeenCalledWith(payment)
    expect(stripeSettle).not.toHaveBeenCalled()
  })

  it('routes a Stripe envelope by its session id', async () => {
    const x402Settle = vi.fn(async () => 'refused' as const)
    const stripeSettle = vi.fn(async () => 'ok' as const)
    const payment = encoded({ rail: 'stripe', session: 'cs_test_checkout_1' })

    expect(
      await railSettle({ x402: x402Settle, stripe: stripeSettle }, payment)
    ).toBe('ok')
    expect(stripeSettle).toHaveBeenCalledWith(payment)
    expect(x402Settle).not.toHaveBeenCalled()
  })

  it('refuses a malformed Stripe envelope without trying either network', async () => {
    const x402Settle = vi.fn(async () => 'ok' as const)
    const stripeSettle = vi.fn(async () => 'ok' as const)

    for (const payment of [
      encoded({ rail: 'stripe' }),
      encoded({ rail: 'stripe', session: 7 }),
      encoded({ rail: 'stripe', session: 'not_a_checkout' })
    ]) {
      expect(await railSettle({ x402: x402Settle, stripe: stripeSettle }, payment)).toBe('refused')
    }
    expect(x402Settle).not.toHaveBeenCalled()
    expect(stripeSettle).not.toHaveBeenCalled()
  })

  it('leaves junk and unknown envelopes to x402, whose decoder owns refusal', async () => {
    const x402Settle = vi.fn(async () => 'refused' as const)
    const stripeSettle = vi.fn(async () => 'ok' as const)
    const values = ['not-base64', encoded({ rail: 'other', session: 'cs_test_1' })]

    for (const payment of values) {
      expect(await railSettle({ x402: x402Settle, stripe: stripeSettle }, payment)).toBe('refused')
    }
    expect(x402Settle).toHaveBeenCalledTimes(2)
    expect(stripeSettle).not.toHaveBeenCalled()
  })
})
