// EVERY REQUEST THAT LEAVES FOR THE HOUSE CARRIES THE ANNOTATION, AND NO
// REQUEST THAT STAYS ON THE RELAY DOES.
//
// Local Network Access is checked per connection — the specification says the
// check "MUST be performed for each new connection made", precisely because a
// name can be re-resolved to a different address between two requests. So the
// annotation cannot live at one call site or be set once at boot: it belongs
// to the seam that already answers "is this request direct or relayed", and
// that seam is `planeRequestInit`, plus `askHello`, which is the one direct
// request made BEFORE a plane exists.
//
// The other half matters just as much. Annotating a relay request would ask
// Chrome to treat cookrew.dev as the local network, which is both false and a
// permission prompt nobody can answer honestly.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELAY_PLANE, planeRequestInit, type DataPlane } from '../src/renderer/src/data-plane'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const LAN: DataPlane = { origin: `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`, kind: 'lan' }
const TAILNET: DataPlane = { origin: `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`, kind: 'tailnet' }
const TAILNET6: DataPlane = {
  origin: `https://fd7a-115c-a1e0-ab12--1.${DEVICE}.d.cookrew.dev:8643`,
  kind: 'tailnet'
}
const BARE_LAN: DataPlane = { origin: 'https://192.168.2.40:8643', kind: 'lan' }

const stubPhone = (): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('the plane’s own request options', () => {
  it('annotates a LAN plane', () => {
    expect(planeRequestInit(LAN)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('does NOT annotate a CGNAT tailnet address, which is not the local network', () => {
    // THE ANNOTATION IS AN ASSERTION, NOT A REQUEST. The spec fails a request
    // whose connection lands in a different address space from the one it
    // claimed — that IS the rebinding defence. Tailscale hands out 100.64/10,
    // which is not in any local range, so claiming 'local' for it would break
    // the tailnet plane outright on Chrome 142.
    expect(planeRequestInit(TAILNET)).toEqual({ mode: 'cors', credentials: 'omit' })
  })

  it('DOES annotate Tailscale’s ULA range, which is local by every definition', () => {
    // fd7a:115c:a1e0::/48 sits inside fc00::/7. The address decides, not the
    // word we happen to use for the network in the badge.
    expect(planeRequestInit(TAILNET6)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('annotates a bare private address, which is what the navigating switch races', () => {
    expect(planeRequestInit(BARE_LAN)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('leaves a relay request alone — cookrew.dev is not the local network', () => {
    expect(planeRequestInit(RELAY_PLANE)).toEqual({ credentials: 'same-origin' })
    expect(planeRequestInit(RELAY_PLANE)).not.toHaveProperty('targetAddressSpace')
  })
})

describe('the hello probe', () => {
  it('carries the annotation, because it is the FIRST request to the house', async () => {
    stubPhone()
    const inits: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
      inits.push(init)
      return new Response(JSON.stringify({ deviceId: DEVICE, nonce: 'n' }), { status: 200 })
    })
    const { askHello } = await import('../src/renderer/src/path/switch')
    await askHello(LAN.origin, 'n')
    expect(inits).toHaveLength(1)
    expect(inits[0].targetAddressSpace).toBe('local')
    expect(inits[0].credentials).toBe('omit')
  })
})

describe('the hello probe, on an address that is not local', () => {
  it('is not annotated, so a CGNAT tailnet name is still probed', async () => {
    stubPhone()
    const inits: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
      inits.push(init)
      return new Response(JSON.stringify({ deviceId: DEVICE, nonce: 'n' }), { status: 200 })
    })
    const { askHello } = await import('../src/renderer/src/path/switch')
    await askHello(TAILNET.origin, 'n')
    expect(inits[0]).not.toHaveProperty('targetAddressSpace')
  })
})

describe('verifying at the registry', () => {
  it('is NOT annotated — it is a request to our own origin, not to the house', async () => {
    stubPhone()
    const inits: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
      inits.push(init)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const { verifyHello } = await import('../src/renderer/src/path/companion')
    await verifyHello({ deviceId: DEVICE, nonce: 'n', sig: 's' }, 1000)
    expect(inits).toHaveLength(1)
    expect(inits[0]).not.toHaveProperty('targetAddressSpace')
  })
})
