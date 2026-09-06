// THE BADGE IS THE ONLY THING LEFT THAT CAN TELL THE TRUTH.
//
// Reach v2.1's promise is that the address bar stops moving: a phone opened
// from /me stays at cookrew.dev for the life of the session whether its
// requests are going over the relay, the Wi-Fi or the tailnet. That is the
// feature, and it costs the reader the one signal they used to have.
//
// So under a relay prefix the badge is fed from the DATA PLANE and not from
// the origin. Reading the hostname there would be wrong twice over — every
// trusted name the Mac holds ends in cookrew.dev, and a relay may be fronted
// by any host at all — and it would be wrong in the direction that matters:
// it would say LAN over a page whose every request goes through the relay.

import { afterEach, describe, expect, it, vi } from 'vitest'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const RELAY_BASE = `/relay/@owner/desktop/${DEVICE}`
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const TAILNET = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`

/** A phone as the renderer detects one; the origin never changes in any test. */
const stubPhone = (origin: string): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin, search: '', hash: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
}

const servedAt = async (
  base: string
): Promise<{
  link: typeof import('../src/renderer/src/path-link')
  plane: typeof import('../src/renderer/src/data-plane')
  streams: typeof import('../src/renderer/src/plane-streams')
}> => {
  Object.assign(globalThis, { COOKREW_BASE: base })
  vi.resetModules()
  return {
    link: await import('../src/renderer/src/path-link'),
    plane: await import('../src/renderer/src/data-plane'),
    streams: await import('../src/renderer/src/plane-streams')
  }
}

afterEach(() => {
  delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
  vi.resetModules()
})

describe('the badge under a relay prefix', () => {
  it('says RELAY until the plane moves — the shell arrived that way', async () => {
    stubPhone('https://cookrew.dev')
    const { link } = await servedAt(RELAY_BASE)
    expect(link.currentPathBadge().word).toBe('RELAY')
    expect(link.currentPathBadge().sentence).toContain('relay')
  })

  it('flips to LAN with the address bar unchanged, which is the whole feature', async () => {
    stubPhone('https://cookrew.dev')
    const { link, plane } = await servedAt(RELAY_BASE)
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(link.currentPathBadge().word).toBe('LAN')
    expect(link.currentPathBadge().sentence).toContain('Wi-Fi')
    // Nothing about the page moved. That is the point.
    expect(window.location.origin).toBe('https://cookrew.dev')
  })

  it('says TAILNET for a tailnet plane, not LAN', async () => {
    // The two are not the same path and never read as the same word: a tailnet
    // hop painted green would tell a reader their Mac is on this Wi-Fi.
    stubPhone('https://cookrew.dev')
    const { link, plane } = await servedAt(RELAY_BASE)
    plane.setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    expect(link.currentPathBadge().word).toBe('TAILNET')
  })

  it('says RELAY again the moment it falls back', async () => {
    stubPhone('https://cookrew.dev')
    const { link, plane } = await servedAt(RELAY_BASE)
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    plane.fallBackToRelay()
    expect(link.currentPathBadge().word).toBe('RELAY')
  })

  it('never reads the hostname — a trusted LAN name still ends in cookrew.dev', async () => {
    // Classifying by origin would call this page's transport the relay while
    // the plane was on the Wi-Fi, and the LAN while it was on the relay. The
    // origin is simply not the answer under a prefix.
    stubPhone(LAN)
    const { link, plane } = await servedAt(RELAY_BASE)
    expect(link.currentPathBadge().word).toBe('RELAY')
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(link.currentPathBadge().word).toBe('LAN')
  })

  it('lets a dead push channel outrank the plane', async () => {
    // OFFLINE is a fact about the transport and the plane is a fact about the
    // path. A page whose channel is down must not read as a working LAN.
    stubPhone('https://cookrew.dev')
    const { link, plane } = await servedAt(RELAY_BASE)
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    link.setPathLink('failed')
    expect(link.currentPathBadge().word).toBe('OFFLINE')
    link.resetPathLink()
  })

  it('gives the switcher the plane, so it only ever looks for something better', async () => {
    stubPhone('https://cookrew.dev')
    const { link, plane } = await servedAt(RELAY_BASE)
    expect(link.currentOriginState()).toBe('RELAY')
    plane.setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    expect(link.currentOriginState()).toBe('TAILNET')
  })
})

describe('the latency belongs to the path it was measured on', () => {
  it('is dropped when the plane moves, rather than smoothed across the switch', async () => {
    // 70% of the old reading is what keeps the number steady on one path, and
    // is exactly what would make a phone that has just landed on a 6 ms LAN
    // read 280, then 200, then 140 — a measurement of a path it has left.
    stubPhone('https://cookrew.dev')
    const { link } = await servedAt(RELAY_BASE)
    link.recordLatency(400)
    expect(link.pathLinkState().latencyMs).toBe(400)
    link.forgetLatency()
    expect(link.pathLinkState().latencyMs).toBe(null)
    link.recordLatency(6)
    expect(link.pathLinkState().latencyMs).toBe(6)
    link.resetPathLink()
  })
})

describe('at the root origin nothing changes', () => {
  it('a LAN-served companion still reads its own origin', async () => {
    stubPhone('https://192.168.2.40:8643')
    const { link } = await servedAt('')
    expect(link.currentOriginState()).toBe('LAN')
    expect(link.currentPathBadge().word).toBe('LAN')
  })
})

describe('the streams follow the plane', () => {
  it('restarts every registered connection on a switch, once', async () => {
    // A fetch composes its URL every time; a stream does not. Without this a
    // phone that switched onto the LAN would keep its canvas fed through
    // cookrew.dev — a switch that measurably did nothing.
    stubPhone('https://cookrew.dev')
    const { plane, streams } = await servedAt(RELAY_BASE)
    let restarts = 0
    const off = streams.followDataPlane()
    streams.registerPlaneStream({ restart: () => void (restarts += 1) })

    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(restarts).toBe(1)
    // Setting the same plane again is not a move, and a reconnect for it would
    // cost a full state re-send for nothing.
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(restarts).toBe(1)
    plane.fallBackToRelay()
    expect(restarts).toBe(2)

    off()
    plane.setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    expect(restarts).toBe(2)
  })

  it('lets one stubborn stream fail without stranding the others', async () => {
    stubPhone('https://cookrew.dev')
    const { plane, streams } = await servedAt(RELAY_BASE)
    let restarted = false
    streams.followDataPlane()
    streams.registerPlaneStream({
      restart: () => {
        throw new Error('this socket is already closing')
      }
    })
    streams.registerPlaneStream({ restart: () => void (restarted = true) })
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(restarted).toBe(true)
  })
})
