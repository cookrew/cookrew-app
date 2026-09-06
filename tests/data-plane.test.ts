// WHERE A REQUEST GOES, WHICH IS NO LONGER WHERE THE PAGE CAME FROM.
//
// Reach v2.1 promises one URL for the life of a session: the phone stays at
// cookrew.dev/relay/@user/desktop/<id>/ and the transport underneath moves.
// That promise lives or dies on one function — apiPath — and on the two shapes
// it has to produce:
//
//   relay   /relay/@user/desktop/<id>/playground/api/state
//   direct  https://192-168-2-40.<id>.d.cookrew.dev:8643/playground/api/state
//
// The difference that matters is the BASE, and it is the one a reader would
// get wrong: the relay prefix belongs to cookrew.dev, and carrying it onto the
// Mac — which serves the app at its own root — is a 404 on every request with
// no way back. The slug is the opposite: it says which workspace this client
// is for, which is true on every path, and dropping it is the silent
// wrong-canvas answer api-base was written to end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELAY_PLANE,
  planePath,
  planeRequestInit,
  type DataPlane
} from '../src/renderer/src/data-plane'
import { socketUrl, streamPath } from '../src/renderer/src/browser-stream'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const BASE = `/relay/@owner/desktop/${DEVICE}`
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const LAN_PLANE: DataPlane = { origin: LAN, kind: 'lan' }

describe('the composition rule, on its own', () => {
  it('keeps the base on the relay and drops it on a direct origin', () => {
    expect(planePath(RELAY_PLANE, BASE, '', '/api/state')).toBe(`${BASE}/api/state`)
    // The Mac serves the app at its root. The relay's prefix is the relay's.
    expect(planePath(LAN_PLANE, BASE, '', '/api/state')).toBe(`${LAN}/api/state`)
  })

  it('keeps the slug on BOTH, because it answers the other question', () => {
    expect(planePath(RELAY_PLANE, BASE, 'playground', '/api/state')).toBe(
      `${BASE}/playground/api/state`
    )
    expect(planePath(LAN_PLANE, BASE, 'playground', '/api/state')).toBe(
      `${LAN}/playground/api/state`
    )
  })

  it('is the identity for a root-served client on the relay plane', () => {
    expect(planePath(RELAY_PLANE, '', '', '/api/state')).toBe('/api/state')
  })
})

describe('the credential mode', () => {
  it('sends the account session on the relay, which gates the prefix', () => {
    expect(planeRequestInit(RELAY_PLANE)).toEqual({ credentials: 'same-origin' })
  })

  it('sends NO cookies to the Mac, only the pairing token in a header', () => {
    // A direct plane is a different origin. The Mac authorises by the pairing
    // token and nothing else; a cookie travelling there would be the account
    // session leaving the account's origin for no reason at all.
    expect(planeRequestInit(LAN_PLANE)).toEqual({ mode: 'cors', credentials: 'omit' })
  })
})

describe('the store', () => {
  const fresh = async (): Promise<typeof import('../src/renderer/src/data-plane')> => {
    vi.resetModules()
    return import('../src/renderer/src/data-plane')
  }

  it('starts on the relay — the path the shell actually arrived over', async () => {
    const store = await fresh()
    expect(store.dataPlane()).toEqual({ origin: '', kind: 'relay' })
  })

  it('answers a NEW object, so a subscriber can compare by identity', async () => {
    const store = await fresh()
    const before = store.dataPlane()
    store.setDataPlane({ origin: LAN, kind: 'lan' })
    const after = store.dataPlane()
    expect(after).not.toBe(before)
    expect(before).toEqual({ origin: '', kind: 'relay' })
    expect(after).toEqual({ origin: LAN, kind: 'lan' })
  })

  it('tells its subscribers once per real move, and not at all for a no-op', async () => {
    const store = await fresh()
    const seen: string[] = []
    const off = store.subscribeDataPlane((plane) => seen.push(plane.kind))
    store.setDataPlane({ origin: LAN, kind: 'lan' })
    // Setting the same plane again is not a move; a reconnect for it would
    // cost a full state re-send for nothing.
    store.setDataPlane({ origin: `${LAN}/`, kind: 'lan' })
    store.fallBackToRelay()
    off()
    store.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(seen).toEqual(['lan', 'relay'])
  })

  it('normalises the relay to an empty origin, whatever it is handed', async () => {
    const store = await fresh()
    store.setDataPlane({ origin: 'https://cookrew.dev', kind: 'relay' })
    expect(store.dataPlane().origin).toBe('')
  })
})

describe('apiPath, live, under a relay base', () => {
  /** The globals api-base reads are read ONCE at module load, deliberately. */
  const clientServedAt = async (
    injected: Record<string, unknown>
  ): Promise<{
    api: typeof import('../src/renderer/src/api-base')
    plane: typeof import('../src/renderer/src/data-plane')
  }> => {
    Object.assign(globalThis, injected)
    vi.resetModules()
    return {
      api: await import('../src/renderer/src/api-base'),
      plane: await import('../src/renderer/src/data-plane')
    }
  }

  afterEach(() => {
    delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    vi.resetModules()
  })

  it('moves every request onto the Mac and back, with no reload in between', async () => {
    const { api, plane } = await clientServedAt({ COOKREW_BASE: BASE, COOKREW_SLUG: '' })
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)

    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(api.apiPath('/api/events')).toBe(`${LAN}/api/events`)
    expect(api.apiPath('/api/events')).not.toContain('/relay/')
    expect(api.apiRequestInit()).toEqual({ mode: 'cors', credentials: 'omit' })

    // The fall back is the same seam, in reverse. Nothing was reloaded.
    plane.fallBackToRelay()
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)
    expect(api.apiRequestInit()).toEqual({ credentials: 'same-origin' })
  })

  it('carries the workspace slug onto the direct origin', async () => {
    const { api, plane } = await clientServedAt({
      COOKREW_BASE: BASE,
      COOKREW_SLUG: 'playground'
    })
    plane.setDataPlane({ origin: LAN, kind: 'tailnet' })
    expect(api.apiPath('/api/state')).toBe(`${LAN}/playground/api/state`)
    // API_BASE is still the RELAY's prefix — a constant about the page, not
    // about the transport, and nothing may quietly re-point it.
    expect(api.API_BASE).toBe(`${BASE}/playground`)
  })
})

describe('the browser socket follows the plane too', () => {
  // It was the one long-lived connection built from the page origin by hand,
  // which was harmless while the page origin WAS the transport.
  const ID = 'node-7'

  it('completes a relay-scoped path with the page origin', () => {
    const scoped = `${BASE}${streamPath(ID, 800, 1400)}`
    expect(socketUrl('https://cookrew.dev', scoped)).toBe(
      `wss://cookrew.dev${BASE}/api/browser/${ID}/stream?w=800&h=1400`
    )
  })

  it('upgrades a direct origin rather than borrowing the page origin', () => {
    const scoped = `${LAN}${streamPath(ID, 800, 1400)}`
    expect(socketUrl('https://cookrew.dev', scoped)).toBe(
      `wss://192-168-2-40.${DEVICE}.d.cookrew.dev:8643/api/browser/${ID}/stream?w=800&h=1400`
    )
    // The socket must go to the Mac, not to whatever served the page.
    expect(socketUrl('https://cookrew.dev', scoped)).not.toContain('cookrew.dev/api')
  })

  it('stays on ws for a plain-http origin', () => {
    expect(socketUrl('http://localhost:8639', streamPath(ID, 320, 320))).toBe(
      `ws://localhost:8639/api/browser/${ID}/stream?w=320&h=320`
    )
  })
})
