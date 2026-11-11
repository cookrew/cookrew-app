import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealFetchFor } from '../src/renderer/src/use/seal-fetch'
import { configureMachineScope, enterMachine, resetMachineScopeForTests } from '../src/renderer/src/machine-scope'

/**
 * THE SEALED SESSION'S REQUESTS (unlocking a Mac from afar). On a machine's
 * own page they are same-origin and carry nothing. On the console they cross
 * to the relay, which lets nothing through without the account session, so
 * they carry it in its header, and no cookie.
 */

const M = '11111111-1111-4111-8111-111111111111'
const BASE = `https://api.cookrew.dev/api/m/${M}`

afterEach(() => {
  resetMachineScopeForTests()
  vi.unstubAllGlobals()
})

describe('the sealed session’s fetch', () => {
  it('on the console: to the relay, with the account session and no cookie', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    enterMachine(M)
    const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', sent)
    await sealFetchFor(BASE)(`${BASE}/~seal/hello`, { method: 'POST', body: '{}' })
    const [url, init] = sent.mock.calls[0]
    // At the relay's one address, the machine and the route in headers (latency 0.6.1).
    expect(url).toBe('https://api.cookrew.dev/api/m')
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'x-cookrew-session': 'account-session', 'x-cookrew-machine': M, 'x-cookrew-route': '~seal/hello' }
    })
  })

  it('never sends the session anywhere but the relay’s machine prefix', async () => {
    configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session' } })
    enterMachine(M)
    const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', sent)
    await sealFetchFor(BASE)('https://api.cookrew.dev.evil.example/~seal/hello', { method: 'POST' })
    expect((sent.mock.calls[0][1]?.headers ?? {}) as Record<string, string>).not.toHaveProperty('x-cookrew-session')
  })

  it('on a machine’s own page: as it always was', async () => {
    const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', sent)
    await sealFetchFor('')('/~seal/hello', { method: 'POST', body: '{}' })
    expect(sent.mock.calls[0][1]).toEqual({ method: 'POST', body: '{}' })
  })
})
