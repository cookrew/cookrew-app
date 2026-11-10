import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { handOffCheckout } from '../src/main/serve-gate'
import { CHECKOUT_MAX_LIFE_SECONDS, CHECKOUT_TTL_SECONDS, isStripeCheckoutUrl } from '../src/shared/stripe-checkout'
import { GOOD, HOSTILE } from './support/checkout-urls'

/**
 * THE ONE PAGE A CARD PAYMENT MAY OPEN.
 *
 * The Checkout URL comes from the DOOR — the author's app, which the caller
 * has no reason to trust — and the app opens it: in the real browser on the
 * desktop (`shell.openExternal`), in a new tab on the phone (`window.open`).
 * `openExternal` will launch whatever handles the scheme it is given, so an
 * unchecked URL is a door choosing what runs on the buyer's machine. The rule
 * is Stripe's hosted Checkout, over https, and nothing that merely looks like it.
 */

describe('isStripeCheckoutUrl', () => {
  it('accepts Stripe’s hosted Checkout over https, fragment and all', () => {
    expect(isStripeCheckoutUrl(GOOD)).toBe(true)
    expect(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_live_x')).toBe(true)
    expect(isStripeCheckoutUrl('HTTPS://CHECKOUT.STRIPE.COM/c/pay/cs_test_1')).toBe(true)
  })

  it('refuses every other scheme, host, port and shape', () => {
    for (const url of HOSTILE) expect(isStripeCheckoutUrl(url), String(url)).toBe(false)
  })
})

describe('the session’s life is one number, shared', () => {
  it('a session can outlive one quote window but never two', () => {
    // stripe-rail sets expires_at to the end of the NEXT window, so a session
    // lives between one and two windows. Whoever waits on it waits two.
    expect(CHECKOUT_MAX_LIFE_SECONDS).toBe(2 * CHECKOUT_TTL_SECONDS)
  })
})

describe('handOffCheckout — the desktop’s opener', () => {
  const ok = (url: unknown) => ({ ok: true as const, session: 'cs_test_1', url: url as string })

  it('opens Stripe’s page and hands the checkout back unchanged', async () => {
    const open = vi.fn(async () => undefined)
    const checkout = ok(GOOD)
    expect(await handOffCheckout(checkout, open)).toBe(checkout)
    expect(open).toHaveBeenCalledWith(GOOD)
  })

  it('opens NOTHING for any other address, and says card payment is unavailable', async () => {
    const open = vi.fn(async () => undefined)
    for (const url of HOSTILE) {
      const answer = await handOffCheckout(ok(url), open)
      expect(answer, String(url)).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(JSON.stringify(answer), String(url)).not.toContain('evil.example')
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('passes a refusal through without opening anything', async () => {
    const open = vi.fn(async () => undefined)
    const refused = { ok: false as const, reason: 'not-signed-in' as const }
    expect(await handOffCheckout(refused, open)).toBe(refused)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('the wiring, as source', () => {
  const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')

  it('the desktop opens a checkout only through the checked opener', () => {
    const main = src('main/index.ts')
    expect(main).toContain('handOffCheckout(await serveOps.checkout(link), (url) => shell.openExternal(url))')
    expect(main).not.toMatch(/openExternal\(checkout\.url\)/)
  })

  it('the door and the caller read one rule, not a copy each', () => {
    for (const file of ['main/stripe-rail.ts', 'main/served-pay-route.ts', 'main/served-admission.ts', 'renderer/src/remote-api.ts']) {
      const text = src(file)
      expect(text, file).toContain('isStripeCheckoutUrl')
      expect(text, file).not.toContain("'checkout.stripe.com'")
    }
  })
})
