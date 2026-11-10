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

  it('the registry saying no is a no', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    for (const body of [{ ok: false }, { ok: false, reason: 'bad_signature' }, { ok: 'true' }, {}]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
      expect(await verifyHello(claim), JSON.stringify(body)).toBe(false)
    }
  })

  it('NOT BEING ABLE TO ASK IS NOT A NO: it is thrown, so a path already proved is not thrown out with it', async () => {
    // The re-check gives a plane up when the registry stops vouching for it (path/plane-recheck.ts).
    // A session being renewed, a rate limit or a registry that is slow says nothing about the
    // machine: those must reach the re-check as "could not be asked", never as "no".
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    for (const answer of [new Response('{}', { status: 401 }), new Response('{}', { status: 429 }), new Response('{}', { status: 503 }), new Response('<html>')]) {
      vi.stubGlobal('fetch', vi.fn(async () => answer))
      await expect(verifyHello(claim)).rejects.toThrow()
    }
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    await expect(verifyHello(claim)).rejects.toThrow()
  })

  it('signed out, or with a session just ending, asks nobody: that too is "could not ask"', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => null } })
    const sent = vi.fn()
    vi.stubGlobal('fetch', sent)
    await expect(verifyHello(claim)).rejects.toThrow()
    expect(sent).not.toHaveBeenCalled()
  })

  it('a refused session tells the session’s keeper, so the next ask has one the registry takes', async () => {
    const refused = vi.fn()
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'ended', refused } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })))
    await expect(verifyHello(claim)).rejects.toThrow()
    expect(refused).toHaveBeenCalledTimes(1)
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
