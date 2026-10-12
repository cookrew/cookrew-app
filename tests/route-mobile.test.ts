// THE ROUTE OVER HTTP (route program, core lane): the four endpoints, the
// `route` field on /api/health, and the two stream frames — against a
// mobile API with a fake route service behind it, no gateway at all.

import { EventEmitter } from 'node:events'
import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { CardRouteState, RouteState } from '../src/shared/route'

const TOKEN = 'pair-token'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function routeState(status: RouteState['status']): RouteState {
  return {
    status,
    why: null,
    gateway: status === 'absent' ? null : { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', port: 3425, version: null, source: 'probe' },
    defaultModel: null,
    providers: 2,
    models: [],
    quotas: [],
    live: [],
    harnesses: [],
    checkedAt: 1,
    autoGroup: false,
    setup: { installLine: 'i', serveLine: 's', pluginLine: 'p', addSubscriptionLine: 'a', addKeyLine: 'k ', addLocalLine: 'l', addGroupLine: 'g' }
  }
}

function fakeRoute() {
  const bus = new EventEmitter()
  const cards = new Map<string, string>()
  let state = routeState('online')
  let holds = 0
  const card = (id: string): CardRouteState => ({ route: cards.get(id) ?? 'direct', effective: 'direct', appliesOn: 'restart', live: null, turn: null, offline: false, note: null, gateway: 'online', routable: true })
  const route: NonNullable<MobileApiDeps['route']> = {
    state: () => state,
    setDefault: (model) => {
      state = { ...state, defaultModel: model }
      return state
    },
    cardState: card,
    setCardRoute: async (id, r) => {
      if (id === 'ghost') return { error: 'unknown terminal' }
      cards.set(id, r)
      return card(id)
    },
    health: () => ({ status: state.status, source: 'probe', providers: 2, live: 1 }),
    hold: () => {
      holds += 1
      return () => {
        holds -= 1
      }
    }
  }
  return { route, bus, holds: () => holds, cards }
}

async function startApi(extra: Partial<MobileApiDeps>): Promise<number> {
  const deps = {
    pairingToken: TOKEN,
    turns: { list: () => [] },
    health: () => ({ now: 1, uptimeMs: 1, windowMs: 1, loop: {}, loops: {}, residency: {} }),
    ...extra
  } as unknown as MobileApiDeps
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    void handleMobileApi(request, response, url, deps).then((handled) => {
      if (!handled) response.writeHead(404).end()
    })
  })
  cleanup.push(() => server.close())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

const call = async (port: number, p: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })

describe('the route over HTTP', () => {
  it('GET /api/route, PUT the default, GET and PUT a card', async () => {
    const fake = fakeRoute()
    const port = await startApi({ route: fake.route, routeBus: fake.bus })
    const state = (await (await call(port, '/api/route')).json()) as RouteState
    expect(state.status).toBe('online')
    const set = await call(port, '/api/route/default', { method: 'PUT', body: JSON.stringify({ model: 'group/smart' }) })
    expect(set.status).toBe(200)
    expect(((await set.json()) as RouteState).defaultModel).toBe('group/smart')
    const bad = await call(port, '/api/route/default', { method: 'PUT', body: JSON.stringify({ model: 3 }) })
    expect(bad.status).toBe(400)
    const cleared = await call(port, '/api/route/default', { method: 'PUT', body: JSON.stringify({ model: null }) })
    expect(((await cleared.json()) as RouteState).defaultModel).toBeNull()

    const before = (await (await call(port, '/api/terminal/card-1/route')).json()) as CardRouteState
    expect(before.route).toBe('direct')
    const put = await call(port, '/api/terminal/card-1/route', { method: 'PUT', body: JSON.stringify({ route: 'deepseek/deepseek-chat' }) })
    expect(put.status).toBe(200)
    expect(((await put.json()) as CardRouteState).route).toBe('deepseek/deepseek-chat')
    expect((await call(port, '/api/terminal/card-1/route', { method: 'PUT', body: JSON.stringify({}) })).status).toBe(400)
    expect((await call(port, '/api/terminal/ghost/route', { method: 'PUT', body: JSON.stringify({ route: 'direct' }) })).status).toBe(404)
  })

  it('a PUT without the pairing token is refused; a server without the service answers 404', async () => {
    const fake = fakeRoute()
    const port = await startApi({ route: fake.route })
    const res = await fetch(`http://127.0.0.1:${port}/api/route/default`, { method: 'PUT', body: '{"model":null}' })
    expect(res.status).toBe(401)
    const bare = await startApi({})
    expect((await call(bare, '/api/route')).status).toBe(404)
  })

  it('the read-only wall token reads /api/route and never a key', async () => {
    const fake = fakeRoute()
    const port = await startApi({ route: fake.route, wallToken: 'wall-token' })
    const res = await fetch(`http://127.0.0.1:${port}/api/route`, { headers: { authorization: 'Bearer wall-token' } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"status":"online"')
    expect(text).not.toContain('magpie-')
    expect(text).not.toContain('"key"')
  })

  it('/api/health carries the route facts', async () => {
    const fake = fakeRoute()
    const port = await startApi({ route: fake.route })
    const health = (await (await call(port, '/api/health')).json()) as { route?: unknown }
    expect(health.route).toEqual({ status: 'online', source: 'probe', providers: 2, live: 1 })
    const bare = await startApi({})
    const none = (await (await call(bare, '/api/health')).json()) as { route?: unknown }
    expect(none.route).toBeUndefined()
  })

  it('the stream carries route and card-route frames and holds the gateway clock while open', async () => {
    const fake = fakeRoute()
    // A fake request and response, as the cable-signal stream test does: the
    // frames are read back synchronously and the close is ours to fire.
    const request = new EventEmitter() as unknown as http.IncomingMessage
    request.method = 'GET'
    request.headers = {}
    let written = ''
    const response = Object.assign(new EventEmitter(), {
      req: request,
      writableEnded: false,
      destroyed: false,
      writeHead() {
        return response
      },
      write(chunk: string) {
        written += chunk
        return true
      },
      end() {
        return response
      }
    }) as unknown as http.ServerResponse
    const store = Object.assign(new EventEmitter(), {
      focusedState: { name: 'ws', dir: '/tmp', nodes: [{ kind: 'terminal', id: 'card-1', name: 'One' }], connections: [] }
    })
    const deps = {
      store,
      turns: Object.assign(new EventEmitter(), { list: () => [] }),
      ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'ws' }) },
      route: fake.route,
      routeBus: fake.bus
    } as unknown as MobileApiDeps
    const handled = await handleMobileApi(request, response, new URL('/api/events', 'http://lan.local'), deps)
    expect(handled).toBe(true)
    expect(fake.holds()).toBe(1)
    fake.bus.emit('route', routeState('offline'))
    expect(written).toContain('event: route\ndata: {"status":"offline"')
    // An unchanged RouteState is a snapshot event: the repeat is not re-sent.
    const before = written.split('event: route').length
    fake.bus.emit('route', routeState('offline'))
    expect(written.split('event: route').length).toBe(before)
    fake.bus.emit('route', routeState('online'))
    expect(written.split('event: route').length).toBe(before + 1)
    fake.bus.emit('card-route', { terminalId: 'card-1', route: 'direct', effective: 'direct', appliesOn: 'now', live: null, turn: null, offline: false, note: null, gateway: 'online', routable: true })
    expect(written).toContain('event: card-route\ndata: {"terminalId":"card-1"')
    // Another canvas's card stays off this stream... this one is unscoped, so it passes.
    fake.bus.emit('card-route', { terminalId: 'elsewhere', route: 'direct' })
    expect(written).toContain('"terminalId":"elsewhere"')
    request.emit('close')
    response.emit('close')
    expect(fake.holds()).toBe(0)
  })
})
