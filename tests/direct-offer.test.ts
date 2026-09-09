// THE ONE NAVIGATION REACH v2.1 STILL ALLOWS, AND EXACTLY WHEN.
//
// Measured on the owner's iPhone on 2026-09-08 and confirmed by Apple's own
// forums: iOS Safari never asks for the Local Network permission and never
// appears under Settings → Privacy → Local Network at all. So a page served
// from https://cookrew.dev cannot fetch a LAN address, full stop — the Mac's
// /api/path/reports recorded `Safari 26 · permission unsupported ·
// 192.168.2.40 timeout 1585ms` for every probe. A TOP-LEVEL NAVIGATION to the
// same trusted name works, because a navigation is not a subresource fetch.
//
// That makes this the ONE case where leaving cookrew.dev is the right answer,
// and it is why this decision is a pure function with a table of cases rather
// than a condition inside a click handler: the rule that says "never navigate"
// is load-bearing (companion-relay-no-jump.test.ts) and its one exception has
// to be as narrow, as visible and as testable as the rule.
//
// IT IS THE PLATFORM, NOT THE BRAND. The first cut of this asked whether the
// browser was Safari, and the owner reproduced the identical failure the next
// day in Chrome 152 on the same iPhone — "Chrome 152 · local network
// permission not supported · 192.168.2.40 timed out 1557 ms". Of course:
// every browser on iOS and iPadOS is WebKit by App Store rule, so none of them
// has a local-network permission to ask for. The guard is therefore "this runs
// on iOS/iPadOS" OR "this is Safari", and desktop Chrome and Firefox stay out
// of it because they CAN be asked and their prompt is the real fix.

import { describe, expect, it } from 'vitest'
import {
  directNavigationOffer,
  directNavigationUrl,
  type DirectOfferState
} from '../src/renderer/src/path/direct-offer'
import { browserFamily, familyName, isAppleMobile } from '../src/renderer/src/browser-family'
import { directOfferWhy } from '../src/renderer/src/path-copy'
import type { PathAttempt } from '../src/renderer/src/path-attempts'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const LAN_2 = `https://192-168-2-41.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-84-1-9.${DEVICE}.d.cookrew.dev:8643`

const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
  name: '192.168.2.40:8643',
  outcome: 'timeout',
  ms: 1585,
  plane: 'LAN',
  chosen: false,
  ...over
})

/** A phone in the shape the fact describes: iOS Safari, relayed, stalled. */
const iphone = (over: Partial<DirectOfferState> = {}): DirectOfferState => ({
  base: `/relay/@owner/desktop/${DEVICE}`,
  plane: 'relay',
  browser: 'Safari 26',
  ios: true,
  permission: 'unsupported',
  attempts: [attempt()],
  candidates: [
    { origin: LAN, kind: 'lan' },
    { origin: TAILNET, kind: 'tailnet' }
  ],
  hasToken: true,
  ...over
})

describe('when the offer is made', () => {
  it('offers the LAN name a Safari could not fetch but can be sent to', () => {
    expect(directNavigationOffer(iphone())).toEqual({ origin: LAN, kind: 'lan', family: 'Safari' })
  })

  it('offers the tailnet when only the tailnet candidate stalled', () => {
    const offer = directNavigationOffer(
      iphone({
        attempts: [attempt({ name: '100.84.1.9:8643', plane: 'TAILNET', outcome: 'blocked' })]
      })
    )
    expect(offer).toEqual({ origin: TAILNET, kind: 'tailnet', family: 'Safari' })
  })

  it('prefers the LAN over the tailnet when both stalled', () => {
    const offer = directNavigationOffer(
      iphone({
        attempts: [
          attempt({ name: '100.84.1.9:8643', plane: 'TAILNET' }),
          attempt({ name: '192.168.2.40:8643', plane: 'LAN' })
        ]
      })
    )
    expect(offer).toEqual({ origin: LAN, kind: 'lan', family: 'Safari' })
  })

  it('offers the candidate that actually stalled, not merely the first one', () => {
    // Two LAN names, one of which was never even tried on this network. The
    // offer has to name the address the evidence is about, or the reader is
    // sent to a machine this phone has no reason to believe is reachable.
    const offer = directNavigationOffer(
      iphone({
        candidates: [
          { origin: LAN_2, kind: 'lan' },
          { origin: LAN, kind: 'lan' }
        ]
      })
    )
    expect(offer).toEqual({ origin: LAN, kind: 'lan', family: 'Safari' })
  })

  it('is made for a macOS Safari too, which is harmless and the same fix', () => {
    expect(directNavigationOffer(iphone({ browser: 'Safari 18', ios: false }))).not.toBeNull()
  })

  it('is made for CHROME ON THE SAME iPHONE, which is the whole correction', () => {
    // Reproduced 2026-09-08: Chrome 152 · local network permission not
    // supported · 192.168.2.40 timed out 1557 ms. Chrome on iOS is WebKit
    // wearing a Chrome badge, and it has no permission to ask for either.
    expect(directNavigationOffer(iphone({ browser: 'Chrome 152' }))).toEqual({
      origin: LAN,
      kind: 'lan',
      family: 'Chrome'
    })
  })

  it('is made for an iPad, and for every other WebKit-in-a-costume on it', () => {
    for (const browser of ['Safari 26', 'Chrome 152', 'Firefox 141', 'other']) {
      expect(directNavigationOffer(iphone({ browser })), browser).not.toBeNull()
    }
  })
})

describe('the desktop Chrome whose prompt cannot be raised at all', () => {
  // Chrome 152 behind a system proxy, on the owner's Mac, 2026-09-08: the
  // annotated probe fails in 32 ms, the unannotated retry fails too, the
  // permission stays 'prompt' and NO dialog is ever shown. A proxy hides the
  // resolved address, so Chrome calls the target public and Local Network
  // Access fails a request declaring 'local' before any prompt. That is a
  // desktop Chrome with, in practice, no permission to grant — and a top-level
  // navigation to the same trusted name still works.
  const proxied = (over: Partial<DirectOfferState> = {}): DirectOfferState =>
    iphone({
      browser: 'Chrome 152',
      ios: false,
      permission: 'prompt',
      attempts: [attempt({ outcome: 'blocked', ms: 32, hint: 'none' })],
      ...over
    })

  it('is offered when every candidate was refused with AND without the hint', () => {
    expect(directNavigationOffer(proxied())).toEqual({
      origin: LAN,
      kind: 'lan',
      family: 'Chrome',
      proxy: true
    })
  })

  it('blames the proxy, never iOS, in the sentence it carries', () => {
    const offer = directNavigationOffer(proxied())
    expect(offer?.proxy).toBe(true)
    const why = directOfferWhy(offer?.family ?? '', offer?.proxy)
    expect(why).toContain('system proxy')
    expect(why).not.toContain('iPhone')
    expect(why).not.toContain('iOS')
    expect(why).toContain('Open the Mac directly on Wi-Fi instead:')
  })

  it('is NOT offered when the refusal only happened with the hint', () => {
    // One variant refused is an ordinary refusal, and the prompt is the fix.
    expect(directNavigationOffer(proxied({ attempts: [attempt({ outcome: 'blocked' })] }))).toBeNull()
  })

  it('is NOT offered when one candidate merely timed out', () => {
    // A Mac that may be asleep is not a proxy, and sending a reader to an
    // address that did not answer is a page load for nothing.
    const mixed = [
      attempt({ outcome: 'blocked', hint: 'none' }),
      attempt({ name: '100.84.1.9:8643', plane: 'TAILNET', outcome: 'timeout' })
    ]
    expect(directNavigationOffer(proxied({ attempts: mixed }))).toBeNull()
  })

  it('is NOT offered once the permission has actually been decided', () => {
    for (const permission of ['granted', 'denied', 'unsupported'] as const) {
      expect(directNavigationOffer(proxied({ permission })), permission).toBeNull()
    }
  })
})

describe('when it is not', () => {
  it('never for a DESKTOP Chrome, whose prompt is the real answer', () => {
    // Chrome 142 on a Mac has the permission. Offering a navigation there
    // would train readers off the one control that actually fixes it.
    const desktop = { browser: 'Chrome 142', ios: false }
    expect(directNavigationOffer(iphone(desktop))).toBeNull()
    expect(directNavigationOffer(iphone({ ...desktop, permission: 'prompt' }))).toBeNull()
    expect(directNavigationOffer(iphone({ ...desktop, permission: 'denied' }))).toBeNull()
  })

  it('never for a desktop Firefox either, which reads as no family at all', () => {
    expect(directNavigationOffer(iphone({ browser: 'other', ios: false }))).toBeNull()
  })

  it('never when the permission exists — a browser that can ask should ask', () => {
    for (const permission of ['prompt', 'denied', 'granted'] as const) {
      expect(directNavigationOffer(iphone({ permission }))).toBeNull()
    }
  })

  it('never at the root origin, where the page IS the Mac', () => {
    expect(directNavigationOffer(iphone({ base: '' }))).toBeNull()
  })

  it('never once the plane is already direct', () => {
    expect(directNavigationOffer(iphone({ plane: 'lan' }))).toBeNull()
    expect(directNavigationOffer(iphone({ plane: 'tailnet' }))).toBeNull()
  })

  it('never without a stored token for THIS desktop', () => {
    // A navigation with no credential lands on the Not paired card at an
    // address the reader has never seen, which is worse than the relay.
    expect(directNavigationOffer(iphone({ hasToken: false }))).toBeNull()
  })

  it('never when something answered — the ordinary switch owns that case', () => {
    const answered = [attempt({ outcome: 'answered', ms: 6, chosen: true })]
    expect(directNavigationOffer(iphone({ attempts: answered }))).toBeNull()
  })

  it('never for a failure a navigation cannot fix', () => {
    // A name that refused, resolved to nothing or answered as somebody else
    // will do the same to a navigation, and the landing page is a browser
    // error rather than a companion.
    for (const outcome of ['network', 'http', 'unverified', 'refused'] as const) {
      expect(directNavigationOffer(iphone({ attempts: [attempt({ outcome })] }))).toBeNull()
    }
  })

  it('never with no race behind it', () => {
    expect(directNavigationOffer(iphone({ attempts: [] }))).toBeNull()
  })

  it('never when the stalled address is not one this desktop publishes', () => {
    // Rows outlive a network. A stale row about an address that is no longer
    // on the card must not send anybody anywhere.
    expect(directNavigationOffer(iphone({ candidates: [] }))).toBeNull()
  })
})

describe('which user agents are on the platform with no permission', () => {
  const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
  const IPHONE_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.6533.107 Mobile/15E148 Safari/604.1'
  const IPAD_SAFARI =
    'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
  const IPHONE_FIREFOX =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15'
  const MAC_CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0'

  it('says yes to every browser on an iPhone or an iPad', () => {
    for (const ua of [IPHONE_SAFARI, IPHONE_CHROME, IPAD_SAFARI, IPHONE_FIREFOX]) {
      expect(isAppleMobile(ua), ua.slice(0, 40)).toBe(true)
    }
  })

  it('says no to a desktop, where the permission is real', () => {
    for (const ua of [MAC_CHROME, WINDOWS_FIREFOX, '', null]) {
      expect(isAppleMobile(ua), String(ua).slice(0, 40)).toBe(false)
    }
  })

  it('names the family without its version, for the sentence', () => {
    expect(familyName(browserFamily(IPHONE_SAFARI))).toBe('Safari')
    expect(familyName(browserFamily(IPHONE_CHROME))).toBe('Chrome')
    expect(familyName(browserFamily(MAC_CHROME))).toBe('Chrome')
    // Nothing recognised still has to read as a sentence about a browser.
    expect(familyName('other')).toBe('This browser')
  })

  it('offers on a real iPhone Chrome UA, end to end through the family', () => {
    const offer = directNavigationOffer(
      iphone({ browser: browserFamily(IPHONE_CHROME), ios: isAppleMobile(IPHONE_CHROME) })
    )
    expect(offer).toEqual({ origin: LAN, kind: 'lan', family: 'Chrome' })
  })

  it('does not offer on a real macOS Chrome UA', () => {
    expect(
      directNavigationOffer(
        iphone({ browser: browserFamily(MAC_CHROME), ios: isAppleMobile(MAC_CHROME) })
      )
    ).toBeNull()
  })
})

describe('the sentence the offer carries', () => {
  it('blames Apple by name in Safari, which is where the fact was found', () => {
    expect(directOfferWhy('Safari')).toBe(
      'Safari on iPhone cannot reach your Mac from this page — Apple never asks it for local-network permission. Open the Mac directly on Wi-Fi instead:'
    )
  })

  it('blames iOS in any other browser, because the brand is not the cause', () => {
    expect(directOfferWhy('Chrome')).toBe(
      'Chrome on iPhone cannot reach your Mac from this page — iOS never asks a browser for local-network permission. Open the Mac directly on Wi-Fi instead:'
    )
    expect(directOfferWhy('Firefox')).toContain('Firefox on iPhone cannot reach your Mac')
    expect(directOfferWhy('Firefox')).toContain('iOS never asks a browser')
  })

  it('never sends anybody to site settings, which do not exist here', () => {
    for (const family of ['Safari', 'Chrome', 'This browser']) {
      expect(directOfferWhy(family)).not.toContain('site settings')
    }
  })
})

describe('the URL the button navigates to', () => {
  it('carries the token for this desktop and says where it came from', () => {
    const url = directNavigationUrl({ origin: LAN }, 'tok-en_123456789012345')
    expect(url).toBe(`${LAN}/?token=tok-en_123456789012345&from=relay`)
  })

  it('percent-encodes whatever the Mac minted', () => {
    expect(directNavigationUrl({ origin: LAN }, 'a+b/c')).toContain('token=a%2Bb%2Fc')
  })

  it('is nothing at all without a token, so no bare address is ever opened', () => {
    expect(directNavigationUrl({ origin: LAN }, null)).toBeNull()
    expect(directNavigationUrl({ origin: LAN }, '')).toBeNull()
  })
})
