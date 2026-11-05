// A CREDENTIAL ON THE RELAY RIDES A HEADER, NEVER THE URL.
//
// A URL through cookrew.dev reaches the ingress access log, so the pairing token
// must not be in one. The streams the companion opens on the relay go by fetch,
// which can set a header. The direct planes never touch the ingress and keep
// what they had, so these tests hold both sides of that line.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { bareWindow } from './support/memory-storage'

const BASE = '/relay/@u/desktop/d'
const TOKEN = 'pairing-token-abcdefghijklmnop'
const TAILNET = 'https://100-68-81-64.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643'

type Plane = typeof import('../src/renderer/src/rtc-plane')
type Data = typeof import('../src/renderer/src/data-plane')

let plane: Plane
let data: Data
let fetched: { url: string; init: RequestInit }[] = []
let natives: string[] = []

const sse = (...blocks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const block of blocks) controller.enqueue(new TextEncoder().encode(block))
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )

beforeEach(async () => {
  vi.resetModules()
  fetched = []
  natives = []
  vi.stubGlobal('COOKREW_BASE', BASE)
  vi.stubGlobal('window', bareWindow(`https://cookrew.dev${BASE}/`))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    fetched.push({ url: String(url), init })
    return sse('event: hb\ndata: {}\n\n', 'data: {"hello":1}\n\n')
  }))
  vi.stubGlobal('EventSource', class extends EventTarget {
    readyState = 0
    constructor(url: string) {
      super()
      natives.push(url)
    }
    close(): void {}
  })
  plane = await import('../src/renderer/src/rtc-plane')
  // The instance rtc-plane reads, after the reset above.
  data = await import('../src/renderer/src/data-plane')
  const { authStore } = await import('../src/renderer/src/auth-gate')
  authStore().save(TOKEN)
})

afterEach(() => {
  vi.unstubAllGlobals()
  data.resetDataPlane()
})

describe('on the relay', () => {
  it('sends the event stream with the token in a header, and nowhere in the URL', async () => {
    const source = plane.openEventSource(`${BASE}/api/events`)
    const heard = new Promise<string>((resolve) => {
      source.onmessage = (event) => resolve(String(event.data))
    })
    expect(await heard).toBe('{"hello":1}')
    source.close()
    expect(natives).toEqual([])
    expect(fetched).toHaveLength(1)
    expect(fetched[0].url).toBe(`${BASE}/api/events`)
    expect(new Headers(fetched[0].init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('bridges the browser card without the token in the socket path', async () => {
    const socket = plane.openWebSocket(`${BASE}/api/browser/b1/stream?w=390&h=844`)
    await vi.waitFor(() => expect(fetched.length).toBeGreaterThan(0))
    socket.close()
    expect(fetched[0].url).toContain('/api/socket-bridge?path=')
    expect(decodeURIComponent(fetched[0].url)).not.toContain('token')
    expect(fetched[0].url).not.toContain(TOKEN)
    expect(new Headers(fetched[0].init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('reports a refused stream as closed, so it reconnects like any other', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response('{}', { status: 401 }))
    const source = plane.openEventSource(`${BASE}/api/events`)
    await new Promise<void>((resolve) => source.addEventListener('error', () => resolve()))
    expect(source.readyState).toBe(2)
  })
})

describe('on a direct plane, which never meets the ingress', () => {
  it('keeps the native stream with the token it needs', () => {
    data.setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    plane.openEventSource(`${TAILNET}/api/events`).close()
    expect(fetched).toEqual([])
    expect(natives).toEqual([`${TAILNET}/api/events?token=${TOKEN}`])
  })
})

describe('the call sites', () => {
  it('leave the credential to the opener, so none of them can put it on the relay', () => {
    for (const file of ['remote-api.ts', 'stream/stream-http.ts', 'useBrowserStream.ts']) {
      const source = readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/tokenParam\(/)
    }
  })
})
