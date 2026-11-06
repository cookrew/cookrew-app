// THE ROUTES THE PHONE REACHES (main/use-source-routes.ts), through the real
// handleMobileApi and its gates. A window's thumbnail is what is on the
// owner's screen, so these open to the pairing credential and nothing less:
// no token, the wall's read-only token, and a served workspace are all shut.
import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { scopedRouteSupported } from '../src/main/mobile-slug-route'
import { sealProofHeaders } from '../src/main/seal-proof'
import { SERVED_USE_REFUSED } from '../src/main/use-commands'
import { createUseSourceService, type UseSourceProvider, type UseSourceServiceDeps } from '../src/main/use-source-service'
import type { BrowserNodeData } from '../src/shared/model'
import type { UseSourceList } from '../src/shared/use-sources'

const TOKEN = 'pairing-token-123'
const WALL = 'wall-token-456'

const list: UseSourceList = {
  state: 'ready',
  windows: [{ id: 'window:41', kind: 'window', title: 'Docs', app: 'Safari', address: 'window://Safari?id=41', thumb: 'data:image/jpeg;base64,AA', icon: null, width: 800, height: 600 }],
  screens: [],
  message: null,
  remote: null,
  windowsNote: null
}

function bed(over: Partial<UseSourceServiceDeps> = {}) {
  const provider: UseSourceProvider = { list: vi.fn(async () => list), openSettings: vi.fn(async () => undefined) }
  const added: Array<{ workspaceId: string; card: BrowserNodeData }> = []
  const useSources = createUseSourceService({
    provider: () => provider,
    servedWorkspace: (id) => id === 'served',
    addCard: (workspaceId, card) => {
      added.push({ workspaceId, card })
      return card
    },
    findCard: () => null,
    readdress: async (node) => node,
    ...over
  })
  const deps = (scope: string | null = null): MobileApiDeps =>
    ({ pairingToken: TOKEN, wallToken: WALL, scope, store: { focusedId: 'ws' }, ops: { useSources } }) as unknown as MobileApiDeps
  return { provider, added, deps }
}

async function call(deps: MobileApiDeps, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const request = Readable.from(opts.body === undefined ? [] : [JSON.stringify(opts.body)]) as http.IncomingMessage
  request.method = method
  request.headers = { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers }
  const out: { status: number; headers: Record<string, string>; body: unknown } = { status: 0, headers: {}, body: undefined }
  const response = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status
      out.headers = headers
      return this
    },
    end(raw?: string | Buffer) {
      out.body = raw ? JSON.parse(raw.toString()) : undefined
    }
  } as unknown as http.ServerResponse
  const handled = await handleMobileApi(request, response, new URL(path, 'http://lan.local'), deps)
  return { handled, ...out }
}

describe('with the pairing token', () => {
  it('lists', async () => {
    const { deps } = bed()
    expect(await call(deps(), 'GET', '/api/use/sources', { token: TOKEN })).toMatchObject({ handled: true, status: 200, body: list })
  })
  it('a list of pictures of the screen is never kept: a phone forgotten later must not still hold them', async () => {
    const { deps } = bed()
    const { headers } = await call(deps(), 'GET', '/api/use/sources', { token: TOKEN })
    expect(headers['cache-control']).toBe('no-store')
  })
  it('opens a card in the focused workspace', async () => {
    const { deps, added } = bed()
    const answer = await call(deps(), 'POST', '/api/use/sources/open', { token: TOKEN, body: { source: 'window:41' } })
    expect(answer).toMatchObject({ status: 200, body: { ok: true, card: { url: 'window://Safari?id=41' } } })
    expect(added[0].workspaceId).toBe('ws')
  })
  it('a slugged phone lands in its own workspace, and the slug route lets these through', async () => {
    const { deps, added } = bed()
    await call(deps('scoped'), 'POST', '/api/use/sources/open', { token: TOKEN, body: { source: 'window:41' } })
    expect(added[0].workspaceId).toBe('scoped')
    for (const path of ['/api/use/sources', '/api/use/sources/open', '/api/use/sources/settings', '/api/use/sources/access', '/api/use/sources/control', '/api/use/sources/restart']) expect(scopedRouteSupported(path), path).toBe(true)
  })
  it('opens the settings page', async () => {
    const { deps, provider } = bed()
    expect(await call(deps(), 'POST', '/api/use/sources/settings', { token: TOKEN })).toMatchObject({ status: 200, body: { ok: true } })
    expect(provider.openSettings).toHaveBeenCalledOnce()
  })
  it('a malformed body is a 400, never a card', async () => {
    const { deps, added } = bed()
    expect((await call(deps(), 'POST', '/api/use/sources/open', { token: TOKEN, body: { source: 'file:///etc/passwd' } })).status).toBe(400)
    expect(added).toEqual([])
  })
  it('a verb the route does not have is not an answer', async () => {
    const { deps } = bed()
    expect((await call(deps(), 'DELETE', '/api/use/sources', { token: TOKEN })).status).toBe(405)
    expect((await call(deps(), 'GET', '/api/use/sources/open', { token: TOKEN })).status).toBe(405)
  })
  it('a Mac with no service wired answers 503', async () => {
    const deps = { pairingToken: TOKEN, store: { focusedId: 'ws' }, ops: {} } as unknown as MobileApiDeps
    expect((await call(deps, 'GET', '/api/use/sources', { token: TOKEN })).status).toBe(503)
  })
})

describe('without it, nothing about the screen is answered', () => {
  const routes: Array<[string, string, unknown]> = [
    ['GET', '/api/use/sources', undefined],
    ['POST', '/api/use/sources/open', { source: 'window:41' }],
    ['POST', '/api/use/sources/settings', undefined]
  ]

  it.each(routes)('%s %s: no token is a 401', async (method, path, body) => {
    const { deps, provider, added } = bed()
    expect((await call(deps(), method, path, { body })).status).toBe(401)
    expect(provider.list).not.toHaveBeenCalled()
    expect(added).toEqual([])
  })

  it.each(routes)('%s %s: the read-only wall token is shut out, reads included', async (method, path, body) => {
    const { deps, provider, added } = bed()
    const { status } = await call(deps(), method, path, { token: WALL, body })
    expect([401, 403]).toContain(status)
    expect(provider.list).not.toHaveBeenCalled()
    expect(added).toEqual([])
  })

  it('a deps with no pairing token at all stays shut: the in-process escape does not open the screen', async () => {
    const { deps, provider } = bed()
    const open = { ...deps(), pairingToken: undefined } as unknown as MobileApiDeps
    expect((await call(open, 'GET', '/api/use/sources')).status).toBe(403)
    expect(provider.list).not.toHaveBeenCalled()
  })
})

describe('a served session', () => {
  it.each([
    ['GET', '/api/use/sources', undefined],
    ['POST', '/api/use/sources/open', { source: 'window:41' }],
    ['POST', '/api/use/sources/open', { source: 'screen:main', card: 'any' }],
    ['POST', '/api/use/sources/settings', undefined]
  ] as Array<[string, string, unknown]>)('%s %s: refused even with a good token, and the source is never read', async (method, path, body) => {
    const { deps, provider, added } = bed()
    const answer = await call(deps('served'), method, path, { token: TOKEN, body })
    expect(answer).toMatchObject({ status: 403, body: { error: SERVED_USE_REFUSED } })
    expect(provider.list).not.toHaveBeenCalled()
    expect(provider.openSettings).not.toHaveBeenCalled()
    expect(added).toEqual([])
  })
})

describe('the unlock routes', () => {
  const direct = { host: '192.168.1.5:8643' }
  const door = () => ({
    begin: vi.fn(async () => ({ ok: true as const, key: 'k', challenge: 'c' })),
    reopen: vi.fn(),
    unlock: vi.fn(async () => ({ ok: true as const, outcome: 'unlocked' as const }))
  })

  it('a paired device gets the key and sends what it sealed', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers: direct })).body).toEqual({ ok: true, key: 'k', challenge: 'c' })
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: TOKEN, body: { sealed: 'e.box' }, headers: direct })).body).toEqual({ ok: true, outcome: 'unlocked' })
    expect(unlock.unlock).toHaveBeenCalledWith(expect.anything(), 'e.box')
  })

  it('the wall token reaches neither', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: WALL, body: {} })).status).toBeGreaterThanOrEqual(401)
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: WALL, body: { sealed: 'e.box' } })).status).toBeGreaterThanOrEqual(401)
    expect(unlock.begin).not.toHaveBeenCalled()
    expect(unlock.unlock).not.toHaveBeenCalled()
  })

  it('a served seat reaches neither', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const served = { ...deps(), store: { focusedId: 'served' } } as MobileApiDeps
    expect((await call(served, 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers: direct })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('out of the sealed session it opens, from any network: the owner ruled unlock works away from home', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { host: '127.0.0.1:8643', 'x-cookrew-relay': '1', ...sealProofHeaders() }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(200)
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: TOKEN, body: { sealed: 'e.box' }, headers })).status).toBe(200)
    expect(unlock.unlock).toHaveBeenCalledWith(expect.anything(), 'e.box')
  })

  it('the proof does not stand in for the pairing token', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { host: '127.0.0.1:8643', 'x-cookrew-relay': '1', ...sealProofHeaders() }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { body: {}, headers })).status).toBeGreaterThanOrEqual(400)
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: WALL, body: {}, headers })).status).toBeGreaterThanOrEqual(400)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('a guessed proof on a relayed request is a relayed request', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { host: '127.0.0.1:8643', 'x-cookrew-relay': '1', 'x-cookrew-sealed': 'guess' }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('nothing that came through the relay or WebRTC in the clear reaches it', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { ...direct, 'x-cookrew-relay': '1' }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(403)
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: TOKEN, body: { sealed: 'e.box' }, headers })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
    expect(unlock.unlock).not.toHaveBeenCalled()
  })

  it('a page from cookrew.dev that moved its traffic to the LAN is still that page', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { origin: 'https://cookrew.dev', host: '192.168.1.5:8643' }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('a name under d.cookrew.dev is no page of the Mac’s own: cookrew.dev runs that DNS and its certificates', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const name = '192-168-1-5.abc.d.cookrew.dev:8643'
    const headers = { origin: `https://${name}`, host: name }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('what a door carried in reaches neither, Origin or none', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { ...direct, 'x-cookrew-door': '1' }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(403)
    expect(unlock.begin).not.toHaveBeenCalled()
  })

  it('a page the Mac served itself gets through', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    const headers = { origin: 'https://192.168.1.5:8643', host: '192.168.1.5:8643' }
    expect((await call(deps(), 'POST', '/api/use/sources/unlock/begin', { token: TOKEN, body: {}, headers })).status).toBe(200)
  })

  it('refuses anything that is not a sealed string', async () => {
    const unlock = door()
    const { deps } = bed({ unlock })
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: TOKEN, body: { sealed: 7 }, headers: direct })).status).toBe(400)
    expect((await call(deps(), 'POST', '/api/use/sources/unlock', { token: TOKEN, body: { sealed: 'x'.repeat(5000) }, headers: direct })).status).toBe(400)
    expect(unlock.unlock).not.toHaveBeenCalled()
  })
})

