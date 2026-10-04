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
    expect(markup).toContain('Try again, or open it directly:')
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

  it('offers TRY AGAIN first, then the navigation named for the network', async () => {
    const lan = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    expect(lan).toContain(`>${DIRECT_OFFER_COPY.retry}</button>`)
    expect(lan).toContain(`>${DIRECT_OFFER_COPY.lan}</button>`)
    // The order the sentence names them in: race again before leaving the page.
    expect(lan.indexOf(DIRECT_OFFER_COPY.retry)).toBeLessThan(lan.indexOf(DIRECT_OFFER_COPY.lan))
    expect(lan).toContain('cr-btn')
    const tailnet = await row({ origin: TAILNET, kind: 'tailnet', family: 'Safari', reason: 'timeout' })
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

  it('on a REFUSAL says so, and puts the navigation before the race', async () => {
    // 2026-10-04, the owner's iPhone: the row said "refused by the browser
    // before connecting — 4 ms" and this headline said "did not answer in
    // time". The buttons keep the order the sentence names them in, and a
    // sentence about a refusal names leaving the page first.
    const markup = await row({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'blocked' })
    expect(markup).toContain('Safari refused')
    expect(markup).not.toContain('did not answer in time')
    expect(markup.indexOf(DIRECT_OFFER_COPY.lan)).toBeLessThan(markup.indexOf(DIRECT_OFFER_COPY.retry))
  })
})

describe('the line under the badge', () => {
  // The sheet is two taps away and its headline was wrong; a phone whose
  // browser refuses the direct path by rule has exactly one way onto the
  // Wi-Fi, and that way should be on the bar, where the ask would be.
  const line = async (offer: DirectOffer | null): Promise<string> => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/direct-offer-gate')
    const { DirectOfferLine } = await import('../src/renderer/src/DirectOfferLine')
    gate.resetDirectOffer()
    gate.setDirectOffer(offer)
    return renderToStaticMarkup(<DirectOfferLine />)
  }

  it('hangs under the badge only for a refusal — a timeout may be a sleeping Mac', async () => {
    const refused = await line({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'blocked' })
    expect(refused).toContain('cr-path-ask')
    expect(refused).toContain('Safari refused')
    expect(refused).toContain(`>${DIRECT_OFFER_COPY.lan}</button>`)
    expect(refused).toContain(`>${DIRECT_OFFER_COPY.dismiss}</button>`)
    expect(await line({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })).toBe('')
    expect(await line({ origin: LAN, kind: 'lan', family: 'Chrome', reason: 'proxy' })).toBe('')
    expect(await line(null)).toBe('')
  })

  it('names the tailnet when that is the address on offer', async () => {
    const markup = await line({ origin: TAILNET, kind: 'tailnet', family: 'Safari', reason: 'blocked' })
    expect(markup).toContain(`>${DIRECT_OFFER_COPY.tailnet}</button>`)
  })

  it('never draws the address, the device id or a token', async () => {
    const markup = await line({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'blocked' })
    expect(markup).not.toContain(DEVICE)
    expect(markup).not.toContain('d.cookrew.dev')
    expect(markup).not.toContain('token')
  })

  it('goes away when dismissed, stays away while the same offer is re-published, and returns for a new one', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/direct-offer-gate')
    const { DirectOfferLine } = await import('../src/renderer/src/DirectOfferLine')
    gate.resetDirectOffer()
    const same: DirectOffer = { origin: LAN, kind: 'lan', family: 'Safari', reason: 'blocked' }
    gate.setDirectOffer(same)
    expect(renderToStaticMarkup(<DirectOfferLine />)).toContain(DIRECT_OFFER_COPY.lan)
    gate.hideDirectOfferLine()
    expect(renderToStaticMarkup(<DirectOfferLine />)).toBe('')
    // The 60-second race publishes the same answer again. Still dismissed.
    gate.setDirectOffer({ ...same })
    expect(renderToStaticMarkup(<DirectOfferLine />)).toBe('')
    // A different network, a different address: the line is news again.
    gate.setDirectOffer({ ...same, origin: TAILNET, kind: 'tailnet' })
    expect(renderToStaticMarkup(<DirectOfferLine />)).toContain(DIRECT_OFFER_COPY.tailnet)
    // The sheet's row is unaffected by the dismissal either way.
    const { DirectOfferRow } = await import('../src/renderer/src/DirectOfferRow')
    expect(renderToStaticMarkup(<DirectOfferRow />)).toContain(DIRECT_OFFER_COPY.tailnet)
  })
})

describe('the sheet', () => {
  it('puts the offer above the attempts, conclusion before evidence', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/direct-offer-gate')
    const attempts = await import('../src/renderer/src/path-attempts')
    const { PathSheet } = await import('../src/renderer/src/PathBadge')
    gate.resetDirectOffer()
    gate.setDirectOffer({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    attempts.resetPathAttempts()
    attempts.recordAttempts(
      [{ name: '192.168.2.40:8643', outcome: 'timeout', ms: 1585, plane: 'LAN', chosen: false }],
      'RELAY'
    )
    const markup = renderToStaticMarkup(
      <PathSheet
        view={{
          state: 'RELAY',
          word: 'RELAY',
          pulsing: false,
          sentence: 'Via the cookrew.dev relay.',
          desktopName: 'Mac',
          latencyMs: 120,
          switchDesktopUrl: null
        }}
        onClose={() => undefined}
      />
    )
    expect(markup).toContain(DIRECT_OFFER_COPY.lan)
    expect(markup.indexOf('did not answer in time')).toBeLessThan(markup.indexOf('Why this path'))
  })
})

describe('Chrome is untouched, and the two rows never argue', () => {
  it('still gets the explainer and ALLOW while the browser will prompt', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const offers = await import('../src/renderer/src/direct-offer-gate')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    const { DirectOfferRow } = await import('../src/renderer/src/DirectOfferRow')
    gate.resetLocalNetworkGate()
    offers.resetDirectOffer()
    gate.offerLocalNetwork(async () => undefined)
    gate.setLocalNetwork('prompt')
    // The decision refuses a browser that can be asked, so there is no offer
    // to publish here — and the ask is exactly what it was.
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toContain('>Allow</button>')
    expect(renderToStaticMarkup(<DirectOfferRow />)).toBe('')
  })

  it('still gets the refusal sentence after a denial', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const offers = await import('../src/renderer/src/direct-offer-gate')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    const { DirectOfferRow } = await import('../src/renderer/src/DirectOfferRow')
    gate.resetLocalNetworkGate()
    offers.resetDirectOffer()
    gate.offerLocalNetwork(async () => undefined)
    gate.setLocalNetwork('denied')
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toContain('Staying on the relay.')
    expect(renderToStaticMarkup(<DirectOfferRow />)).toBe('')
  })

  it('shows only the offer where there is no permission to talk about', async () => {
    // iOS Safari: 'unsupported' already renders no ask at all, so the sheet
    // never holds two contradictory suggestions at once.
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const offers = await import('../src/renderer/src/direct-offer-gate')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    const { DirectOfferRow } = await import('../src/renderer/src/DirectOfferRow')
    gate.resetLocalNetworkGate()
    offers.resetDirectOffer()
    gate.offerLocalNetwork(async () => undefined)
    gate.setLocalNetwork('unsupported')
    offers.setDirectOffer({ origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' })
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toBe('')
    expect(renderToStaticMarkup(<DirectOfferRow />)).toContain(DIRECT_OFFER_COPY.lan)
  })
})

describe('the tap', () => {
  it('navigates to the trusted name with this desktop’s token, and says where from', async () => {
    vi.resetModules()
    const { openDirectly } = await import('../src/renderer/src/DirectOfferRow')
    const went: string[] = []
    openDirectly({ origin: LAN }, { token: () => TOKEN, go: (url) => went.push(url) })
    expect(went).toEqual([`${LAN}/?token=${TOKEN}&from=relay`])
  })

  it('leaves the credential out of every log, and out of the attempt rows', async () => {
    vi.resetModules()
    const attempts = await import('../src/renderer/src/path-attempts')
    const { openDirectly } = await import('../src/renderer/src/DirectOfferRow')
    attempts.resetPathAttempts()
    attempts.recordAttempts(
      [{ name: '192.168.2.40:8643', outcome: 'timeout', ms: 1585, plane: 'LAN', chosen: false }],
      'RELAY'
    )
    const said: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void said.push(...args))
    )
    try {
      openDirectly({ origin: LAN }, { token: () => TOKEN, go: () => undefined })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(said).toEqual([])
    expect(JSON.stringify(attempts.pathAttempts())).not.toContain(TOKEN)
  })

  it('does nothing at all when the token has gone', async () => {
    vi.resetModules()
    const { openDirectly } = await import('../src/renderer/src/DirectOfferRow')
    const went: string[] = []
    openDirectly({ origin: LAN }, { token: () => null, go: (url) => went.push(url) })
    expect(went).toEqual([])
  })
})
