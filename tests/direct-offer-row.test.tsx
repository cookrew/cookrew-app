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
  it('says why Safari cannot do this, in one sentence', async () => {
    const markup = await row({ origin: LAN, kind: 'lan' })
    expect(markup).toContain('Safari on iPhone cannot reach your Mac from this page')
    expect(markup).toContain('Apple never asks it for local-network permission')
    expect(markup).toContain('Open the Mac directly on Wi-Fi instead:')
    // Never the site-settings sentence: there is no such setting on iOS, and
    // sending somebody to look for one is the failure this replaces.
    expect(markup).not.toContain('site settings')
  })

  it('offers one button, worn as a button and named for the network', async () => {
    const lan = await row({ origin: LAN, kind: 'lan' })
    expect(lan).toContain(`>${DIRECT_OFFER_COPY.lan}</button>`)
    expect(lan).toContain('cr-btn')
    const tailnet = await row({ origin: TAILNET, kind: 'tailnet' })
    expect(tailnet).toContain(`>${DIRECT_OFFER_COPY.tailnet}</button>`)
  })

  it('never draws the address, the device id or a token', async () => {
    const markup = await row({ origin: LAN, kind: 'lan' })
    expect(markup).not.toContain(DEVICE)
    expect(markup).not.toContain('d.cookrew.dev')
    expect(markup).not.toContain('token')
  })

  it('is nothing at all when there is no offer', async () => {
    expect(await row(null)).toBe('')
  })
})

describe('the sheet', () => {
  it('puts the offer above the attempts, conclusion before evidence', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/direct-offer-gate')
    const attempts = await import('../src/renderer/src/path-attempts')
    const { PathSheet } = await import('../src/renderer/src/PathBadge')
    gate.resetDirectOffer()
    gate.setDirectOffer({ origin: LAN, kind: 'lan' })
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
    expect(markup.indexOf('Open the Mac directly')).toBeLessThan(markup.indexOf('Why this path'))
  })
})

describe('the tap', () => {
  it('navigates to the trusted name with this desktop’s token, and says where from', async () => {
    vi.resetModules()
    const { openDirectly } = await import('../src/renderer/src/DirectOfferRow')
    const went: string[] = []
    openDirectly({ origin: LAN, kind: 'lan' }, { token: () => TOKEN, go: (url) => went.push(url) })
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
      openDirectly({ origin: LAN, kind: 'lan' }, { token: () => TOKEN, go: () => undefined })
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
    openDirectly({ origin: LAN, kind: 'lan' }, { token: () => null, go: (url) => went.push(url) })
    expect(went).toEqual([])
  })
})
