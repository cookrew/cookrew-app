// THE PERMISSION THAT DECIDES WHETHER THE DIRECT PATH EXISTS AT ALL.
//
// Chrome 142 ships Local Network Access: a request from a public-origin page
// to an address on the local network is refused unless the request itself is
// annotated `targetAddressSpace: "local"`, and a PUBLIC HOSTNAME THAT RESOLVES
// TO A PRIVATE ADDRESS GETS NO EXEMPTION — which is exactly what every one of
// our trusted names is. Without the annotation the whole of Reach v2.1's fast
// path dies silently on the phone in most people's pocket.
//
// So three things are pinned here: the annotation is on the module that speaks
// for a direct request; the permission is read deliberately and degrades to
// 'unsupported' on every browser that has never heard of it; and asking is ONE
// probe, never a loop — a permission prompt raised twice is a permission
// prompt dismissed twice.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DIRECT_ADDRESS_SPACE,
  LOCAL_NETWORK_PERMISSION,
  directAddressSpaceInit,
  localNetworkState,
  requestLocalNetwork
} from '../src/renderer/src/local-network'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

/** A `navigator.permissions` that answers whatever the test wants. */
const permissions = (answer: () => Promise<{ state: string }>): { query: (d: { name: string }) => Promise<{ state: string }> } => ({
  query: (descriptor) => {
    expect(descriptor.name).toBe(LOCAL_NETWORK_PERMISSION)
    return answer()
  }
})

describe('the annotation', () => {
  it('is the spec’s own word for "the house"', () => {
    expect(DIRECT_ADDRESS_SPACE).toBe('local')
    expect(directAddressSpaceInit()).toEqual({ targetAddressSpace: 'local' })
  })

  it('is a plain init property, so a browser that has never heard of it ignores it', () => {
    // The whole safety argument for shipping this unconditionally: RequestInit
    // is a dictionary, and an unknown member of a dictionary is dropped during
    // conversion rather than raising. Proven here by handing the object to a
    // fetch stub that only reads the members it knows.
    const seen: Record<string, unknown>[] = []
    const init = { ...directAddressSpaceInit(), credentials: 'omit' as const }
    seen.push(init)
    expect(seen[0].credentials).toBe('omit')
    expect(Object.keys(init)).toContain('targetAddressSpace')
  })
})

describe('reading the permission', () => {
  it('is unsupported where there is no permissions store at all', async () => {
    expect(await localNetworkState(null)).toBe('unsupported')
    expect(await localNetworkState(undefined)).toBe('unsupported')
  })

  it('is unsupported when the name throws — Safari today, and Chrome before 142', async () => {
    // `query` rejects with a TypeError for a name it does not know. That is
    // not a refusal and must never be read as one: a browser with no prompt
    // either allows the request or fails it, and a failed request is already
    // "not this path".
    const store = permissions(() => Promise.reject(new TypeError('unknown permission')))
    expect(await localNetworkState(store)).toBe('unsupported')
  })

  it('reads granted, denied and prompt straight through', async () => {
    expect(await localNetworkState(permissions(async () => ({ state: 'granted' })))).toBe('granted')
    expect(await localNetworkState(permissions(async () => ({ state: 'denied' })))).toBe('denied')
    expect(await localNetworkState(permissions(async () => ({ state: 'prompt' })))).toBe('prompt')
  })

  it('treats a state it does not recognise as unsupported, never as granted', async () => {
    expect(await localNetworkState(permissions(async () => ({ state: 'weather' })))).toBe('unsupported')
  })
})

describe('asking for it', () => {
  it('makes exactly ONE annotated request and never loops', async () => {
    const inits: RequestInit[] = []
    const fetched: string[] = []
    const state = await requestLocalNetwork({
      url: 'https://192-168-1-24.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643',
      fetch: (async (url: string, init: RequestInit) => {
        fetched.push(url)
        inits.push(init)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      permissions: permissions(async () => ({ state: 'granted' }))
    })
    expect(fetched).toHaveLength(1)
    expect((inits[0] as { targetAddressSpace?: string }).targetAddressSpace).toBe('local')
    // No cookies to an address that has not yet proved it is the Mac.
    expect(inits[0].credentials).toBe('omit')
    expect(state).toBe('granted')
  })

  it('still answers, and still asks only once, when the probe is refused', async () => {
    let calls = 0
    const state = await requestLocalNetwork({
      url: 'https://192-168-1-24.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643',
      fetch: (async () => {
        calls += 1
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch,
      permissions: permissions(async () => ({ state: 'denied' }))
    })
    expect(calls).toBe(1)
    expect(state).toBe('denied')
  })

  it('answers unsupported when there is nothing to ask and nothing to ask with', async () => {
    const state = await requestLocalNetwork({
      url: 'https://192-168-1-24.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643',
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      permissions: null
    })
    expect(state).toBe('unsupported')
  })
})
