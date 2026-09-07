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

import { describe, expect, it } from 'vitest'
import {
  directNavigationOffer,
  directNavigationUrl,
  type DirectOfferState
} from '../src/renderer/src/path/direct-offer'
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
    expect(directNavigationOffer(iphone())).toEqual({ origin: LAN, kind: 'lan' })
  })

  it('offers the tailnet when only the tailnet candidate stalled', () => {
    const offer = directNavigationOffer(
      iphone({
        attempts: [attempt({ name: '100.84.1.9:8643', plane: 'TAILNET', outcome: 'blocked' })]
      })
    )
    expect(offer).toEqual({ origin: TAILNET, kind: 'tailnet' })
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
    expect(offer).toEqual({ origin: LAN, kind: 'lan' })
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
    expect(offer).toEqual({ origin: LAN, kind: 'lan' })
  })

  it('is made for a macOS Safari too, which is harmless and the same fix', () => {
    expect(directNavigationOffer(iphone({ browser: 'Safari 18' }))).not.toBeNull()
  })
})

describe('when it is not', () => {
  it('never for Chrome, whose prompt is the real answer', () => {
    // Chrome 142 has the permission. Offering a navigation there would train
    // readers off the one control that actually fixes their session.
    expect(directNavigationOffer(iphone({ browser: 'Chrome 142' }))).toBeNull()
    expect(directNavigationOffer(iphone({ browser: 'Chrome 142', permission: 'prompt' }))).toBeNull()
    expect(directNavigationOffer(iphone({ browser: 'Chrome 142', permission: 'denied' }))).toBeNull()
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

describe('the URL the button navigates to', () => {
  it('carries the token for this desktop and says where it came from', () => {
    const url = directNavigationUrl({ origin: LAN, kind: 'lan' }, 'tok-en_123456789012345')
    expect(url).toBe(`${LAN}/?token=tok-en_123456789012345&from=relay`)
  })

  it('percent-encodes whatever the Mac minted', () => {
    expect(directNavigationUrl({ origin: LAN, kind: 'lan' }, 'a+b/c')).toContain('token=a%2Bb%2Fc')
  })

  it('is nothing at all without a token, so no bare address is ever opened', () => {
    expect(directNavigationUrl({ origin: LAN, kind: 'lan' }, null)).toBeNull()
    expect(directNavigationUrl({ origin: LAN, kind: 'lan' }, '')).toBeNull()
  })
})
