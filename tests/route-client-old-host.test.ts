// CLIENT FIRST (owner 2026-11-22): the new client must keep working against a
// host that has not been updated. The host here is FROZEN at dev 2656a6ec's
// route behaviour, written out rather than imported, so it stays an old host
// after the server half lands: it matches on the path, ignores `?route=2`, and
// answers the legacy, unversioned route shape. The client is the real
// remote-api module on a window shim, its requests carried over real HTTP.
import http from 'node:http'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeFixture } from '../src/shared/route-fixture'
import { routeSnapshot } from '../src/renderer/src/routing/route-state-order'
import type { RouteState } from '../src/shared/route'

const TOKEN = 'old-host-pairing'
const opened: string[] = []

function installWindow(): void {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: storage,
    sessionStorage: storage,
    location: { search: `?token=${TOKEN}`, href: 'https://phone.local/', origin: 'https://phone.local' },
    history: { replaceState: () => undefined }
  }
}

/** The stream the client opens: only its URL matters here. */
class RecordingEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  constructor(readonly url: string) {
    opened.push(url)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2
  }
}

/** dev 2656a6ec's three route endpoints, answered by path alone. */
async function frozenOldHost() {
  let state: RouteState = { ...routeFixture(), defaultModel: null }
  const seen: string[] = []
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '')
    const path = new URL(request.url ?? '/', 'http://old.host').pathname
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return void response.writeHead(401).end('{}')
    const send = (body: unknown): void => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (request.method === 'GET' && path === '/api/route') return send(state)
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string | null; on?: boolean }
      if (request.method === 'PUT' && path === '/api/route/default') return send((state = { ...state, defaultModel: body.model ?? null }))
      if (request.method === 'PUT' && path === '/api/route/shared-mcp') return send((state = { ...state, sharedMcp: body.on === true }))
      response.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

let host: Awaited<ReturnType<typeof frozenOldHost>>

beforeEach(async () => {
  vi.resetModules()
  opened.length = 0
  installWindow()
  host = await frozenOldHost()
  const real = globalThis.fetch
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => real(`http://127.0.0.1:${host.port}${String(input)}`, init))
  vi.stubGlobal('EventSource', RecordingEventSource)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).window
  await host.close()
})

describe('the new client against a host that predates route schema 2', () => {
  it('reads, sets the default and the shared-MCP switch, advertising route=2 on each', async () => {
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const api = createRemoteApi()

    const read = await api.routeState!()
    expect(read).not.toHaveProperty('schemaVersion')
    // The client's own gate accepts the legacy shape and shows it whole.
    expect(routeSnapshot(read)).toEqual({ state: read, incompatible: false })
    expect(read.models.length).toBeGreaterThan(0)

    const set = await api.routeSetDefault!('group/smart')
    expect(set.defaultModel).toBe('group/smart')
    expect(routeSnapshot(set).incompatible).toBe(false)

    const mcp = await api.routeSetSharedMcp!(false)
    expect(mcp.sharedMcp).toBe(false)

    const routeCalls = host.seen.filter((url) => url.startsWith('/api/route'))
    expect(routeCalls).toHaveLength(3)
    for (const url of routeCalls) expect(new URL(url, 'http://h').searchParams.get('route')).toBe('2')
  })

  it('opens the event stream with route=2 beside its boot nonce', async () => {
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const off = createRemoteApi().onRoute!(() => undefined)
    const stream = opened.find((url) => url.includes('/api/events'))
    expect(stream).toBeDefined()
    const query = new URL(stream!, 'http://h').searchParams
    expect(query.get('route')).toBe('2')
    expect(query.get('boot')).toBeTruthy()
    off()
  })
})
