import { describe, expect, it } from 'vitest'
import { createRegistryKeyCache } from '../src/main/registry-keys'

const HOUR = 60 * 60 * 1000

/** A fetch stub that counts calls and can be made to fail on demand. */
const stub = (answer: () => Response | Promise<Response>) => {
  const calls: string[] = []
  return {
    calls,
    fetch: async (input: string) => {
      calls.push(input)
      return answer()
    }
  }
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const KEYS = { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' }, revoked: ['j9'] }

describe('the registry key cache', () => {
  it('asks /v2/keys once and serves the answer from memory', async () => {
    const http = stub(() => ok(KEYS))
    const cache = createRegistryKeyCache({ origin: 'https://cookrew.dev', fetch: http.fetch })
    expect(await cache.keys()).toEqual(KEYS)
    expect(await cache.keys()).toEqual(KEYS)
    expect(http.calls).toEqual(['https://cookrew.dev/v2/keys'])
  })

  it('tolerates a trailing slash on the origin', async () => {
    const http = stub(() => ok(KEYS))
    const cache = createRegistryKeyCache({ origin: 'https://reg.test/', fetch: http.fetch })
    await cache.keys()
    expect(http.calls).toEqual(['https://reg.test/v2/keys'])
  })

  it('re-reads after an hour, and not before', async () => {
    let clock = 1000
    const http = stub(() => ok(KEYS))
    const cache = createRegistryKeyCache({
      origin: 'https://cookrew.dev',
      fetch: http.fetch,
      now: () => clock
    })
    await cache.keys()
    clock += HOUR - 1
    await cache.keys()
    expect(http.calls).toHaveLength(1)
    clock += 1
    await cache.keys()
    expect(http.calls).toHaveLength(2)
  })

  it('refreshes on demand, which is the one retry after a bad signature', async () => {
    const http = stub(() => ok(KEYS))
    const cache = createRegistryKeyCache({ origin: 'https://cookrew.dev', fetch: http.fetch })
    await cache.keys()
    await cache.refresh()
    expect(http.calls).toHaveLength(2)
  })

  it('KEEPS SERVING THE CACHED KEY when the registry is unreachable', async () => {
    // A phone on a LAN with no WAN must still be verifiable. Losing the key
    // because the WAN blinked would close the door the offline check exists
    // to keep open.
    let down = false
    const http = stub(() => {
      if (down) throw new Error('offline')
      return ok(KEYS)
    })
    const cache = createRegistryKeyCache({ origin: 'https://cookrew.dev', fetch: http.fetch })
    await cache.keys()
    down = true
    expect(await cache.refresh()).toEqual(KEYS)
  })

  it('answers null when it has never had a key and cannot get one', async () => {
    const http = stub(() => {
      throw new Error('offline')
    })
    const cache = createRegistryKeyCache({ origin: 'https://cookrew.dev', fetch: http.fetch })
    expect(await cache.keys()).toBeNull()
  })

  it('refuses a non-200 and a body that is not a key', async () => {
    for (const answer of [
      () => new Response('nope', { status: 503 }),
      () => ok({ nothing: true }),
      () => ok({ jwk: 'not an object' }),
      () => new Response('{', { status: 200 })
    ]) {
      const cache = createRegistryKeyCache({
        origin: 'https://cookrew.dev',
        fetch: stub(answer).fetch
      })
      expect(await cache.keys()).toBeNull()
    }
  })

  it('treats a missing revoked list as an empty one', async () => {
    const cache = createRegistryKeyCache({
      origin: 'https://cookrew.dev',
      fetch: stub(() => ok({ jwk: KEYS.jwk })).fetch
    })
    expect(await cache.keys()).toEqual({ jwk: KEYS.jwk, revoked: [] })
  })

  it('coalesces concurrent cold reads into one request', async () => {
    const http = stub(() => ok(KEYS))
    const cache = createRegistryKeyCache({ origin: 'https://cookrew.dev', fetch: http.fetch })
    await Promise.all([cache.keys(), cache.keys(), cache.keys()])
    expect(http.calls).toHaveLength(1)
  })
})
