import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyHello } from '../src/renderer/src/path/verify-hello'
import { configureMachineScope, enterMachine, resetMachineScopeForTests } from '../src/renderer/src/machine-scope'

/**
 * "DID THAT REPLY COME FROM MY MACHINE?" is asked of the registry, which holds
 * the machine's public key. On a page a machine serves itself that is this
 * page's own origin, as it always was. On the console the registry is another
 * origin: its API host, with the console's session as a bearer and no cookie.
 * Until the registry says yes, a direct address is not trusted with anything.
 */

const M = '11111111-1111-4111-8111-111111111111'
const claim = { v: 2, deviceId: M, origin: `https://192-168-1-7.${M}.d.cookrew.dev:8643`, issuedAtMs: 1, nonce: 'n', sig: 's' } as never

afterEach(() => {
  resetMachineScopeForTests()
  vi.unstubAllGlobals()
})

describe('verifying a hello on the console', () => {
  it('asks the registry’s API host, with the session as a bearer and no cookie', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    enterMachine(M)
    const sent = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', sent)
    expect(await verifyHello(claim)).toBe(true)
    const [url, init] = sent.mock.calls[0]
    expect(url).toBe('https://api.cookrew.dev/v2/verify-hello')
    expect(init).toMatchObject({ method: 'POST', mode: 'cors', credentials: 'omit', headers: { authorization: 'Bearer account-session', 'content-type': 'application/json' } })
    // The account session goes to the registry and never in the relay's header here: this is not a call to a machine.
    expect(init?.headers).not.toHaveProperty('x-cookrew-session')
  })

  it('signed out, asks nobody and trusts nothing', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => null } })
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)
    expect(await verifyHello(claim)).toBe(false)
    expect(sent).not.toHaveBeenCalled()
  })

  it('anything but a clean yes is a no', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    for (const answer of [new Response(JSON.stringify({ ok: false })), new Response('{}', { status: 401 }), new Response('<html>'), new Response(JSON.stringify({ ok: 'true' }))]) {
      vi.stubGlobal('fetch', vi.fn(async () => answer))
      expect(await verifyHello(claim)).toBe(false)
    }
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    expect(await verifyHello(claim)).toBe(false)
  })
})

describe('verifying a hello on a page a machine serves itself', () => {
  it('asks this page’s own origin, as it always did', async () => {
    const sent = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', sent)
    expect(await verifyHello(claim)).toBe(true)
    const [url, init] = sent.mock.calls[0]
    expect(url).toBe('/v2/verify-hello')
    expect(init).toMatchObject({ credentials: 'same-origin' })
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
  })
})
