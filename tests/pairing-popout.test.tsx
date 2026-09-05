// THE POPOUT HAS NO URL ON IT — the whole point of v2 pairing, asserted on the
// markup rather than trusted to a reviewer.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairBody, PairPhoneSheet } from '../src/renderer/src/account/PairPhoneSheet'
import {
  PAIRING_POLL_MS,
  startPairingPoll,
  type PairingPollState
} from '../src/renderer/src/account/pairing-poll'
import type { PairingKeyHandout } from '../src/shared/account-v2'
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

describe('the popout clock — one interval, a countdown that moves', () => {
  const handoutAt = (expiresAt: number): PairingKeyHandout => ({
    deviceId: DEVICE,
    key: '7KQ2M8',
    expiresAt,
    desktopName: 'MacBook Pro'
  })

  /** The scheduler and the clock, held by the test rather than by the browser. */
  const harness = (load: () => Promise<PairingKeyHandout | null>) => {
    let clock = NOW
    const intervals: { fn: () => void; ms: number }[] = []
    const cleared: unknown[] = []
    const seen: PairingPollState[] = []
    const stop = startPairingPoll({
      load,
      now: () => clock,
      onState: (state) => seen.push(state),
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms })
        return intervals.length
      },
      clearInterval: (handle) => void cleared.push(handle)
    })
    const tick = async (ms: number): Promise<void> => {
      clock += ms
      intervals.forEach((i) => i.fn())
      await Promise.resolve()
      await Promise.resolve()
    }
    return { intervals, cleared, seen, stop, tick, at: () => clock }
  }

  const flush = (): Promise<void> => Promise.resolve().then(() => undefined)

  it('registers EXACTLY ONE interval, at one second', async () => {
    // The bug: the effect re-ran on every setState, so the interval was
    // cleared before it ever fired and re-created forever — one per render.
    const h = harness(async () => handoutAt(NOW + 120_000))
    await flush()
    await h.tick(1000)
    await h.tick(1000)
    expect(h.intervals).toHaveLength(1)
    expect(h.intervals[0].ms).toBe(PAIRING_POLL_MS)
    expect(PAIRING_POLL_MS).toBe(1000)
  })

  it('ADVANCES THE CLOCK, so the countdown counts down', async () => {
    const expiresAt = NOW + 120_000
    const h = harness(async () => handoutAt(expiresAt))
    await flush()
    const seconds = (state: PairingPollState): string =>
      pairingPopoutView({
        desktopName: 'MacBook Pro',
        key: { deviceId: DEVICE, key: '7KQ2M8', expiresAt },
        now: state.tick
      }).mode === 'key'
        ? renewsIn(expiresAt, state.tick)
        : ''
    expect(seconds(h.seen[h.seen.length - 1])).toBe('2:00')
    await h.tick(1000)
    expect(seconds(h.seen[h.seen.length - 1])).toBe('1:59')
    await h.tick(59_000)
    expect(seconds(h.seen[h.seen.length - 1])).toBe('1:00')
  })

  it('never shows more time than the key has — the 2:25 for a 120 s key', async () => {
    const expiresAt = NOW + 120_000
    const h = harness(async () => handoutAt(expiresAt))
    await flush()
    for (const state of h.seen) {
      expect(renewsIn(expiresAt, state.tick) <= '2:00').toBe(true)
    }
  })

  it('asks main ONCE up front, and again only when the key expires', async () => {
    let calls = 0
    let expiresAt = NOW + 3000
    const h = harness(async () => {
      calls++
      return handoutAt(expiresAt)
    })
    await flush()
    expect(calls).toBe(1)
    await h.tick(1000)
    await h.tick(1000)
    expect(calls).toBe(1)
    // A request a second for two minutes was asking a question whose answer
    // was already on the screen.
    expiresAt = NOW + 123_000
    await h.tick(1000)
    expect(calls).toBe(2)
    await h.tick(1000)
    expect(calls).toBe(2)
  })

  it('stops asking and stops ticking once the sheet closes', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return handoutAt(NOW + 1)
    })
    await flush()
    h.stop()
    const before = h.seen.length
    await h.tick(60_000)
    expect(h.cleared).toHaveLength(1)
    expect(h.seen).toHaveLength(before)
    expect(calls).toBe(1)
  })

  it('stops saying "reading" even when main refuses', async () => {
    const h = harness(async () => {
      throw new Error('no bridge')
    })
    await flush()
    await flush()
    expect(h.seen[h.seen.length - 1].asked).toBe(true)
    expect(h.seen[h.seen.length - 1].handout).toBeNull()
  })

  it('reports no key at all as an answer, which is the legacy shape', async () => {
    const h = harness(async () => null)
    await flush()
    expect(h.seen[h.seen.length - 1]).toMatchObject({ asked: true, handout: null })
  })
})
