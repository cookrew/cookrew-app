import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handle, rotateActivePairingToken, type MobileServerDeps } from '../src/main/mobile-server'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { rotatePairingToken } from '../src/main/pairing-token'
import { SEALED_V2_HEADER, sealProofHeaders } from '../src/main/seal-proof'
import { SEALED_MARKER } from '../src/shared/remote-unlock'
import { ROUTE_HTTP_SCHEMA_VERSION } from '../src/shared/route'
import { routeFixture } from '../src/shared/route-fixture'
import { toCatalog } from '../src/main/route/catalog'
import { toDecision } from '../src/main/route/decisions'
import { configuredEndpointInventory, retainEndpointInventory } from '../src/main/route/remote-ports'
import capturedModels from './fixtures/magpie/models.json'
import capturedDecision from './fixtures/magpie/route-with-rule.json'

vi.mock('../src/main/pairing-token', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/pairing-token')>(),
  rotatePairingToken: vi.fn()
}))

const OWNER = 'fixture-owner-pairing'
const NEXT_OWNER = 'fixture-rotated-owner-pairing'
const ADMITTED = 'fixture-admitted-companion'
const WALL = 'fixture-wall-reader'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const v2 = { ...sealProofHeaders(), [SEALED_V2_HEADER]: '1' }
const gatewayUrl = 'http://192.0.2.41:54321'
const remoteHost = '[2001:db8::41]:54323'
const tunnelPort = 54322
const pluginPath = '/fixture/private-magpie-plugin'
const refused = 'refused gateway at https://rejected.example:54324'
const hidden = [gatewayUrl, '192.0.2.41', '54321', '2001:db8::41', '54323', '54322', pluginPath,
  'rejected.example', '54324', 'future.example', 'raw quota failure', 'raw decision failure', 'raw writer failure', 'raw estimate failure']
const diagnostic = { endpoint: 'https://future.example' }
const wire = <T extends object>(state: T) => ({ ...state, schemaVersion: ROUTE_HTTP_SCHEMA_VERSION })

function fixtureState() {
  const base = routeFixture()
  const models = toCatalog(capturedModels)
  const decision = toDecision('forge', capturedDecision, base.checkedAt)!
  const quota = base.quotas[1]
  return {
    ...base,
    why: refused,
    gateway: { url: gatewayUrl, v1: `${gatewayUrl}/v1`, port: 54321, source: 'plugin' as const, version: '0.1.4000' },
    plainRemotes: [{ id: 'remote', host: remoteHost }],
    loopbackRemotes: [{ id: 'tunnel', port: tunnelPort }],
    models: [{ ...models[0], future: diagnostic }, ...models.slice(1),
      { ...models[2], id: 'local/edge:2b', displayName: 'Edge model at 192.0.2.41.', ownedBy: 'local' }],
    quotas: [quota, { ...base.quotas[0], error: `raw quota failure at ${remoteHost}` }, {
      ...quota, provider: 'synthetic', alias: `Quota from ${remoteHost}`, future: diagnostic,
      resetCredits: { count: 3, firstExpiresAt: base.checkedAt, future: diagnostic },
      windows: [{ ...quota.windows[0], future: diagnostic, estimateWhy: `raw estimate failure at ${gatewayUrl}` }]
    }],
    live: [{ ...decision, future: diagnostic, rule: { ...decision.rule!, future: diagnostic } }, {
      ...decision, seq: decision.seq + 1, session: `gateway session from ${gatewayUrl}`, status: `raw decision failure on port ${tunnelPort}`
    }],
    setup: { ...base.setup, pluginLine: `magpie plugin add '${pluginPath}'`, future: diagnostic },
    future: diagnostic
  }
}

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

async function start(
  failWrites = false,
  initial?: Partial<ReturnType<typeof fixtureState>>,
  direct = false,
  tokenNow?: () => string | null,
  endpointInventory: () => string[] | null = () => []
) {
  const routeBus = new EventEmitter()
  const retainedInventory = retainEndpointInventory(endpointInventory)
  const workspace = { name: 'Fixture', dir: '/fixture', nodes: [], connections: [] }
  const store = Object.assign(new EventEmitter(), { focusedId: 'fixture', focusedState: workspace, workspaceState: () => workspace })
  const turns = Object.assign(new EventEmitter(), { list: () => [] })
  let state = { ...fixtureState(), ...initial }
  let admitted = true
  const writes: unknown[] = []
  const writer = (patch: Partial<typeof state>) => {
    writes.push(patch)
    if (failWrites) throw new Error(`raw writer failure at ${gatewayUrl}`)
    state = { ...state, ...patch }
    return state
  }
  const deps = {
    multiInstance: () => false, perDeviceOnly: () => false, pairingToken: OWNER, wallToken: WALL,
    store, turns, ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'fixture' }) }, routeBus,
    identity: { admitted: { deviceFor: (token: string) => admitted && token === ADMITTED ? 'fixture-device' : null } },
    ...(tokenNow ? { pairingTokenNow: tokenNow } : {}),
    route: { state: () => state, endpointInventory: retainedInventory, hold: () => () => undefined,
      setDefault: (defaultModel: string | null) => writer({ defaultModel }), setSharedMcp: (sharedMcp: boolean) => writer({ sharedMcp }) }
  } as unknown as MobileServerDeps
  const fail = (res: http.ServerResponse) => (error: Error) => {
    if (res.headersSent) return res.destroy(error)
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  }
  const server = http.createServer((req, res) => {
    if (direct) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      void handleMobileApi(req, res, url, deps as unknown as MobileApiDeps)
        .then((served) => { if (!served) res.writeHead(404).end() })
        .catch(fail(res))
      return
    }
    void handle(req, res, deps).catch(fail(res))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin, server, routeBus, state: () => state, writes, revoke: () => { admitted = false },
    // THIS CLIENT KNOWS THE SCHEMA: it names it in the URL, the way the
    // shipped renderer does. The old-client cases below build their own URLs.
    request: (path: string, headers: Record<string, string>, body?: Record<string, unknown> | string) => fetch(`${origin}${path.startsWith('/api/route') ? `${path}${path.includes('?') ? '&' : '?'}route=${ROUTE_HTTP_SCHEMA_VERSION}` : path}`, {
      method: body === undefined ? 'GET' : 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(3000)
    })
  }
}

function restricted(raw: string) {
  for (const value of hidden) expect(raw).not.toContain(value)
  const view = JSON.parse(raw)
  expect(view.schemaVersion).toBe(ROUTE_HTTP_SCHEMA_VERSION)
  expect(view).not.toHaveProperty('future')
  expect(view).not.toHaveProperty('plainRemotes')
  expect(view).not.toHaveProperty('loopbackRemotes')
  expect(view).toMatchObject({
    status: 'online', gateway: null, gatewaySource: 'plugin', providers: 3, mcpServers: [],
    models: [], quotas: [], live: [], defaultModel: null,
    withheld: { providerData: true, mcpServers: true, addGroupLine: true },
    remoteRisks: { plain: expect.stringContaining('unencrypted'), loopback: expect.stringContaining('loopback') },
    harnesses: expect.arrayContaining([expect.objectContaining({ id: 'opencode', installed: false, loginLine: 'opencode auth login' })]),
    setup: { installLine: expect.stringContaining('usemagpie.ai/install.sh'), serveLine: 'magpie autostart on',
      pluginLine: '', addSubscriptionLine: 'magpie accounts add codex', addLocalLine: 'magpie provider add ollama', addGroupLine: null }
  })
  expect(view.setup).not.toHaveProperty('future')
  return view
}

async function openStream(origin: string, headers: Record<string, string>) {
  const res = await fetch(`${origin}/api/events?route=${ROUTE_HTTP_SCHEMA_VERSION}`, { headers, signal: AbortSignal.timeout(4000) })
  expect(res.status).toBe(200)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  return async (event: string): Promise<string> => {
    for (;;) {
      const end = pending.indexOf('\n\n')
      if (end < 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error(`Missing ${event} frame`)
        pending += value
        continue
      }
      const frame = pending.slice(0, end)
      pending = pending.slice(end + 2)
      const prefix = `event: ${event}\ndata: `
      if (frame.startsWith(prefix)) return frame.slice(prefix.length)
    }
  }
}

describe('route diagnostics over the real mobile request handler', () => {
  it.each([
    ['plain owner', bearer(OWNER)],
    ['owner with a forged v2 proof', { ...bearer(OWNER), [SEALED_MARKER]: 'fixture-client-proof', [SEALED_V2_HEADER]: '1' }],
    ['v1 owner', { ...bearer(OWNER), ...sealProofHeaders() }],
    ['wall with server proof', { ...bearer(WALL), ...v2 }]
  ] as const)('keeps the route functional and omits diagnostics for %s', async (_label, headers) => {
    const api = await start()
    const res = await api.request('/api/route', headers)
    expect(res.status).toBe(200)
    expect(restricted(await res.text()).withheld.defaultModel).toBe(true)
  })

  it('refuses the route to a client that does not name the schema, leaking no state', async () => {
    const api = await start()
    for (const headers of [{ ...bearer(OWNER), ...v2 }, bearer(WALL), { ...bearer(ADMITTED), ...v2 }]) {
      const read = await fetch(`${api.origin}/api/route`, { headers, signal: AbortSignal.timeout(3000) })
      expect(read.status).toBe(426)
      const text = await read.text()
      expect(text).toContain('Update Cookrew')
      for (const value of hidden) expect(text).not.toContain(value)
      expect(text).not.toContain('schemaVersion')
    }
    const stale = await fetch(`${api.origin}/api/route?route=1`, { headers: { ...bearer(OWNER), ...v2 }, signal: AbortSignal.timeout(3000) })
    expect(stale.status).toBe(426)
  })

  it('sends no route frame to a stream that does not name the schema', async () => {
    const api = await start()
    const res = await fetch(`${api.origin}/api/events`, { headers: { ...bearer(OWNER), ...v2 }, signal: AbortSignal.timeout(4000) })
    expect(res.status).toBe(200)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    const take = async (ms: number): Promise<void> => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))])
        if (next === null) continue
        if (next.done) return
        text += next.value
      }
    }
    await take(200)
    api.routeBus.emit('route', api.state())
    await take(500)
    expect(text).not.toContain('event: route')
    await reader.cancel().catch(() => undefined)
  })

  it('stamps owner and restricted responses with the same schema version', async () => {
    const api = await start()
    const owner = await (await api.request('/api/route', { ...bearer(OWNER), ...v2 })).json()
    const wall = await (await api.request('/api/route', bearer(WALL))).json()
    expect(owner.schemaVersion).toBe(ROUTE_HTTP_SCHEMA_VERSION)
    expect(wall.schemaVersion).toBe(ROUTE_HTTP_SCHEMA_VERSION)
  })

  it.each(['plain', 'loopback', null] as const)('shows only the applicable remote risks (%s)', async (risk) => {
    const api = await start(false, {
      ...(risk === 'plain' ? {} : { plainRemotes: [] }),
      ...(risk === 'loopback' ? {} : { loopbackRemotes: [] })
    })
    const read = await api.request('/api/route', bearer(WALL))
    expect(read.status).toBe(200)
    const state = await read.json()
    if (risk === null) expect(state).not.toHaveProperty('remoteRisks')
    else expect(state.remoteRisks).toEqual({ [risk]: expect.any(String) })
  })

  it('omits copies of loopback aliases and known ports across endpoint spellings', async () => {
    const metadata = ['localhost:54321', '[::1]:54321', '127.0.0.1:54321', 'fixture-host:54321/path',
      'http://fixture-host:54321/path?q=1', 'fixture-host:54321?health', 'fixture-host:54321#health',
      'localhost', 'Alias (port 54321)', ':54321/path']
    const legitimate = ['fictional.localhost.example', 'fixture-host:543210/path', 'ollama/qwen3:1.7b', 'model:54321b']
    const api = await start(false, { loopbackRemotes: [], plainRemotes: [], mcpServers: [...metadata, ...legitimate] })
    const read = await api.request('/api/route', bearer(WALL))
    expect(read.status).toBe(200)
    expect((await read.json()).mcpServers).toEqual([])
  })

  it('omits live rows whose terminal ID contains known topology', async () => {
    const api = await start(false, { live: [{ ...fixtureState().live[0], terminalId: gatewayUrl }, fixtureState().live[1]] })
    const read = await api.request('/api/route', bearer(WALL))
    expect(read.status).toBe(200)
    expect((await read.json()).live).toEqual([])
  })

  it('requires pairing or wall admission and preserves all details for a server-proven owner', async () => {
    const api = await start()
    for (const token of [OWNER, ADMITTED]) {
      const res = await api.request('/api/route', { ...bearer(token), ...v2 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(wire(api.state()))
    }
    const unpaired = await api.request('/api/route', { ...bearer('unknown'), ...v2 })
    expect(unpaired.status).toBe(401)
    expect(await unpaired.json()).toHaveProperty('error')
  })

  it('returns the restricted body even with a cached full-response validator', async () => {
    const api = await start()
    const full = await api.request('/api/route', { ...bearer(ADMITTED), ...v2 })
    expect(full.status).toBe(200)
    expect(await full.json()).toEqual(wire(api.state()))
    const fullTag = full.headers.get('etag')
    expect(fullTag).toBeTruthy()
    expect(full.headers.get('cache-control')).toBe('no-store')
    api.revoke()
    for (const validator of [fullTag!, '*']) {
      const read = await api.request('/api/route', { ...bearer(WALL), 'if-none-match': validator })
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      restricted(await read.text())
    }
  })

  it.each([
    ['/api/route/default', { model: 'ollama/qwen3:1.7b' }, { defaultModel: 'ollama/qwen3:1.7b' }, { model: null }, { defaultModel: null }],
    ['/api/route/shared-mcp', { on: false }, { sharedMcp: false }, { on: true }, { sharedMcp: true }]
  ] as const)('preserves write access and uses the same view for %s', async (path, plainBody, plainPatch, sealedBody, sealedPatch) => {
    const api = await start()
    const wall = await api.request(path, { ...bearer(WALL), ...v2 }, plainBody)
    expect(wall.status).toBe(401)
    expect(api.writes).toEqual([])
    const plain = await api.request(path, bearer(OWNER), plainBody)
    expect(plain.status).toBe(200)
    const restrictedView = restricted(await plain.text())
    expect(restrictedView).toMatchObject(path.endsWith('/default') ? { defaultModel: null, withheld: { defaultModel: true } } : plainPatch)
    const sealed = await api.request(path, { ...bearer(ADMITTED), ...v2 }, sealedBody)
    expect(sealed.status).toBe(200)
    expect(await sealed.json()).toEqual(wire(api.state()))
    expect(api.writes).toEqual([plainPatch, sealedPatch])
  })

  it('validates the fleet default as a route ID and keeps both ways to clear it', async () => {
    const api = await start()
    const path = '/api/route/default'
    for (const model of [`${gatewayUrl}?health`, 'model with spaces', '字', 'm'.repeat(129)]) {
      const response = await api.request(path, bearer(OWNER), { model })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, reason: 'model must be a route id or null' })
    }
    expect(api.writes).toEqual([])
    for (const model of ['m'.repeat(128), 'ollama/qwen3:1.7b', '', null]) {
      const response = await api.request(path, bearer(OWNER), { model })
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.defaultModel).toBeNull()
      expect(Boolean(result.withheld.defaultModel)).toBe(Boolean(model))
      expect(api.state().defaultModel).toBe(model || null)
    }
  })

  it('rejects endpoint-shaped fleet defaults before they can disagree with the restricted view', async () => {
    const api = await start()
    for (const model of ['http://192.0.2.41:54321', '192.0.2.41:54321', 'localhost:54321', '[::1]:54321', 'fixture-host:54321/path', 'fixture-host:54321?x']) {
      const response = await api.request('/api/route/default', bearer(OWNER), { model })
      expect(response.status, model).toBe(400)
      expect(await response.json()).toEqual({ ok: false, reason: 'model must be a route id or null' })
    }
    expect(api.writes).toEqual([])
    const valid = await api.request('/api/route/default', bearer(OWNER), { model: 'ollama/qwen3:1.7b' })
    expect(valid.status).toBe(200)
    expect((await valid.json()).withheld.defaultModel).toBe(true)
    expect(api.state().defaultModel).toBe('ollama/qwen3:1.7b')
  })

  it('marks filtered-empty setup and library fields and uses neutral hidden status text', async () => {
    const initial = {
      mcpServers: ['localhost:54321'],
      setup: {
        ...fixtureState().setup,
        addGroupLine: 'magpie group add smart models=127.0.0.1:54321,group/smart routing=smart'
      },
      live: [
        { ...fixtureState().live[0], status: '503' },
        { ...fixtureState().live[1], status: 'raw decision failure' }
      ]
    }
    const api = await start(false, initial)
    const read = await api.request('/api/route', bearer(WALL))
    expect(read.status).toBe(200)
    const raw = await read.text()
    const owner = await api.request('/api/route', { ...bearer(OWNER), ...v2 })
    expect(await owner.json()).toEqual(wire(api.state()))
    for (const value of ['localhost:54321', '127.0.0.1:54321', 'raw decision failure']) expect(raw).not.toContain(value)
    const view = JSON.parse(raw)
    expect(view.withheld).toMatchObject({ mcpServers: true, addGroupLine: true, providerData: true })
    expect(view.mcpServers).toEqual([])
    expect(view.setup.addGroupLine).toBeNull()
    expect(view.live).toEqual([])
    expect(view.quotas).toEqual([])
  })

  it('redacts a private inventory of every configured endpoint across all four outlets', async () => {
    const endpoints = ['https://alpha.example:51001/v1', 'http://100.111.112.113:51002/v1', 'https://charlie.example:51003/path', 'http://delta.example:51004', 'https://echo.example:51005']
    const inventory = endpoints.map((endpoint) => new URL(endpoint).hostname)
    const initial = { mcpServers: [...inventory, 'memory'], models: [{ ...fixtureState().models[0], displayName: `Model ${inventory[0]}` }] }
    const api = await start(false, initial, false, undefined, () => endpoints)
    const owner = await api.request('/api/route', { ...bearer(OWNER), ...v2 })
    expect(await owner.json()).toEqual(wire(api.state()))
    const wall = await openStream(api.origin, bearer(WALL))
    const sources = [
      await api.request('/api/route', bearer(WALL)),
      await api.request('/api/route/default', bearer(OWNER), { model: 'group/smart' }),
      await api.request('/api/route/shared-mcp', bearer(OWNER), { on: true })
    ]
    api.routeBus.emit('route', api.state())
    const bodies = [...await Promise.all(sources.map((response) => response.text())), await wall('route')]
    for (const raw of bodies) {
      for (const host of inventory) expect(raw).not.toContain(host)
      expect(raw).not.toContain('51001')
      const view = JSON.parse(raw)
      expect(view.mcpServers).toEqual([])
      expect(view.withheld.mcpServers).toBe(true)
      expect(view.models).toEqual([])
      expect(view).not.toHaveProperty('endpointInventory')
    }
  })

  it('fails closed for provider-controlled text when endpoint inventory is unavailable', async () => {
    const api = await start(false, { mcpServers: ['hidden.example'] }, false, undefined, () => null)
    const wall = await api.request('/api/route', bearer(WALL))
    expect(wall.status).toBe(200)
    const raw = await wall.text()
    expect(raw).not.toContain('hidden.example')
    const view = JSON.parse(raw)
    expect(view.models).toEqual([])
    expect(view.mcpServers).toEqual([])
    expect(view.withheld.mcpServers).toBe(true)
    expect(view.withheld.endpointInventory).toBe(true)
    expect(view.sharedMcp).toBe(true)
    expect(view.status).toBe('online')
    const full = await api.request('/api/route', { ...bearer(OWNER), ...v2 })
    expect(await full.json()).toEqual(wire(api.state()))
  })

  it('fails closed when the provider file disappears while route data remains cached', async () => {
    let present = true
    const config = JSON.stringify({ providers: [{ id: 'remote', chat: 'https://cached.example:51444/v1' }] })
    const inventory = () => configuredEndpointInventory({ home: '/synthetic', env: {} }, () => {
      if (!present) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return config
    })
    const api = await start(false, { mcpServers: ['cached.example'] }, false, undefined, inventory)
    const wall = await openStream(api.origin, bearer(WALL))
    api.routeBus.emit('route', api.state())
    const before = JSON.parse(await wall('route'))
    expect(before.models).toEqual([])
    expect(before.withheld.providerData).toBe(true)
    expect(before.withheld.endpointInventory).toBeUndefined()
    present = false
    api.routeBus.emit('route', api.state())
    const after = JSON.parse(await wall('route'))
    expect(after.models).toEqual([])
    expect(after.live).toEqual([])
    expect(after.quotas).toEqual([])
    expect(after.withheld.endpointInventory).toBe(true)
    expect(JSON.stringify(after)).not.toContain('cached.example')
    expect(api.state().models.length).toBeGreaterThan(0)
  })

  it.each(['empty', 'replacement'])('does not disclose cached A after the config is rewritten to %s', async (rewrite) => {
    const first = 'https://cached-a.example:51444'
    let configured = [first]
    const base = fixtureState()
    const cachedModel = { ...base.models[0], displayName: 'Model from cached-a.example' }
    const cachedQuota = { ...base.quotas[0], alias: 'cached-a.example', windows: base.quotas[0].windows }
    const api = await start(false, { models: [cachedModel], quotas: [cachedQuota], mcpServers: ['cached-a.example'] }, false, undefined, () => configured)
    const wall = await openStream(api.origin, bearer(WALL))
    api.routeBus.emit('route', api.state())
    expect(await wall('route')).not.toContain('cached-a.example')
    configured = rewrite === 'empty' ? [] : ['https://replacement-b.example:51445']
    api.routeBus.emit('route', { ...api.state(), checkedAt: api.state().checkedAt + 1 })
    const raw = await wall('route')
    expect(raw).not.toContain('cached-a.example')
    expect(api.state().models[0].displayName).toContain('cached-a.example')
  })

  it('marks an existing auto-group command as withheld, but not a genuinely missing one', async () => {
    const base = fixtureState()
    const present = await start(false, { setup: { ...base.setup, addAutoGroupLine: 'magpie group add auto models=ollama/qwen routing=smart stays=turn' } })
    const hidden = await (await present.request('/api/route', bearer(WALL))).json()
    expect(hidden.setup.addAutoGroupLine).toBeNull()
    expect(hidden.withheld.addAutoGroupLine).toBe(true)
    const absent = await start(false, { setup: { ...base.setup, addAutoGroupLine: null } })
    const missing = await (await absent.request('/api/route', bearer(WALL))).json()
    expect(missing.setup.addAutoGroupLine).toBeNull()
    expect(missing.withheld.addAutoGroupLine).toBeUndefined()
  })

  it('withholds unproven provider text and controls while retaining safe state', async () => {
    const api = await start()
    const res = await api.request('/api/route', bearer(WALL))
    expect(res.status).toBe(200)
    const view = await res.json()
    expect(view.models).toEqual([])
    expect(view.quotas).toEqual([])
    expect(view.live).toEqual([])
    expect(view.mcpServers).toEqual([])
    expect(view.defaultModel).toBeNull()
    expect(view.withheld.providerData).toBe(true)
    expect(view.withheld.defaultModel).toBe(true)
    expect(view.setup.addGroupLine).toBeNull()
    expect(view.sharedMcp).toBe(true)
    expect(view.status).toBe('online')
    const owner = await api.request('/api/route', { ...bearer(OWNER), ...v2 })
    expect(await owner.json()).toEqual(wire(api.state()))
  })

  it('does not expose cache data from an endpoint configuration never observed by the projection', async () => {
    const base = fixtureState()
    const api = await start(false, {
      models: [{ ...base.models[0], displayName: 'cached transient.example' }],
      mcpServers: ['cached transient.example']
    }, false, undefined, () => [])
    const response = await api.request('/api/route', bearer(WALL))
    expect(await response.text()).not.toContain('transient.example')
  })

  it('re-reads the private inventory for every SSE frame and fails closed if it throws', async () => {
    let inventory: string[] | null = []
    let throwing = false
    const api = await start(false, { mcpServers: ['future-configured.example', 'memory'] }, false, undefined, () => {
      if (throwing) throw new Error('fixture read failure')
      return inventory
    })
    const wall = await openStream(api.origin, bearer(WALL))
    api.routeBus.emit('route', api.state())
    expect(JSON.parse(await wall('route')).mcpServers).toEqual([])
    inventory = ['https://future-configured.example:51444']
    api.routeBus.emit('route', { ...api.state(), checkedAt: api.state().checkedAt + 1 })
    const next = JSON.parse(await wall('route'))
    expect(next.mcpServers).toEqual([])
    expect(next.withheld.mcpServers).toBe(true)
    throwing = true
    api.routeBus.emit('route', api.state())
    const closed = JSON.parse(await wall('route'))
    expect(closed.models).toEqual([])
    expect(closed.mcpServers).toEqual([])
    expect(closed.withheld.endpointInventory).toBe(true)
  })

  it('replaces an unsafe stored default with an explicit hidden marker', async () => {
    const api = await start(false, { defaultModel: 'localhost:54321' })
    const view = await (await api.request('/api/route', bearer(WALL))).json()
    expect(view.defaultModel).toBeNull()
    expect(view.withheld.defaultModel).toBe(true)
  })

  it('withholds unknown provider hosts whose provenance cannot be verified', async () => {
    const api = await start(false, { mcpServers: ['unknown.example', 'provider.example:9000'] })
    const read = await api.request('/api/route', bearer(WALL))
    expect(read.status).toBe(200)
    const view = await read.json()
    expect(view.mcpServers).toEqual([])
    expect(view.withheld).toMatchObject({ mcpServers: true, providerData: true })
  })

  it.each(['/api/route/default', '/api/route/shared-mcp'])('keeps service and parsing diagnostics private on %s', async (path) => {
    const api = await start(true)
    const body = path.endsWith('/default') ? { model: 'group/smart' } : { on: false }
    const malformed = await api.request(path, bearer(OWNER), `invalid ${gatewayUrl}`)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ ok: false, reason: 'Invalid route settings JSON.' })
    const nullBody = await api.request(path, bearer(OWNER), 'null')
    expect(nullBody.status).toBe(400)
    const plain = await api.request(path, bearer(OWNER), body)
    expect(plain.status).toBe(500)
    expect(await plain.json()).toEqual({ error: 'Route settings could not be saved.' })
    const sealed = await api.request(path, { ...bearer(OWNER), ...v2 }, body)
    expect(sealed.status).toBe(500)
    expect(await sealed.json()).toEqual({ error: `raw writer failure at ${gatewayUrl}` })
  })

  it('rechecks admission after reading a delayed PUT body', async () => {
    const api = await start()
    const entered = new Promise<void>((resolve) => api.server.prependOnceListener('request', (req) => {
      const onListener = (event: string | symbol) => {
        if (event !== 'data') return
        req.removeListener('newListener', onListener)
        setImmediate(resolve)
      }
      req.on('newListener', onListener)
    }))
    const result = new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const req = http.request(`${api.origin}/api/route/default?route=${ROUTE_HTTP_SCHEMA_VERSION}`, {
        method: 'PUT', headers: { ...bearer(ADMITTED), ...v2 }, signal: AbortSignal.timeout(3000)
      }, (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.write('{"model":')
      void entered.then(() => { api.revoke(); req.end('null}') })
    })
    const res = await result
    expect(res.status).toBe(401)
    expect(res.text).not.toContain(gatewayUrl)
    expect(api.writes).toEqual([])
  })

  it('drops a failed restricted SSE frame and keeps serving both listeners', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const api = await start()
      const wall = await openStream(api.origin, bearer(WALL))
      const owner = await openStream(api.origin, { ...bearer(OWNER), ...v2 })
      const invalid = { ...api.state(), harnesses: null }
      expect(() => api.routeBus.emit('route', invalid)).not.toThrow()
      expect(JSON.parse(await owner('route'))).toEqual(wire(invalid))
      expect(warn.mock.calls).toEqual([['[route] Dropped an SSE frame.']])
      api.routeBus.emit('route', api.state())
      restricted(await wall('route'))
      expect(JSON.parse(await owner('route'))).toEqual(wire(api.state()))
    } finally {
      warn.mockRestore()
    }
  })

  it('drops full detail on an embedded open stream when its live root token rotates', async () => {
    let root: string | null = OWNER
    const api = await start(false, undefined, true, () => root)
    const stream = await openStream(api.origin, { ...bearer(OWNER), ...v2 })
    api.routeBus.emit('route', api.state())
    expect(JSON.parse(await stream('route'))).toEqual(wire(api.state()))
    root = NEXT_OWNER
    api.routeBus.emit('route', api.state())
    restricted(await stream('route'))
    root = null
    expect((await api.request('/api/route', { ...bearer(OWNER), ...v2 })).status).toBe(401)
  })

  it('downgrades an open root SSE stream after token rotation and keeps admitted readers full', async () => {
    const rotate = vi.mocked(rotatePairingToken)
    rotate.mockReturnValueOnce(OWNER)
    rotateActivePairingToken()
    try {
      const api = await start()
      const root = await openStream(api.origin, { ...bearer(OWNER), ...v2 })
      const admitted = await openStream(api.origin, { ...bearer(ADMITTED), ...v2 })
      const first = api.state()
      const second = { ...first, checkedAt: first.checkedAt + 1 }
      for (const state of [first, second]) {
        api.routeBus.emit('route', state)
        expect(JSON.parse(await root('route'))).toEqual(wire(state))
        expect(JSON.parse(await admitted('route'))).toEqual(wire(state))
      }
      rotate.mockReturnValueOnce(NEXT_OWNER)
      expect(rotateActivePairingToken()).toBe(NEXT_OWNER)
      api.routeBus.emit('route', first)
      restricted(await root('route'))
      expect(JSON.parse(await admitted('route'))).toEqual(wire(first))
      const former = await api.request('/api/route', { ...bearer(OWNER), ...v2 })
      expect(former.status).toBe(401)
      const current = await api.request('/api/route', { ...bearer(NEXT_OWNER), ...v2 })
      expect(current.status).toBe(200)
      expect(await current.json()).toEqual(wire(first))
    } finally {
      rotate.mockReturnValueOnce(OWNER)
      rotateActivePairingToken()
    }
  })

  it.each(['owner first', 'wall first'])('projects concurrent SSE independently with %s and rechecks revocation', async (order) => {
    const api = await start()
    const ownerHeaders = { ...bearer(ADMITTED), ...v2 }
    const wallHeaders = { ...bearer(WALL), ...v2 }
    const [first, second] = order === 'owner first' ? [ownerHeaders, wallHeaders] : [wallHeaders, ownerHeaders]
    const readFirst = await openStream(api.origin, first)
    const readSecond = await openStream(api.origin, second)
    const [owner, wall] = order === 'owner first' ? [readFirst, readSecond] : [readSecond, readFirst]
    const plain = await openStream(api.origin, bearer(OWNER))
    api.routeBus.emit('route', api.state())
    const [ownerRaw, wallRaw, plainRaw] = await Promise.all([owner('route'), wall('route'), plain('route')])
    expect(JSON.parse(ownerRaw)).toEqual(wire(api.state()))
    const view = restricted(wallRaw)
    expect(JSON.parse(plainRaw)).toEqual(view)
    api.revoke()
    // Same source state. The revoked subscriber must get a new, restricted snapshot.
    api.routeBus.emit('route', api.state())
    expect(JSON.parse(await owner('route'))).toEqual(view)
    expect(api.state().gateway.url).toBe(gatewayUrl)
  })
})
