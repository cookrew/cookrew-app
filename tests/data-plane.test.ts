// WHERE A REQUEST GOES, WHICH IS NO LONGER WHERE THE PAGE CAME FROM.
//
// One URL for the life of a session: the page stays where it is (the console,
// or a machine's own page) and the transport underneath moves. That promise
// lives or dies on one function — apiPath — and on the two shapes it has to
// produce:
//
//   relay   https://api.cookrew.dev/api/m/<id>/api/state   (the console)
//           /playground/api/state                           (a machine's own page)
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
import { inConsole, relayBaseFor } from './support/console-scope'

const DEVICE = '11111111-2222-3333-4444-555555555555'
/** The machine's address on the relay, as the console reaches it: another origin. */
const BASE = relayBaseFor(DEVICE)
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const LAN_PLANE: DataPlane = { origin: LAN, kind: 'lan' }

describe('the composition rule, on its own', () => {
  it('keeps the base on the relay and drops it on a direct origin', () => {
    expect(planePath(RELAY_PLANE, BASE, '', '/api/state')).toBe(`${BASE}/api/state`)
    // The machine answers at its own root. The relay's address of it is the relay's.
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
  it('is same-origin on a machine’s own page, where the page and the machine are one origin', () => {
    expect(planeRequestInit(RELAY_PLANE)).toEqual({ credentials: 'same-origin' })
    expect(planeRequestInit(RELAY_PLANE, '')).toEqual({ credentials: 'same-origin' })
  })

  it('sends no cookie to the relay from the console: it is another origin, and the session rides a header', () => {
    expect(planeRequestInit(RELAY_PLANE, BASE)).toEqual({ mode: 'cors', credentials: 'omit' })
  })

  it('sends NO cookies to the Mac, only the pairing token in a header', () => {
    // A direct plane is a different origin. The Mac authorises by the pairing
    // token and nothing else; a cookie travelling there would be the account
    // session leaving the account's origin for no reason at all.
    // The local-network annotation rides along on every direct request; it is
    // pinned on its own in plane-address-space.test.ts.
    expect(planeRequestInit(LAN_PLANE)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
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

describe('apiPath, live, on the console', () => {
  /** Each case loads its own module instance, with one machine in scope. */
  const consoleFor = async (): Promise<{
    api: typeof import('../src/renderer/src/api-base')
    plane: typeof import('../src/renderer/src/data-plane')
    scope: typeof import('../src/renderer/src/machine-scope')
  }> => {
    vi.resetModules()
    const scope = await inConsole(DEVICE)
    return {
      api: await import('../src/renderer/src/api-base'),
      plane: await import('../src/renderer/src/data-plane'),
      scope
    }
  }

  afterEach(() => {
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    vi.resetModules()
  })

  it('moves every request onto the Mac and back, with no reload in between', async () => {
    const { api, plane } = await consoleFor()
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)

    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(api.apiPath('/api/events')).toBe(`${LAN}/api/events`)
    expect(api.apiPath('/api/events')).not.toContain('/api/m/')
    expect(api.apiRequestInit()).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })

    // The fall back is the same seam, in reverse. Nothing was reloaded.
    plane.fallBackToRelay()
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)
    expect(api.apiRequestInit()).toEqual({ mode: 'cors', credentials: 'omit' })
  })

  it('starts the next machine on the relay: a direct origin was proved to be the last one', async () => {
    const { api, plane, scope } = await consoleFor()
    const OTHER = '99999999-2222-3333-4444-555555555555'
    const moves: string[] = []
    plane.subscribeDataPlane((next) => moves.push(next.kind))
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    scope.enterMachine(OTHER)
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    expect(api.apiPath('/api/events')).toBe(`${relayBaseFor(OTHER)}/api/events`)
    // Whoever follows the plane heard it move (their streams restart), and is still listening.
    expect(moves).toEqual(['lan', 'relay'])
    plane.setDataPlane({ origin: LAN, kind: 'lan' })
    expect(moves).toEqual(['lan', 'relay', 'lan'])
  })
})

describe('apiPath, live, on a machine’s own page under a workspace', () => {
  afterEach(() => {
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    vi.resetModules()
  })

  it('carries the workspace slug onto a direct origin', async () => {
    Object.assign(globalThis, { COOKREW_SLUG: 'playground' })
    vi.resetModules()
    const api = await import('../src/renderer/src/api-base')
    const plane = await import('../src/renderer/src/data-plane')
    expect(api.apiPath('/api/state')).toBe('/playground/api/state')
    plane.setDataPlane({ origin: LAN, kind: 'tailnet' })
    expect(api.apiPath('/api/state')).toBe(`${LAN}/playground/api/state`)
  })
})

describe('the browser socket follows the plane too', () => {
  // It was the one long-lived connection built from the page origin by hand,
  // which was harmless while the page origin WAS the transport.
  const ID = 'node-7'

  it('completes a path on the page’s own origin with that origin (a machine’s own page)', () => {
    const scoped = streamPath(ID, 800, 1400)
    expect(socketUrl('https://mac.example:8643', scoped)).toBe(
      `wss://mac.example:8643/api/browser/${ID}/stream?w=800&h=1400`
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
