import { describe, expect, it, vi } from 'vitest'
import { handleServedPayRoute, returnUrlFor, type ServedPayRouteDeps } from '../src/main/served-pay-route'
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
  template = PAID,
  body: unknown = null
) => handleServedPayRoute(d, template, 'POST', '/api/call/pay', headers, body)

const LISTED: Partial<ServedPayRouteDeps> = {
  doorName: () => '@drej/research',
  registryOrigin: () => 'https://cookrew.dev'
}

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

  it('sends a buyer back to the team page it asked for, at the registry, and names the team', async () => {
    const createCheckout = vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test_value')
    const answer = await pay(deps({ createCheckout, ...LISTED }), undefined, PAID, {
      returnUrl: 'https://cookrew.dev/drej/research'
    })
    expect(answer).toMatchObject({ status: 200 })
    expect(createCheckout).toHaveBeenCalledWith({
      serviceId: PAID.serviceId,
      sub: 'ana',
      slug: PAID.slug,
      amountUsd: PAID.priceUsd,
      successUrl: 'https://owner.example/research?payment=received',
      returnUrl: 'https://cookrew.dev/drej/research',
      team: '@drej/research'
    })
  })

  it('refuses a return anywhere but this door\'s own page, rather than quietly replacing it', async () => {
    const createCheckout = vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test_value')
    for (const returnUrl of [
      'https://evil.example/drej/research',
      'https://cookrew.dev/drej/other',
      'https://cookrew.dev/drej/research?x=1',
      'javascript:alert(1)',
      '/drej/research',
      42
    ]) {
      expect(await pay(deps({ createCheckout, ...LISTED }), undefined, PAID, { returnUrl })).toEqual({
        status: 400,
        body: { error: 'bad_return' }
      })
    }
    // An unlisted door has no page to return to.
    expect(await pay(deps({ createCheckout }), undefined, PAID, { returnUrl: 'https://cookrew.dev/drej/research' })).toEqual({
      status: 400,
      body: { error: 'bad_return' }
    })
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('keeps the door\'s own face as the return when no page is asked for', async () => {
    const createCheckout = vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test_value')
    await pay(deps({ createCheckout, ...LISTED }), undefined, PAID, {})
    expect(createCheckout).toHaveBeenCalledWith(expect.not.objectContaining({ returnUrl: expect.anything() }))
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ team: '@drej/research' }))
  })

  it('does not offer payment for an account-only crew', async () => {
    expect(await pay(deps(), undefined, { ...PAID, access: 'account', priceUsd: undefined })).toEqual({
      status: 404,
      body: {}
    })
  })
})

describe('returnUrlFor — the one page a buyer may be sent back to', () => {
  const at = (candidate: unknown, origin = 'https://cookrew.dev', door: string | null = '@drej/alpha') =>
    returnUrlFor(origin, door, candidate)

  it('accepts exactly the team page at the registry origin, canonicalised', () => {
    expect(at('https://cookrew.dev/drej/alpha')).toBe('https://cookrew.dev/drej/alpha')
    expect(at('HTTPS://COOKREW.DEV/drej/alpha')).toBe('https://cookrew.dev/drej/alpha')
    // A loopback registry is what tests and a QA instance run against.
    expect(at('http://127.0.0.1:8790/owner/crew', 'http://127.0.0.1:8790', '@owner/crew')).toBe('http://127.0.0.1:8790/owner/crew')
  })

  it('refuses every other origin, path, scheme and shape', () => {
    expect(at('https://evil.example/drej/alpha')).toBeNull()
    expect(at('http://cookrew.dev/drej/alpha')).toBeNull()
    expect(at('https://cookrew.dev/drej/other')).toBeNull()
    expect(at('https://cookrew.dev/drej/alpha/')).toBeNull()
    expect(at('https://cookrew.dev/@drej/alpha')).toBeNull()
    expect(at('https://cookrew.dev/drej/alpha?paid=cs_1')).toBeNull()
    expect(at('https://cookrew.dev/drej/alpha#open')).toBeNull()
    expect(at('https://user:pw@cookrew.dev/drej/alpha')).toBeNull()
    expect(at('javascript:alert(1)')).toBeNull()
    expect(at('/drej/alpha')).toBeNull()
    expect(at('')).toBeNull()
    expect(at(null)).toBeNull()
    expect(at('https://cookrew.dev/drej/alpha', 'not a url')).toBeNull()
    expect(at('https://cookrew.dev/drej/alpha', 'https://cookrew.dev', null)).toBeNull()
  })
})
