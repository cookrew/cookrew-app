// THE QUESTION THE PHONE ASKS WHEN A PROBE DIES WITHOUT A CAUSE.
import { describe, expect, it } from 'vitest'
import { nameLive, NAME_TIMEOUT_MS } from '../src/renderer/src/path/name-oracle'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`

const answering = (status: number, body: unknown) => {
  const urls: string[] = []
  const fetchLike = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    void init
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  return { fetchLike, urls }
}

describe('nameLive', () => {
  it('asks the page’s own origin about the HOST of the candidate, and reads live', async () => {
    const wire = answering(200, { live: true })
    expect(await nameLive(LAN, { fetch: wire.fetchLike })).toBe('live')
    // Same-origin relative path: the page is at the registry (or a self-host
    // of it), and that is the registry whose zone matters. Never the port.
    expect(wire.urls).toEqual([`/v2/names/192-168-1-24.${DEVICE}.d.cookrew.dev`])
  })

  it('reads dead', async () => {
    expect(await nameLive(LAN, { fetch: answering(200, { live: false }).fetchLike })).toBe('dead')
  })

  it('is unknown on anything that is not a clear answer', async () => {
    expect(await nameLive(LAN, { fetch: answering(404, { error: 'not_found' }).fetchLike })).toBe('unknown')
    expect(await nameLive(LAN, { fetch: answering(429, {}).fetchLike })).toBe('unknown')
    expect(await nameLive(LAN, { fetch: answering(200, { live: 'yes' }).fetchLike })).toBe('unknown')
    expect(await nameLive(LAN, { fetch: (() => Promise.reject(new TypeError('Load failed'))) as typeof fetch })).toBe('unknown')
    expect(await nameLive('not a url', { fetch: answering(200, { live: true }).fetchLike })).toBe('unknown')
  })

  it('gives up on a registry that does not answer, inside the deadline', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch
    const started = Date.now()
    expect(await nameLive(LAN, { fetch: hanging, timeoutMs: 30 })).toBe('unknown')
    expect(Date.now() - started).toBeLessThan(NAME_TIMEOUT_MS)
  })
})
