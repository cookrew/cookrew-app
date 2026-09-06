// A COMPANION LOADED UNDER cookrew.dev NEVER LEAVES cookrew.dev.
//
// THE FAILURE THIS PINS. Pressing OPEN on /me served the shell through the
// relay, and the shell's path switcher then did what it was built to do on a
// LAN-served page: it raced the Mac's direct addresses and called
// `location.replace('https://192.168.2.40:8643/?token=…')`. The owner's phone
// left cookrew.dev mid-session and landed on ERR_CERT_AUTHORITY_INVALID —
// a self-signed certificate for a bare IP, with a Proceed (unsafe) button and
// the pairing token sitting in the address bar of a page the browser had just
// told the reader not to trust.
//
// Reach v2.1 answers that by making the certificate the product's problem
// (real names, real chain — phases R1/R2) and by moving the switch from a
// NAVIGATION to a live data-plane move that never touches the address bar
// (phase C3). Until C3 exists, the only correct behaviour under a relay prefix
// is to do nothing at all — and "nothing at all" is exactly the kind of thing
// that gets re-enabled by accident, so it is asserted here rather than left as
// a comment in the switcher.
//
// The switcher's own rules (only better, never sideways; prove it is the Mac)
// are untouched and still covered by path-switch.test.ts — this is only about
// whether the browser wiring is allowed to fire.

import { afterEach, describe, expect, it, vi } from 'vitest'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const RELAY_BASE = `/relay/@owner/desktop/${DEVICE}`

interface Phone {
  readonly replaced: () => readonly string[]
  readonly listened: () => readonly string[]
  readonly fetched: () => number
}

/**
 * A phone, as the renderer detects one: no Electron bridge and the marker the
 * mobile server injects. `origin` is deliberately a LAN address in some tests
 * — a page served under a relay prefix must be judged by the prefix, not by
 * whatever host happens to be in front of the relay.
 */
const stubPhone = (origin: string): Phone => {
  const replaced: string[] = []
  const listened: string[] = []
  let fetched = 0
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin, search: '', hash: '', replace: (url: string) => replaced.push(url) },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    history: { replaceState: () => undefined },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    addEventListener: (event: string) => listened.push(event),
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<never> => {
    fetched += 1
    throw new Error('a companion under a relay prefix must not probe')
  }
  return { replaced: () => replaced, listened: () => listened, fetched: () => fetched }
}

/**
 * The globals api-base reads are read ONCE at module load — the same reason a
 * live client cannot be re-pointed at another desktop by mutating a global. So
 * a test that wants a differently-served client loads a different instance.
 */
const servedAt = async (base: string): Promise<{
  companion: typeof import('../src/renderer/src/path/companion')
  link: typeof import('../src/renderer/src/path-link')
}> => {
  Object.assign(globalThis, { COOKREW_BASE: base })
  vi.resetModules()
  return {
    companion: await import('../src/renderer/src/path/companion'),
    link: await import('../src/renderer/src/path-link')
  }
}

afterEach(() => {
  delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
  delete (globalThis as { fetch?: unknown }).fetch
  vi.resetModules()
})

describe('startCompanionPathSwitch under a relay prefix', () => {
  it('does nothing — no probe, no listener, no navigation', async () => {
    const phone = stubPhone('https://cookrew.dev')
    const { companion } = await servedAt(RELAY_BASE)
    const stop = companion.startCompanionPathSwitch()

    expect(phone.fetched()).toBe(0)
    expect(phone.listened()).toEqual([])
    expect(phone.replaced()).toEqual([])
    // Still a teardown, so the caller needs no branch of its own.
    expect(() => stop()).not.toThrow()
  })

  it('stays quiet even when the prefix sits in front of a LAN-looking host', async () => {
    // Whatever the address bar says, leaving this page means leaving the relay
    // prefix — and every /api call the bundle makes is scoped to that prefix.
    const phone = stubPhone('https://192.168.2.40:8643')
    const { companion } = await servedAt(RELAY_BASE)
    companion.startCompanionPathSwitch()
    expect(phone.fetched()).toBe(0)
    expect(phone.replaced()).toEqual([])
  })
})

describe('the path badge under a relay prefix', () => {
  it('reads RELAY, because that is what is carrying the data plane', async () => {
    stubPhone('https://cookrew.dev')
    const { link } = await servedAt(RELAY_BASE)
    expect(link.currentOriginState()).toBe('RELAY')
    expect(link.currentPathBadge().word).toBe('RELAY')
    expect(link.currentPathBadge().sentence).toContain('relay')
  })

  it('says RELAY even from a LAN-looking origin — the prefix is the truth', async () => {
    stubPhone('https://192.168.2.40:8643')
    const { link } = await servedAt(RELAY_BASE)
    expect(link.currentOriginState()).toBe('RELAY')
    expect(link.currentPathBadge().word).toBe('RELAY')
  })

  it('a dead push channel still outranks the prefix', async () => {
    // OFFLINE is a fact about the transport and RELAY is a fact about the
    // path. A page whose channel is down must not read as a working relay.
    stubPhone('https://cookrew.dev')
    const { link } = await servedAt(RELAY_BASE)
    link.setPathLink('failed')
    expect(link.currentPathBadge().word).toBe('OFFLINE')
    link.resetPathLink()
  })
})

describe('at the root origin nothing changes', () => {
  it('a LAN-served companion still reads LAN and still probes nothing better', async () => {
    stubPhone('https://192.168.2.40:8643')
    const { link, companion } = await servedAt('')
    expect(link.currentOriginState()).toBe('LAN')
    expect(link.currentPathBadge().word).toBe('LAN')
    // LAN is already the best path there is; the switcher has always no-opped
    // here, and that is the branch this must not have disturbed.
    expect(() => companion.startCompanionPathSwitch()()).not.toThrow()
  })
})
