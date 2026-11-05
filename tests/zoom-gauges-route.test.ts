// THE GAUGES ARE THE OWNER'S (device-gauges, point 4). Driven through the real
// `handle`, gate and all: a mock of the gate would only prove the mock. A
// served caller and a sandbox are strangers on this machine, and how loaded the
// owner's Mac is, is not theirs to read.
import type http from 'node:http'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineGauges } from '../src/shared/machine-gauges'
import { isDoorPath } from '../src/shared/relay-frame'
import { scopedRouteSupported } from '../src/main/mobile-slug-route'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { seatbeltProfile } from '../src/main/session-sandbox'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import { registerZoomFleetIpc } from '../src/main/zoom-fleet'
import { createAdmittedDeviceStore, hashToken, writeAdmittedDevices } from '../src/main/admitted-devices'
import { tempBase } from './support/idv2'

const READING: MachineGauges = { at: 7, cpuPercent: 34, memory: null, disk: null, gpuPercent: null }
const read = vi.hoisted(() => vi.fn())
vi.mock('../src/main/machine-gauges', async (original) => ({
  ...(await original<typeof import('../src/main/machine-gauges')>()),
  sharedGaugeWatch: () => ({ read })
}))

const ROOT = 'the-root-pairing-token-abcdefgh'
const WALL = 'the-read-only-wall-token-abcdefg'
const PHONE = 'a1b2c3d4-1111-8222-8333-444444444444'
const PHONE_TOKEN = 'the-phones-own-per-device-token1'
const DOOR_BEARER = 'a-served-callers-door-bearer-token'
const PATH = '/api/levels/gauges'

let temp: { base: string; clean: () => void }
beforeEach(() => {
  temp = tempBase()
  writeAdmittedDevices([{ deviceId: PHONE, name: 'iPhone', admittedAt: 1, lastSeenAt: 1, tokenHash: hashToken(PHONE_TOKEN) }], temp.base)
  read.mockReset()
  read.mockResolvedValue(READING)
})
afterEach(() => temp.clean())

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
  done: Promise<void>
}

function exchange(url: string, headers: Record<string, string>, method: string, address: string): { request: http.IncomingMessage; response: http.ServerResponse; captured: Captured } {
  const request = new EventEmitter() as http.IncomingMessage
  request.method = method
  request.url = url
  request.headers = { host: '127.0.0.1:8643', ...headers }
  Object.assign(request, { socket: { remoteAddress: address } })
  let ended = (): void => undefined
  const captured: Captured = { status: 0, headers: {}, body: '', done: new Promise((resolve) => { ended = resolve }) }
  const set: Record<string, string> = {}
  const response = {
    setHeader: (name: string, value: string) => { set[name.toLowerCase()] = value },
    getHeader: (name: string) => set[name.toLowerCase()],
    writeHead(status: number, more: Record<string, string> = {}) {
      captured.status = status
      captured.headers = { ...set, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k.toLowerCase(), v])) }
      return response
    },
    write(chunk: string | Buffer) {
      captured.body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body += chunk.toString()
      ended()
    },
    on: () => response,
    once: () => response,
    removeListener: () => response,
    writableEnded: false,
    destroy: vi.fn()
  } as unknown as http.ServerResponse
  return { request, response, captured }
}

interface Options {
  strict?: boolean
  multiInstance?: boolean
  liveSlug?: string
  servedSlug?: MobileServerDeps['servedSlug']
}

const depsOf = (o: Options): MobileServerDeps =>
  ({
    multiInstance: () => o.multiInstance ?? false,
    store: {
      focusedId: 'w1',
      focusedState: { nodes: [], edges: [] },
      workspaceState: () => ({ nodes: [], edges: [] }),
      list: () => ({ workspaces: [] }),
      bySlug: (slug: string) => (slug === o.liveSlug ? { id: 'w2' } : undefined),
      on: () => () => undefined
    },
    ptys: { get: () => null, on: () => () => undefined },
    turns: { list: () => [], on: () => () => undefined },
    activity: { on: () => () => undefined },
    events: { on: () => () => undefined },
    ops: { listWorkspaces: () => [], onUiCommand: () => () => undefined },
    presets: [],
    traces: { latestCheckpoint: () => null },
    interactiveBrowserEnabled: () => false,
    pairingToken: ROOT,
    wallToken: WALL,
    perDeviceOnly: () => o.strict ?? false,
    rendererDir: '/nonexistent',
    servedSlug: o.servedSlug,
    identity: { account: () => null, registryOrigin: () => 'https://cookrew.dev', admitted: createAdmittedDeviceStore({ base: temp.base }) }
  }) as unknown as MobileServerDeps

async function ask(url: string, token: string | null, options: Options = {}, method = 'GET', address = '192.168.2.77'): Promise<Captured> {
  const { request, response, captured } = exchange(url, token ? { authorization: `Bearer ${token}` } : {}, method, address)
  await handle(request, response, depsOf(options))
  await Promise.race([captured.done, new Promise((resolve) => setTimeout(resolve, 2000))])
  return captured
}

describe('the owner', () => {
  it('reads the gauges with the pairing token', async () => {
    const answer = await ask(PATH, ROOT)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual(READING)
  })
  it('reads them with an admitted phone’s own token, with the root demoted', async () => {
    expect((await ask(PATH, PHONE_TOKEN, { strict: true })).status).toBe(200)
  })
  it('a reading is never cached: a stale gauge reads as a calm machine', async () => {
    expect((await ask(PATH, ROOT)).headers['cache-control']).toBe('no-store')
  })
  it('a reading that failed is said, not dressed up as zeros', async () => {
    read.mockRejectedValue(new Error('no'))
    const answer = await ask(PATH, ROOT)
    expect(answer.status).toBe(503)
    expect(answer.body).not.toContain('Percent')
  })
  it('reads them from a page served under a workspace slug: the phone’s own Mac must not say no reading', async () => {
    expect(scopedRouteSupported(PATH)).toBe(true)
    const answer = await ask(`/my-work${PATH}`, ROOT, { multiInstance: true, liveSlug: 'my-work' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual(READING)
  })
  it('GET only', async () => {
    expect((await ask(PATH, ROOT, {}, 'POST')).status).toBe(405)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('everyone else is refused, and refused before anything is sampled', () => {
  const refused = async (answer: Captured, status: number): Promise<void> => {
    expect(answer.status).toBe(status)
    expect(answer.body).not.toContain('cpuPercent')
    expect(read).not.toHaveBeenCalled()
  }
  it('no token', async () => {
    await refused(await ask(PATH, null), 401)
  })
  it('the read-only wall token: a TV has no business with the owner’s swap', async () => {
    await refused(await ask(PATH, WALL), 401)
  })
  it('a served session’s door bearer, which opens its own door and nothing else', async () => {
    await refused(await ask(PATH, DOOR_BEARER), 401)
  })
  it('a sandbox on this very Mac: loopback earns nothing', async () => {
    await refused(await ask(PATH, null, {}, 'GET', '127.0.0.1'), 401)
    await refused(await ask(PATH, DOOR_BEARER, {}, 'GET', '127.0.0.1'), 401)
  })
  it('a sandbox cannot go and fetch the credential either', () => {
    const profile = seatbeltProfile({ sandbox: '/s/svc/ana-1', siblingRoot: '/s/svc', sessionsRoot: '/s', secretPaths: ownerSecretPaths('/home/owner/.cookrew', '/home/owner') })
    const deny = '(deny file-read* (subpath "/home/owner/.cookrew/pairing-token")'
    expect(profile).toContain(deny)
    expect(profile.indexOf(deny)).toBeGreaterThan(profile.indexOf('(allow file-read*)'))
  })
  it('a live workspace’s slug opens nothing by itself: a door bearer, the wall token and no token are all refused there', async () => {
    const slugged = { multiInstance: true, liveSlug: 'crew-of-ana' }
    await refused(await ask(`/crew-of-ana${PATH}`, DOOR_BEARER, slugged), 401)
    await refused(await ask(`/crew-of-ana${PATH}`, WALL, slugged), 401)
    await refused(await ask(`/crew-of-ana${PATH}`, null, slugged), 401)
  })
  it('a served crew’s slug goes to its own gate, which knows no gauges', async () => {
    const servedSlug = vi.fn(async () => false)
    await refused(await ask(`/ana-team${PATH}`, DOOR_BEARER, { multiInstance: true, servedSlug: servedSlug as unknown as MobileServerDeps['servedSlug'] }), 404)
    expect(servedSlug).toHaveBeenCalled()
  })
  it('a served door’s relay will not carry it at all', () => {
    expect(isDoorPath(PATH)).toBe(false)
  })
})

describe('the desktop window', () => {
  const channels = (): Map<string, (event: unknown) => unknown> => {
    const handlers = new Map<string, (event: unknown) => unknown>()
    registerZoomFleetIpc((channel, listener) => handlers.set(channel, listener), { service: () => null, authed: async () => ({ ok: false, reason: 'offline' }) as never, deviceId: () => null })
    return handlers
  }
  it('reads the same watch the phone reads, so two readers still share one sample', async () => {
    await expect(channels().get('zoom-fleet:gauges')?.({})).resolves.toEqual(READING)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('hears no reading when the sample failed, not a rejected invoke', async () => {
    read.mockRejectedValue(new Error('no'))
    await expect(channels().get('zoom-fleet:gauges')?.({})).resolves.toBeNull()
  })
})

describe('the seam', () => {
  it('the route rides the levels mount, so mobile-server.ts needs no new line', () => {
    const levels = readFileSync('src/main/levels/routes.ts', 'utf8')
    expect(levels).toMatch(/handleGaugeRoute\(/)
    expect(readFileSync('src/main/mobile-server.ts', 'utf8')).not.toMatch(/gauge/i)
  })
  it('the preload and both API surfaces carry it', () => {
    expect(readFileSync('src/preload/index.ts', 'utf8')).toMatch(/machineGauges: \(\) => ipcRenderer\.invoke\('zoom-fleet:gauges'\)/)
    expect(readFileSync('src/renderer/src/api.ts', 'utf8')).toMatch(/machineGauges\?: \(\) => Promise<unknown>/)
    expect(readFileSync('src/renderer/src/remote-api.ts', 'utf8')).toMatch(/apiPath\('\/api\/levels\/gauges'\)/)
  })
})
