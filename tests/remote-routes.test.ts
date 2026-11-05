// EVERY WAY IN, THROUGH THE REAL ROUTES AND THE REAL DESK.
//
// A remote desktop is the owner's screen and, with the switch on, the owner's
// hands. So: the pairing credential and nothing less, no route of any kind to
// the machine switch, and a served session refused every door.
import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { createRemoteDesk, type RemoteDesk, type RemoteDeskDeps } from '../src/main/remote-desk'
import { SERVED_USE_REFUSED } from '../src/main/use-commands'
import { createUseSourceService, type UseSourceProvider } from '../src/main/use-source-service'
import type { BrowserNodeData } from '../src/shared/model'
import type { ViewerWho } from '../src/shared/remote-access'

const TOKEN = 'pairing-token-123'
const PHONE_TOKEN = 'phone-token-789'
const WALL = 'wall-token-456'

const card = (id: string, url: string): BrowserNodeData => ({
  kind: 'browser', id, name: id, url, tabs: [{ id: `${id}-t`, url, title: '' }], activeTabId: `${id}-t`, position: { x: 0, y: 0 }, size: { width: 720, height: 560 }
})
const CARDS: Record<string, { workspaceId: string; node: BrowserNodeData }> = {
  screen: { workspaceId: 'ws', node: card('screen', 'screen://main') },
  phone: { workspaceId: 'ws', node: card('phone', 'adb://default') },
  web: { workspaceId: 'ws', node: card('web', 'https://a.test') },
  served: { workspaceId: 'served', node: card('served', 'screen://main') }
}

function bed(over: Partial<RemoteDeskDeps> = {}) {
  const provider: UseSourceProvider = { list: vi.fn(async () => ({ state: 'ready' as const, windows: [], screens: [], message: null, remote: null, windowsNote: null })), openSettings: vi.fn(async () => undefined) }
  const relaunch = vi.fn()
  const desk: RemoteDesk = createRemoteDesk({
    platform: 'darwin',
    build: () => ({ settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }),
    linuxRefusal: () => null,
    screenAccess: () => 'granted',
    accessibility: () => true,
    session: async () => ({ locked: false, displayAsleep: false, grant: true }),
    settings: { read: () => ({ on: false, waiting: null }), write: () => undefined },
    servedWorkspace: (id) => id === 'served',
    workspaceOfCard: (id) => CARDS[id]?.workspaceId ?? null,
    cardName: (id) => id,
    record: () => undefined,
    keepAwake: { start: () => undefined, stop: () => undefined },
    host: () => undefined,
    refreshCards: () => undefined,
    dropViewers: () => undefined,
    openSettings: (pane) => provider.openSettings(pane),
    relaunch,
    ...over
  })
  const useSources = createUseSourceService({
    provider: () => provider,
    servedWorkspace: (id) => id === 'served',
    addCard: (_ws, node) => node,
    findCard: (id) => CARDS[id] ?? null,
    readdress: async (node) => node,
    desk,
    who: (credential): ViewerWho => (credential === PHONE_TOKEN ? { key: 'device:p', name: 'Pixel', here: false } : { key: 'root', name: 'A paired device', here: false })
  })
  const deps = (scope: string | null = null): MobileApiDeps =>
    ({ pairingToken: TOKEN, companionToken: (t: string) => t === PHONE_TOKEN, wallToken: WALL, scope, store: { focusedId: 'ws' }, ops: { useSources } }) as unknown as MobileApiDeps
  return { provider, relaunch, desk, deps }
}

async function call(deps: MobileApiDeps, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const request = Readable.from(opts.body === undefined ? [] : [JSON.stringify(opts.body)]) as http.IncomingMessage
  request.method = method
  request.headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {}
  const out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
  const response = {
    writeHead(status: number) {
      out.status = status
      return this
    },
    end(raw?: string | Buffer) {
      out.body = raw ? JSON.parse(raw.toString()) : {}
    }
  } as unknown as http.ServerResponse
  await handleMobileApi(request, response, new URL(path, 'http://lan.local'), deps)
  return out
}

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/use/sources/access', undefined],
  ['POST', '/api/use/sources/control', { card: 'screen', on: true }],
  ['POST', '/api/use/sources/settings', { pane: 'accessibility' }],
  ['POST', '/api/use/sources/restart', undefined]
]

describe('who may ask', () => {
  it.each(ROUTES)('%s %s: no token is shut', async (method, path, body) => {
    const { deps, relaunch } = bed()
    expect((await call(deps(), method, path, { body })).status).toBeGreaterThanOrEqual(401)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('%s %s: the wall\'s read-only token is shut too', async (method, path, body) => {
    const { deps, relaunch, provider } = bed()
    const { status } = await call(deps(), method, path, { token: WALL, body })
    expect([401, 403]).toContain(status)
    expect(relaunch).not.toHaveBeenCalled()
    expect(provider.openSettings).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('%s %s: a served session is refused even with a good token', async (method, path, body) => {
    const { deps, relaunch, provider, desk } = bed()
    desk.setSwitch(true)
    const answer = await call(deps('served'), method, path, { token: TOKEN, body })
    expect(answer).toMatchObject({ status: 403, body: { error: SERVED_USE_REFUSED } })
    expect(relaunch).not.toHaveBeenCalled()
    expect(provider.openSettings).not.toHaveBeenCalled()
    expect(desk.mayDrive('screen', { key: 'root', name: '', here: false })).toBe(false)
  })
})

describe('the machine switch has no route', () => {
  it.each(['/api/use/sources/switch', '/api/use/sources/remote-control', '/api/use/sources/control-switch'])('%s is nothing', async (path) => {
    const { deps, desk } = bed()
    const answer = await call(deps(), 'POST', path, { token: TOKEN, body: { on: true } })
    expect(answer.status).toBe(404)
    expect(desk.controlFacts().switchOn).toBe(false)
  })

  it('Take control cannot turn it on as a side effect', async () => {
    const { deps, desk } = bed()
    const answer = await call(deps(), 'POST', '/api/use/sources/control', { token: TOKEN, body: { card: 'screen', on: true, switch: true } })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toMatch(/Remote control of this Mac is off/)
    expect(desk.controlFacts().switchOn).toBe(false)
  })
})

describe('Take control from a paired device', () => {
  it('names the device that asked, by its own token', async () => {
    const { deps, desk } = bed()
    desk.setSwitch(true)
    expect((await call(deps(), 'POST', '/api/use/sources/control', { token: PHONE_TOKEN, body: { card: 'screen', on: true } })).status).toBe(200)
    expect(desk.mayDrive('screen', { key: 'device:p', name: 'Pixel', here: false })).toBe(true)
    expect(desk.mayDrive('screen', { key: 'root', name: 'A paired device', here: false })).toBe(false)
  })

  it('gives it back', async () => {
    const { deps, desk } = bed()
    desk.setSwitch(true)
    await call(deps(), 'POST', '/api/use/sources/control', { token: PHONE_TOKEN, body: { card: 'screen', on: true } })
    await call(deps(), 'POST', '/api/use/sources/control', { token: PHONE_TOKEN, body: { card: 'screen', on: false } })
    expect(desk.mayDrive('screen', { key: 'device:p', name: 'Pixel', here: false })).toBe(false)
  })

  it('answers the state to show when Accessibility is the reason', async () => {
    const { deps, desk } = bed({ accessibility: () => false })
    desk.setSwitch(true)
    const answer = await call(deps(), 'POST', '/api/use/sources/control', { token: TOKEN, body: { card: 'screen', on: true } })
    expect(answer).toMatchObject({ status: 409, body: { state: { id: 'needs-accessibility' } } })
  })

  it.each([
    ['a web page', 'web', 400],
    ['a phone', 'phone', 400],
    ['a card that is not there', 'nope', 404],
    ['a served workspace\'s card', 'served', 403]
  ])('refuses %s', async (_what, id, status) => {
    const { deps, desk } = bed()
    desk.setSwitch(true)
    expect((await call(deps(), 'POST', '/api/use/sources/control', { token: TOKEN, body: { card: id, on: true } })).status).toBe(status)
  })

  it.each([[null], [{}], [{ card: 'screen' }], [{ card: 'screen', on: 'yes' }], [{ card: 5, on: true }]])('a malformed ask is a 400: %j', async (body) => {
    const { deps } = bed()
    expect((await call(deps(), 'POST', '/api/use/sources/control', { token: TOKEN, body })).status).toBe(400)
  })
})

describe('the rest', () => {
  it('reads the state from away', async () => {
    const { deps } = bed({ screenAccess: () => 'denied', session: async () => ({ locked: true, displayAsleep: true, grant: false }) })
    expect(await call(deps(), 'GET', '/api/use/sources/access', { token: TOKEN })).toMatchObject({
      status: 200,
      body: { state: { id: 'locked', then: 'needs-screen-recording' }, control: { switchOn: false } }
    })
  })

  it('a jump from a phone opens the page on the Mac, and remembers who is waiting', async () => {
    const { deps, provider, desk } = bed({ screenAccess: () => 'denied', session: async () => ({ locked: false, displayAsleep: false, grant: false }) })
    expect((await call(deps(), 'POST', '/api/use/sources/settings', { token: TOKEN, body: { pane: 'accessibility' } })).status).toBe(200)
    expect(provider.openSettings).toHaveBeenCalledWith('accessibility')
    expect((await desk.state('away')).waiting).toBe(true)
  })

  it('an unknown page is a 400 and opens nothing', async () => {
    const { deps, provider } = bed()
    expect((await call(deps(), 'POST', '/api/use/sources/settings', { token: TOKEN, body: { pane: 'x-apple.systempreferences:evil' } })).status).toBe(400)
    expect(provider.openSettings).not.toHaveBeenCalled()
  })

  it('restarts a build that can, and only on a POST', async () => {
    const { deps, relaunch } = bed()
    expect((await call(deps(), 'GET', '/api/use/sources/restart', { token: TOKEN })).status).toBe(405)
    expect(relaunch).not.toHaveBeenCalled()
    expect((await call(deps(), 'POST', '/api/use/sources/restart', { token: TOKEN })).status).toBe(200)
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('a source build says it cannot, in words', async () => {
    const { deps, relaunch } = bed({ build: () => ({ settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }) })
    expect((await call(deps(), 'POST', '/api/use/sources/restart', { token: TOKEN })).status).toBe(409)
    expect(relaunch).not.toHaveBeenCalled()
  })
})
