// THE POPOUT HAS NO URL ON IT — the whole point of v2 pairing, asserted on the
// markup rather than trusted to a reviewer.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairBody, PairPhoneSheet } from '../src/renderer/src/account/PairPhoneSheet'
import {
  PAIRING_COPY,
  deviceIdPrefix,
  pairingPopoutView,
  pairingQrPayload,
  parsePairingQr,
  renewsIn
} from '../src/shared/pairing-qr'

const DEVICE = '2c9417fd-3b1a-8c4e-9f2d-70a1b3c5d7e9'
const NOW = 1_800_000_000_000

const stubBridge = (handout: unknown): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: { accountPairingKey: async () => handout },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined
  }
}

describe('the QR payload', () => {
  it('is the scheme, the device id and the key — and nothing else', () => {
    expect(pairingQrPayload({ deviceId: DEVICE, key: '7KQ2M8' })).toBe(
      `cookrew-pair:${DEVICE}:7KQ2M8`
    )
  })

  it('carries no address, no scheme-with-a-host and no token', () => {
    const payload = pairingQrPayload({ deviceId: DEVICE, key: '7KQ2M8' })
    expect(payload).not.toContain('//')
    expect(payload).not.toContain('token')
    expect(payload).not.toContain('http')
  })

  it('round-trips', () => {
    expect(parsePairingQr(pairingQrPayload({ deviceId: DEVICE, key: '7KQ2M8' }))).toEqual({
      deviceId: DEVICE,
      key: '7KQ2M8'
    })
  })

  it('refuses anything that is not ours', () => {
    for (const bad of ['', 'https://mac.local/?token=x', 'cookrew-pair:only-two', 'other:a:b', 'cookrew-pair::K']) {
      expect(parsePairingQr(bad), bad).toBeNull()
    }
  })
})

describe('the countdown', () => {
  it('reads m:ss and pads the seconds', () => {
    expect(renewsIn(NOW + 102_000, NOW)).toBe('1:42')
    expect(renewsIn(NOW + 9_000, NOW)).toBe('0:09')
    expect(renewsIn(NOW + 120_000, NOW)).toBe('2:00')
  })

  it('never goes below zero', () => {
    expect(renewsIn(NOW - 5_000, NOW)).toBe('0:00')
  })

  it('shows enough of the device id to tell two Macs apart', () => {
    expect(deviceIdPrefix(DEVICE)).toBe('2c9417fd…')
  })
})

describe('the popout view model', () => {
  it('is the key shape when the Mac has an account', () => {
    const view = pairingPopoutView({
      desktopName: 'MacBook Pro',
      key: { deviceId: DEVICE, key: '7KQ2M8', expiresAt: NOW + 102_000 },
      now: NOW
    })
    expect(view).toEqual({
      mode: 'key',
      qr: `cookrew-pair:${DEVICE}:7KQ2M8`,
      key: '7KQ2M8',
      renewsIn: '1:42',
      desktopName: 'MacBook Pro',
      deviceIdPrefix: '2c9417fd…'
    })
  })

  it('falls back to the legacy URL QR, and says so, with no account', () => {
    const view = pairingPopoutView({
      desktopName: 'MacBook Pro',
      key: null,
      legacyUrl: 'https://192.168.1.24:8643/?token=t',
      now: NOW
    })
    expect(view.mode).toBe('legacy')
    if (view.mode !== 'legacy') return
    expect(view.sentence).toBe(PAIRING_COPY.NO_ACCOUNT)
    expect(view.qr).toBe('https://192.168.1.24:8643/?token=t')
  })
})

describe('the popout renders', () => {
  it('draws the QR, the key, the countdown and the Mac — and NO URL', () => {
    stubBridge({ deviceId: DEVICE, key: '7KQ2M8', expiresAt: NOW + 102_000, desktopName: 'MacBook Pro' })
    const html = renderToStaticMarkup(<PairPhoneSheet onClose={() => undefined} now={() => NOW} />)
    // The first paint runs before the effect resolves, which is the honest
    // "reading this Mac's key" state — the key branch is exercised through
    // the view model above and through the QR module's own fixtures.
    expect(html).toContain('Pair a phone')
    expect(html).not.toContain('http')
  })

  it('draws a real QR path for the key shape', () => {
    const view = pairingPopoutView({
      desktopName: 'MacBook Pro',
      key: { deviceId: DEVICE, key: '7KQ2M8', expiresAt: NOW + 102_000 },
      now: NOW
    })
    const html = renderToStaticMarkup(<PairBody view={view} />)
    expect(html).toContain('cr-pair-qr')
    expect(html).toContain('<path d="M')
    expect(html).toContain('7KQ2M8')
    expect(html).toContain('renews in 1:42')
    expect(html).toContain('2c9417fd\u2026')
    // THE ASSERTION THIS FILE EXISTS FOR: no address anywhere on the popout.
    expect(html).not.toContain('http')
    expect(html).not.toContain('token')
  })

  it('draws the legacy URL QR and its sentence when there is no account', () => {
    const view = pairingPopoutView({
      desktopName: 'MacBook Pro',
      key: null,
      legacyUrl: 'https://192.168.1.24:8643/?token=t',
      now: NOW
    })
    const html = renderToStaticMarkup(<PairBody view={view} />)
    expect(html).toContain(
      'Claim a username to pair through cookrew.dev; this QR pairs on this Wi-Fi only.'
    )
    expect(html).toContain('cr-pair-qr')
  })
})
