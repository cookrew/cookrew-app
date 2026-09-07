// THE PLANE HAS TO KEEP TALKING THE WAY THE HELLO GOT THROUGH.
//
// Chrome 152 behind a system proxy, 2026-09-08: a request to the Mac's trusted
// name annotated `targetAddressSpace: 'local'` is refused in 32 ms before a
// socket exists, and the same request without the annotation is delivered. So
// the probe falls back (path-hello-hint.test.ts) — and if the SESSION then went
// on annotating its fetches, every one of them would fail exactly the way the
// probe did. A hello that succeeded and a plane that cannot carry a single
// request is the worst of the two outcomes: the badge would say LAN.
//
// So the variant that answered travels from the probe, through the race, into
// the plane, and out again on every request the plane composes.

import { describe, expect, it } from 'vitest'
import { RELAY_PLANE, planeRequestInit, type DataPlane } from '../src/renderer/src/data-plane'
import {
  switchPlaneIfBetter,
  type PlaneSwitchDeps
} from '../src/renderer/src/path/plane-switch'
import type { AddressSpaceHint } from '../src/renderer/src/local-network'
import type { ReachCardLite } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`

describe('the request options a plane composes', () => {
  it('drops the annotation on a plane whose hello only got through without it', () => {
    const plane: DataPlane = { origin: LAN, kind: 'lan', hint: 'none' }
    expect(planeRequestInit(plane)).toEqual({ mode: 'cors', credentials: 'omit' })
    expect(planeRequestInit(plane)).not.toHaveProperty('targetAddressSpace')
  })

  it('keeps it on a plane whose hello answered WITH it', () => {
    expect(planeRequestInit({ origin: LAN, kind: 'lan', hint: 'local' })).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('lets the address decide when nothing recorded a variant, exactly as before', () => {
    expect(planeRequestInit({ origin: LAN, kind: 'lan' })).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('never annotates the relay, whatever a hint says', () => {
    expect(planeRequestInit({ ...RELAY_PLANE, hint: 'local' })).toEqual({
      credentials: 'same-origin'
    })
  })
})

describe('what the race adopts', () => {
  const adoptAfter = async (hint: AddressSpaceHint | undefined): Promise<DataPlane | null> => {
    let adopted: DataPlane | null = null
    const deps: PlaneSwitchDeps = {
      plane: () => RELAY_PLANE,
      card: async (): Promise<ReachCardLite> => ({
        deviceId: DEVICE,
        lan: [],
        tailnet: null,
        trusted: [LAN]
      }),
      hello: async (origin, nonce) => ({
        ok: true,
        ...(hint ? { hint } : {}),
        reply: {
          v: 2,
          deviceId: DEVICE,
          nonce,
          sig: 'a-signature',
          origin,
          issuedAtMs: Date.now()
        }
      }),
      verify: async () => true,
      adopt: (plane) => void (adopted = plane),
      nonce: () => 'a-nonce'
    }
    await switchPlaneIfBetter(deps)
    return adopted
  }

  it('carries the variant that answered onto the plane', async () => {
    expect(await adoptAfter('none')).toEqual({ origin: LAN, kind: 'lan', hint: 'none' })
    expect(await adoptAfter('local')).toEqual({ origin: LAN, kind: 'lan', hint: 'local' })
  })

  it('adopts a plane with no hint at all when the probe recorded none', async () => {
    // An older call site, or a test double. The address decides, as it always
    // did, and nothing about the existing behaviour changes.
    expect(await adoptAfter(undefined)).toEqual({ origin: LAN, kind: 'lan' })
  })
})

describe('the store, which subscribers compare by identity', () => {
  it('announces a plane that changed only its variant', async () => {
    const { setDataPlane, subscribeDataPlane, resetDataPlane, dataPlane } = await import(
      '../src/renderer/src/data-plane'
    )
    resetDataPlane()
    const seen: DataPlane[] = []
    subscribeDataPlane((next) => void seen.push(next))
    setDataPlane({ origin: LAN, kind: 'lan', hint: 'local' })
    setDataPlane({ origin: LAN, kind: 'lan', hint: 'none' })
    // The same origin over a different variant is a different transport, and a
    // stream that did not restart would keep failing the way the probe did.
    expect(seen).toHaveLength(2)
    expect(dataPlane().hint).toBe('none')
    setDataPlane({ origin: LAN, kind: 'lan', hint: 'none' })
    expect(seen).toHaveLength(2)
    resetDataPlane()
  })
})
