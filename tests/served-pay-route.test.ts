import { describe, expect, it, vi } from 'vitest'
import { handleServedPayRoute, type ServedPayRouteDeps } from '../src/main/served-pay-route'
import type { ServedTemplate } from '../src/main/session-served'

const PAID: ServedTemplate = {
  serviceId: 'svc-research',
  templateId: 'research-team',
  slug: 'research',
  access: 'paid',
  priceUsd: '2.50'
}

const deps = (over: Partial<ServedPayRouteDeps> = {}): ServedPayRouteDeps => ({
  issuer: {
    challenge: () => 'challenge-value',
    verifyToken: (token) => token === 'good' ? { sub: 'ana', workspace: PAID.serviceId } : null
  },
  createCheckout: async () => 'https://checkout.stripe.com/c/pay/cs_test_value',
  successUrl: () => 'https://owner.example/research?payment=received',
  ...over
})

const pay = (
  d: ServedPayRouteDeps,
  headers: Record<string, string | undefined> = { authorization: 'Bearer good' },
  template = PAID
) => handleServedPayRoute(d, template, 'POST', '/api/call/pay', headers)

describe('the authenticated Stripe Checkout route', () => {
  it('returns null outside its one method and path', async () => {
    expect(await handleServedPayRoute(deps(), PAID, 'GET', '/api/call/pay', {})).toBeNull()
    expect(await handleServedPayRoute(deps(), PAID, 'POST', '/ask', {})).toBeNull()
  })

  it('uses the same bearer scope as /ask', async () => {
    const missing = await pay(deps(), {})
    expect(missing).toMatchObject({ status: 401, body: {} })
    expect(missing?.headers?.['www-authenticate']).toContain('challenge=challenge-value')

    const wrong = deps({
      issuer: {
        challenge: () => 'challenge-value',
        verifyToken: () => ({ sub: 'ana', workspace: 'svc-other' })
      }
    })
    expect(await pay(wrong)).toMatchObject({ status: 403, body: { reason: 'workspace' } })
  })

  it('creates terms from our template and the verified subject', async () => {
    const createCheckout = vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test_value')
    const answer = await pay(deps({ createCheckout }))

    expect(answer).toEqual({
      status: 200,
      body: { url: 'https://checkout.stripe.com/c/pay/cs_test_value' }
    })
    expect(createCheckout).toHaveBeenCalledWith({
      serviceId: PAID.serviceId,
      sub: 'ana',
      slug: PAID.slug,
      amountUsd: PAID.priceUsd,
      successUrl: 'https://owner.example/research?payment=received'
    })
  })

  it('is unavailable, not an admission, when the key or Stripe is absent', async () => {
    expect(await pay(deps({ createCheckout: null }))).toMatchObject({ status: 503 })
    expect(await pay(deps({ createCheckout: async () => null }))).toMatchObject({ status: 503 })
    expect(await pay(deps({ createCheckout: async () => { throw new Error('network') } }))).toMatchObject({ status: 503 })
  })

  it('never hands a caller a non-Stripe or non-HTTPS redirect', async () => {
    expect(await pay(deps({ createCheckout: async () => 'https://example.invalid/collect' }))).toMatchObject({ status: 503 })
    expect(await pay(deps({ createCheckout: async () => 'http://checkout.stripe.com/not-secure' }))).toMatchObject({ status: 503 })
  })

  it('does not offer payment for an account-only crew', async () => {
    expect(await pay(deps(), undefined, { ...PAID, access: 'account', priceUsd: undefined })).toEqual({
      status: 404,
      body: {}
    })
  })
})
