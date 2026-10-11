// THE PANEL THAT OFFERS THE ONE NAVIGATION, AND THE TAP THAT TAKES IT.
//
// One sentence and one button, above the attempts in the badge's sheet — above
// them because the rows are evidence and this is the conclusion drawn from
// them, and a reader who is already looking at four timed-out LAN addresses
// should not have to scroll past them to find the fix.
//
// The two rules it must never break are both about the credential. The token
// is read at the tap, from this desktop's own key, and goes into the URL and
// nowhere else: not a log line, not an attempt row, not the rendered markup of
// a page that is about to be screenshotted. And the tap is the only caller —
// the automatic gates in companion-relay-no-jump.test.ts still say that
// nothing on a timer, a race or a boot path may navigate.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DIRECT_OFFER_COPY } from '../src/renderer/src/path-copy'
import type { DirectOffer } from '../src/renderer/src/path/direct-offer'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-84-1-9.${DEVICE}.d.cookrew.dev:8643`
const TOKEN = 'secret-token-value-000000'

afterEach(() => vi.resetModules())

const row = async (offer: DirectOffer | null): Promise<string> => {
  vi.resetModules()
  const gate = await import('../src/renderer/src/direct-offer-gate')
  const { DirectOfferRow } = await import('../src/renderer/src/DirectOfferRow')
  gate.resetDirectOffer()
  gate.setDirectOffer(offer)
  return renderToStaticMarkup(<DirectOfferRow />)
}

describe('the panel', () => {
  it('says what was measured, not a cause read off the user agent', async () => {
    const markup = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    expect(markup).toContain('That Mac did not answer in time.')
    expect(markup).toContain('Try again:')
    // Never the site-settings sentence: there is no such setting on iOS. And
    // never the platform verdict either — the rows under this say "timed out"
    // and the permission line above them is where a cause belongs.
    expect(markup).not.toContain('site settings')
    expect(markup).not.toContain('Apple never asks')
  })

  it('says the same thing whichever browser the phone is running', async () => {
    const safari = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    const chrome = await row({ origin: LAN, kind: 'lan', family: 'Chrome', reason: 'timeout' })
    expect(chrome).toBe(safari)
  })

  it('offers TRY AGAIN and nothing else for a timeout or a refusal — the page goes home by itself', async () => {
    // Owner, 2026-10-11: no OPEN ON WI-FI. When a knock the browser carries
    // reaches the Mac the page navigates on its own (path/home-jump.ts); when
    // none does, a button to the same address is a dead page with a token.
    for (const reason of ['timeout', 'blocked'] as const) {
      const lan = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason })
      expect(lan).toContain(`>${DIRECT_OFFER_COPY.retry}</button>`)
      expect(lan).not.toContain(DIRECT_OFFER_COPY.lan)
      expect(lan).not.toContain(DIRECT_OFFER_COPY.tailnet)
      expect(lan).toContain('cr-btn')
    }
  })

  it('keeps the navigation for the one case it fixes: a desktop behind a system proxy', async () => {
    const proxy = await row({ origin: LAN, kind: 'lan', family: 'Chrome', reason: 'proxy' })
    expect(proxy).toContain(`>${DIRECT_OFFER_COPY.lan}</button>`)
    expect(proxy).toContain(`>${DIRECT_OFFER_COPY.retry}</button>`)
    expect(proxy.indexOf(DIRECT_OFFER_COPY.lan)).toBeLessThan(proxy.indexOf(DIRECT_OFFER_COPY.retry))
    const tailnet = await row({ origin: TAILNET, kind: 'tailnet', family: 'Chrome', reason: 'proxy' })
    expect(tailnet).toContain(`>${DIRECT_OFFER_COPY.tailnet}</button>`)
  })

  it('never draws the address, the device id or a token', async () => {
    const markup = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    expect(markup).not.toContain(DEVICE)
    expect(markup).not.toContain('d.cookrew.dev')
    expect(markup).not.toContain('token')
  })

  it('is nothing at all when there is no offer', async () => {
    expect(await row(null)).toBe('')
  })

  it('on a REFUSAL says so', async () => {
    const markup = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'blocked' })
    expect(markup).toContain('Safari refused')
    expect(markup).not.toContain('did not answer in time')
  })
})
