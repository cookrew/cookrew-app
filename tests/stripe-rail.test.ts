import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createStripeRedemptionStore,
  decodeStripePaymentHeader,
  stripeCreateCheckout,
  stripeGet,
  stripePaymentTerms,
  stripePost,
  stripeSettle,
  usdToCents,
  type StripeConfig,
  type StripeGet,
  type StripeHttpResponse,
  type StripePost
} from '../src/main/stripe-rail'

const CONFIG: StripeConfig = {
  secretKey: 'injected-test-value',
  successBaseUrl: 'https://crews.example.test/'
}
const SESSION = 'cs_test_paid_1'
const envelope = (session = SESSION): string =>
  Buffer.from(JSON.stringify({ rail: 'stripe', session })).toString('base64')
const paidSession = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SESSION,
  payment_status: 'paid',
  amount_total: 250,
  currency: 'usd',
  metadata: { serviceId: 'svc-1', sub: 'ana', slug: 'crew-one' },
  ...over
})
const expected = { amountUsd: '2.50', serviceId: 'svc-1', sub: 'ana' }

const dirs: string[] = []
const ledger = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-stripe-'))
  dirs.push(dir)
  return path.join(dir, 'stripe-redemptions.json')
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Stripe USD terms', () => {
  it('converts only positive, exactly representable cents', () => {
    expect(usdToCents('2')).toBe(200)
    expect(usdToCents('2.5')).toBe(250)
    expect(usdToCents('2.50')).toBe(250)
    expect(usdToCents('0.01')).toBe(1)
    for (const bad of ['', '0', '-1', '1.001', '1e2', '$2', '2.']) expect(usdToCents(bad)).toBeNull()
  })

  it('adds a card entry only when a secret, price, and pay URL are configured', () => {
    expect(stripePaymentTerms(CONFIG, '2.50', '/crew/api/call/pay')).toEqual({
      scheme: 'stripe-checkout',
      network: 'stripe',
      amountUsd: '2.50',
      currency: 'usd',
      payUrl: '/crew/api/call/pay'
    })
    expect(stripePaymentTerms(null, '2.50', '/pay')).toBeNull()
    expect(stripePaymentTerms({ secretKey: ' ' }, '2.50', '/pay')).toBeNull()
    expect(stripePaymentTerms(CONFIG, '0.001', '/pay')).toBeNull()
    expect(stripePaymentTerms(CONFIG, '2.50', ' ')).toBeNull()
  })
})

describe('Checkout creation', () => {
  it('posts a 30-minute, form-encoded Checkout with bound metadata', async () => {
    let call: { url: string; headers: Readonly<Record<string, string>>; form: URLSearchParams } | null = null
    const post: StripePost = async (url, request) => {
      call = { url, headers: request.headers, form: new URLSearchParams(request.body) }
      return {
        ok: true,
        status: 200,
        json: { id: SESSION, url: 'https://checkout.stripe.com/c/pay/test' }
      }
    }

    const result = await stripeCreateCheckout(
      { config: CONFIG, post, now: () => 1_000_000 },
      { priceUsd: '2.50', serviceId: 'svc-1', sub: 'ana', slug: 'crew-one' }
    )

    expect(result).toEqual({ ok: true, session: SESSION, url: 'https://checkout.stripe.com/c/pay/test' })
    expect(call).not.toBeNull()
    expect(call!.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(call!.headers).toEqual({
      authorization: 'Bearer injected-test-value',
      'content-type': 'application/x-www-form-urlencoded',
      // Pinned, so a Stripe API upgrade cannot change response shapes under a
      // shipped desktop app; keyed by the caller's INTENT, so a retry after a
      // timeout replays the first session instead of charging twice.
      'stripe-version': '2025-08-27.basil',
      'idempotency-key': 'checkout:svc-1:ana:250'
    })
    // Tax is computed by Stripe, never by us: the AI-service tax code, an
    // address to locate the buyer, and a tax ID so a cross-border B2B sale can
    // take reverse charge. Hong Kong levies no VAT itself — the obligation, if
    // any, lives in the CUSTOMER's country.
    expect(Object.fromEntries(call!.form)).toMatchObject({
      'line_items[0][price_data][product_data][tax_code]': 'txcd_10105002',
      'automatic_tax[enabled]': 'true',
      'billing_address_collection': 'required',
      'tax_id_collection[enabled]': 'true',
      customer_creation: 'always',
      // Card statements: COOKREW* AI SESSION — 19 chars against the 22 limit,
      // so the reader can tell an agent session from a website invoice.
      'payment_intent_data[statement_descriptor_suffix]': 'AI SESSION',
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '250',
      'line_items[0][price_data][product_data][name]': 'One session with the crew-one crew',
      'line_items[0][quantity]': '1',
      expires_at: '2800',
      'metadata[serviceId]': 'svc-1',
      'metadata[sub]': 'ana',
      'metadata[slug]': 'crew-one',
      success_url: 'https://crews.example.test/crew-one?payment=received'
    })
  })

  it('accepts a resolved success URL and pins the received marker', async () => {
    let success = ''
    const post: StripePost = async (_url, request) => {
      success = new URLSearchParams(request.body).get('success_url') ?? ''
      return { ok: true, status: 200, json: { id: SESSION, url: 'https://checkout.stripe.com/x' } }
    }
    await stripeCreateCheckout(
      { config: { secretKey: CONFIG.secretKey }, post },
      {
        priceUsd: '2.50',
        serviceId: 'svc-1',
        sub: 'ana',
        slug: 'crew-one',
        successUrl: 'http://127.0.0.1:8639/crew-one?source=checkout'
      }
    )
    expect(success).toBe('http://127.0.0.1:8639/crew-one?source=checkout&payment=received')
  })

  it('rejects invalid local input without a network call', async () => {
    const post = vi.fn<StripePost>()
    const base = { priceUsd: '2.50', serviceId: 'svc-1', sub: 'ana', slug: 'crew-one' }
    for (const input of [
      { ...base, priceUsd: '0.001' },
      { ...base, serviceId: '' },
      { ...base, sub: '' },
      { ...base, slug: '' }
    ]) {
      expect(await stripeCreateCheckout({ config: CONFIG, post }, input)).toEqual({
        ok: false,
        reason: 'invalid'
      })
    }
    expect(post).not.toHaveBeenCalled()
  })

  it('calls API failures and malformed success replies unverifiable', async () => {
    const input = { priceUsd: '2.50', serviceId: 'svc-1', sub: 'ana', slug: 'crew-one' }
    const run = (reply: StripeHttpResponse): ReturnType<typeof stripeCreateCheckout> =>
      stripeCreateCheckout({ config: CONFIG, post: async () => reply }, input)
    await expect(run({ ok: false, status: 401, json: {} })).resolves.toEqual({ ok: false, reason: 'unverifiable' })
    await expect(run({ ok: true, status: 200, json: null })).resolves.toEqual({ ok: false, reason: 'unverifiable' })
    await expect(run({ ok: true, status: 200, json: { id: 'bad', url: 'https://checkout.stripe.com/x' } })).resolves.toEqual({ ok: false, reason: 'unverifiable' })
    await expect(run({ ok: true, status: 200, json: { id: SESSION, url: 'https://example.test/x' } })).resolves.toEqual({ ok: false, reason: 'unverifiable' })
    await expect(
      stripeCreateCheckout({ config: CONFIG, post: async () => Promise.reject(new Error('down')) }, input)
    ).resolves.toEqual({ ok: false, reason: 'unverifiable' })
  })
})

describe('Stripe payment header', () => {
  it('decodes only a Stripe cs_ envelope', () => {
    expect(decodeStripePaymentHeader(envelope())).toEqual({ rail: 'stripe', session: SESSION })
    expect(decodeStripePaymentHeader('not-json')).toBeNull()
    expect(decodeStripePaymentHeader(Buffer.from(JSON.stringify({ rail: 'x402', session: SESSION })).toString('base64'))).toBeNull()
    expect(decodeStripePaymentHeader(envelope('../escape'))).toBeNull()
  })
})

describe('settlement', () => {
  const run = (
    get: StripeGet,
    file = ledger(),
    header = envelope(),
    terms = expected
  ) => stripeSettle({ config: CONFIG, get, redemptions: createStripeRedemptionStore(file) }, header, terms)

  it('accepts exactly paid amount/currency/service/account and burns the id', async () => {
    const file = ledger()
    const get = vi.fn<StripeGet>().mockResolvedValue({ ok: true, status: 200, json: paidSession() })
    await expect(run(get, file)).resolves.toBe('ok')
    await expect(run(get, file)).resolves.toBe('refused')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]).toEqual([
      `https://api.stripe.com/v1/checkout/sessions/${SESSION}`,
      {
        headers: {
          authorization: 'Bearer injected-test-value',
          'stripe-version': '2025-08-27.basil'
        }
      }
    ])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([SESSION])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['unpaid', { payment_status: 'unpaid' }],
    ['wrong amount', { amount_total: 249 }],
    ['missing amount', { amount_total: null }],
    ['wrong currency', { currency: 'eur' }],
    ['wrong service', { metadata: { serviceId: 'svc-2', sub: 'ana' } }],
    ['wrong account', { metadata: { serviceId: 'svc-1', sub: 'ben' } }],
    ['missing metadata', { metadata: null }],
    ['mismatched response id', { id: 'cs_test_other' }]
  ])('refuses %s and leaves the id unburned', async (_name, over) => {
    const file = ledger()
    const get: StripeGet = async () => ({ ok: true, status: 200, json: paidSession(over) })
    await expect(run(get, file)).resolves.toBe('refused')
    expect(createStripeRedemptionStore(file).has(SESSION)).toBe(false)
  })

  it('refuses malformed headers locally and Stripe 404 verdicts', async () => {
    const get = vi.fn<StripeGet>().mockResolvedValue({ ok: false, status: 404, json: { error: {} } })
    await expect(run(get, ledger(), 'junk')).resolves.toBe('refused')
    expect(get).not.toHaveBeenCalled()
    await expect(run(get)).resolves.toBe('refused')
  })

  it('calls network, auth, and unreadable replies unverifiable without burning', async () => {
    const cases: StripeGet[] = [
      async () => Promise.reject(new Error('down')),
      async () => ({ ok: false, status: 401, json: { error: {} } }),
      async () => ({ ok: false, status: 500, json: null }),
      async () => ({ ok: true, status: 200, json: null })
    ]
    for (const get of cases) {
      const file = ledger()
      await expect(run(get, file)).resolves.toBe('unverifiable')
      expect(createStripeRedemptionStore(file).has(SESSION)).toBe(false)
    }
  })

  it('does not forget a redemption across a new store instance', async () => {
    const file = ledger()
    const first = createStripeRedemptionStore(file)
    expect(first.redeem(SESSION)).toBe(true)
    const afterRestart = createStripeRedemptionStore(file)
    expect(afterRestart.has(SESSION)).toBe(true)
    expect(afterRestart.redeem(SESSION)).toBe(false)
  })

  it('admits only one of two concurrent settlements of the same id', async () => {
    const file = ledger()
    const get: StripeGet = async () => ({ ok: true, status: 200, json: paidSession() })
    const outcomes = await Promise.all([run(get, file), run(get, file)])
    expect(outcomes.sort()).toEqual(['ok', 'refused'])
  })

  it('treats a corrupt or unwritable ledger as our unverifiable failure', async () => {
    const file = ledger()
    writeFileSync(file, '{not-json')
    const get = vi.fn<StripeGet>().mockResolvedValue({ ok: true, status: 200, json: paidSession() })
    await expect(run(get, file)).resolves.toBe('unverifiable')
    expect(get).not.toHaveBeenCalled()
  })
})

describe('raw HTTP adapters', () => {
  it('parse JSON without touching a real network', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ id: SESSION }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      stripePost('https://api.stripe.com/post', { headers: { authorization: 'Bearer test' }, body: 'a=b' })
    ).resolves.toMatchObject({ ok: true, status: 200, json: { id: SESSION } })
    await expect(
      stripeGet('https://api.stripe.com/get', { headers: { authorization: 'Bearer test' } })
    ).resolves.toMatchObject({ ok: true, status: 200, json: { id: SESSION } })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.stripe.com/post', expect.objectContaining({ method: 'POST', body: 'a=b' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.stripe.com/get', expect.objectContaining({ method: 'GET' }))
  })

  it('returns null JSON for a non-JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })))
    await expect(stripeGet('https://api.stripe.com/get', { headers: {} })).resolves.toEqual({
      ok: false,
      status: 502,
      json: null
    })
  })
})
