// THE POPOUT SHOWS ONE URL AND NO SIX CHARACTERS — asserted on the markup
// rather than trusted to a reviewer.
//
// v2 drew a QR of `cookrew-pair:<id>:<KEY>` beside a key that rotated every
// two minutes, and the assertion this file existed for was "no address
// anywhere". v2.1 inverts exactly that: there is one credential, it lives in
// one URL, and the URL is the thing to scan. What survives unchanged is the
// suspicion — the sheet is checked for what it draws, not described.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { qrMatrix } from '../src/shared/qr'
import { PairBody, PairPhoneSheet } from '../src/renderer/src/account/PairPhoneSheet'
import type { PairingHandout } from '../src/shared/account-v2'
import { PAIRING_COPY, deviceIdPrefix, pairingPopoutView } from '../src/shared/pairing-qr'

const DEVICE = '2c9417fd-3b1a-8c4e-9f2d-70a1b3c5d7e9'
const RELAY_URL = `https://cookrew.dev/relay/@drej/desktop/${DEVICE}/#pair=a-pairing-token`

const RELAY: PairingHandout = {
  url: RELAY_URL,
  via: 'relay',
  desktopName: 'MacBook Pro',
  deviceId: DEVICE
}

const DIRECT: PairingHandout = {
  url: 'https://192.168.1.24:8643/?token=t',
  via: 'direct',
  desktopName: 'MacBook Pro'
}

const stubBridge = (handout: unknown): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: { accountPairingUrl: async () => handout },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined
  }
}

describe('the popout view model', () => {
  it('is the relay URL, verbatim, when this Mac has an account', () => {
    const view = pairingPopoutView(RELAY)
    expect(view.mode).toBe('relay')
    expect(view.qr).toBe(RELAY_URL)
    expect(view.sentence).toBe(PAIRING_COPY.RELAY)
    expect(view.deviceIdPrefix).toBe(deviceIdPrefix(DEVICE))
  })

  it('falls back to the direct URL, and says that is what it is', () => {
    const view = pairingPopoutView(DIRECT)
    expect(view.mode).toBe('direct')
    expect(view.qr).toBe('https://192.168.1.24:8643/?token=t')
    expect(view.sentence).toBe(PAIRING_COPY.DIRECT)
    // No account, so no device id to name.
    expect(view.deviceIdPrefix).toBeNull()
  })

  it('has nothing to draw when main hands over nothing', () => {
    const view = pairingPopoutView(null)
    expect(view.mode).toBe('none')
    expect(view.qr).toBeNull()
    expect(view.sentence).toBe(PAIRING_COPY.NONE)
  })

  it('carries the rotate note in every shape — one credential, one revocation', () => {
    for (const view of [pairingPopoutView(RELAY), pairingPopoutView(DIRECT), pairingPopoutView(null)]) {
      expect(view.rotateNote).toContain('--rotate')
      expect(view.rotateNote).toContain('unpairs every phone')
    }
  })

  it('shows enough of the device id to tell two Macs apart', () => {
    expect(deviceIdPrefix(DEVICE)).toBe('2c9417fd…')
  })
})

describe('the popout renders', () => {
  it('says it is reading before main has answered', () => {
    stubBridge(RELAY)
    const html = renderToStaticMarkup(<PairPhoneSheet onClose={() => undefined} />)
    // The first paint runs before the effect resolves, which is the honest
    // "reading" state — the drawn shapes are exercised through PairBody below.
    expect(html).toContain('Pair a phone')
    expect(html).toContain('Reading')
  })

  it('draws a real QR path of the RELAY URL, and names the Mac', () => {
    const html = renderToStaticMarkup(<PairBody view={pairingPopoutView(RELAY)} />)
    expect(html).toContain('cr-pair-qr')
    expect(html).toContain('<path d="M')
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('2c9417fd…')
    expect(html).toContain('--rotate')
  })

  it('SHOWS NO SIX-CHARACTER KEY AND NO COUNTDOWN — both are retired', () => {
    const html = renderToStaticMarkup(<PairBody view={pairingPopoutView(RELAY)} />)
    expect(html).not.toContain('renews in')
    expect(html).not.toContain('cookrew-pair:')
    expect(html).not.toContain('Six characters')
  })

  it('draws the direct URL QR and its sentence when there is no account', () => {
    const html = renderToStaticMarkup(<PairBody view={pairingPopoutView(DIRECT)} />)
    expect(html).toContain('Claim a username to pair from anywhere')
    expect(html).toContain('cr-pair-qr')
  })

  it('draws no QR at all when there is nothing to show', () => {
    const html = renderToStaticMarkup(<PairBody view={pairingPopoutView(null)} />)
    expect(html).not.toContain('cr-pair-qr')
    expect(html).toContain('No address to show yet')
  })
})

describe('the popout QR carries its quiet zone', () => {
  it('reserves four light modules on every side, inside the SVG', () => {
    // Not a CSS margin: the quiet zone is how a scanner FINDS the symbol, and
    // an 8 px cream border is under two modules at this size, in the wrong
    // colour, and gone the moment the box is restyled.
    const view = pairingPopoutView(RELAY)
    const html = renderToStaticMarkup(<PairBody view={view} />)
    const modules = (qrMatrix(view.qr as string) ?? []).length
    expect(html).toContain(`viewBox="0 0 ${modules + 8} ${modules + 8}"`)
    expect(html).toContain('translate(4 4)')
    expect(html).toContain('fill="#ffffff"')
  })
})
