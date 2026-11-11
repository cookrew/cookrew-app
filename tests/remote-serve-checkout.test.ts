import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOD, HOSTILE } from './support/checkout-urls'

/**
 * THE PHONE'S OPENER. The companion opens the card page itself, in its own
 * browser — and the address reached it over the wire from a desktop that got
 * it from a door. Checked again HERE, so no path can hand `window.open`
 * anything but Stripe's hosted Checkout.
 */

let opened: unknown[][] = []

function installWindow(): void {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  opened = []
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: storage,
    sessionStorage: storage,
    location: { search: '?token=paired-token', href: 'https://phone.local/' },
    history: { replaceState: () => undefined },
    open: (...args: unknown[]) => {
      opened.push(args)
      return null
    }
  }
}

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response
}

/** The real phone bridge, with the desktop answering `/api/serve/checkout` one way. */
async function checkoutAnswering(answer: unknown): Promise<unknown> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).includes('/api/serve/checkout') ? respond(answer) : respond({})
    )
  )
  const { createRemoteApi } = await import('../src/renderer/src/remote-api')
  return createRemoteApi().serveCheckout('@drej/alpha')
}

beforeEach(() => {
  vi.resetModules()
  installWindow()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.unstubAllGlobals()
})

describe('remote-api serveCheckout', () => {
  it('opens Stripe’s hosted page in a new tab and hands the session back', async () => {
    const answer = await checkoutAnswering({ ok: true, session: 'cs_test_a1B2c3', url: GOOD })
    expect(answer).toEqual({ ok: true, session: 'cs_test_a1B2c3', url: GOOD })
    expect(opened).toEqual([[GOOD, '_blank', 'noopener']])
  })

  it('opens the canonical form of the address, not the string that came over the wire', async () => {
    await checkoutAnswering({ ok: true, session: 'cs_test_1', url: 'HTTPS://CHECKOUT.STRIPE.COM/c/pay/cs_test_1' })
    expect(opened).toEqual([['https://checkout.stripe.com/c/pay/cs_test_1', '_blank', 'noopener']])
  })

  it('opens nothing for any other address, and reports card payment unavailable', async () => {
    for (const url of HOSTILE) {
      vi.resetModules()
      const answer = await checkoutAnswering({ ok: true, session: 'cs_test_1', url })
      expect(answer, String(url)).toMatchObject({ ok: false, reason: 'unavailable' })
    }
    expect(opened).toEqual([])
  })

  it('a refusal from the desktop opens nothing', async () => {
    expect(await checkoutAnswering({ ok: false, reason: 'not-signed-in' })).toEqual({ ok: false, reason: 'not-signed-in' })
    expect(opened).toEqual([])
  })
})
