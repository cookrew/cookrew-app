import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createCanvasBridge, loopbackDialer } from '../src/main/canvas-bridge'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { WatchPairing } from '../src/main/watch-pairing'
import { setWatchHost, type WatchHost } from '../src/main/watch-routes'

/**
 * THE WATCH, AWAY FROM HOME, END TO END.
 *
 * The real Swift client (watch-shots join) against the real registry, the real
 * relay and the real gate on the Mac's side: a phone asks for a code down the
 * relay, the watch spends it, claims the same code, reads cards, renews, forgets.
 * Two languages meet on this wire and nothing else checks that they agree.
 *
 * Opt in, since it needs the watch built:
 *   (cd watch && swift build --product watch-shots)
 *   WATCH_JOIN_E2E=1 npx vitest run tests/watch-join.integration.test.ts
 */

const BINARY = path.join(__dirname, '..', 'watch', '.build', 'debug', 'watch-shots')
const run = process.env.WATCH_JOIN_E2E === '1' && existsSync(BINARY) ? describe : describe.skip

const PASSWORD = 'correct horse battery staple'
const PAIRING = 'the-pairing-token-of-this-mac'

vi.mock('../src/main/board-index', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/board-index')>()
  return { ...actual, buildBoard: () => ({ rows: [], summary: {}, activeWorkspaceId: 'ws' }) }
})

interface Up {
  origin: string
  close: () => Promise<void>
}

const listen = async (server: Server): Promise<Up> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const jwkOf = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

const watch = (origin: string, code: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile(BINARY, [path.join(tmpdir(), 'watch-join-e2e'), 'join', origin, code], { timeout: 40_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`))
      else resolve(stdout.trim().split('\n'))
    })
  })

run('a watch away from home, on one code', () => {
  let site: Up
  let mac: Up
  /** Somebody else's machine on an address the watch remembers. */
  let stranger: Up
  const strangerHeard: { path: string; authorization?: string }[] = []
  /** Another, which answers a hello one byte at a time and never finishes. */
  let trickler: Up
  let dir = ''
  let token = ''
  let phone = ''
  let link: CanvasLink | null = null
  const username = 'owner'
  const deviceId = randomUUID()
  let pairing: WatchPairing

  const mint = async (current: string): Promise<Response> =>
    fetch(`${site.origin}/v2/me/join-codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current })
    })

  const host = (): WatchHost =>
    ({
      pairing,
      desktopName: () => 'This Mac',
      bases: () => [
        { kind: 'lan', url: stranger.origin },
        { kind: 'lan', url: trickler.origin },
        { kind: 'lan', url: mac.origin }
      ],
      canvas: () => ({ nodes: [], connections: [] }),
      accountKind: () => 'password',
      invite: async (current: string) => {
        const reply = await mint(current)
        const body = (await reply.json()) as { code?: string; expiresAt?: number; error?: string }
        return reply.status === 201 && body.code && body.expiresAt
          ? { ok: true, code: body.code, expiresAt: body.expiresAt }
          : { ok: false, reason: body.error ?? 'unknown' }
      }
    }) as unknown as WatchHost

  const invite = async (current: string): Promise<{ ok: boolean; code?: string; reason?: string }> => {
    const reply = await fetch(`${site.origin}/relay/@${username}/desktop/${deviceId}/api/watch/invite`, {
      method: 'POST',
      headers: { cookie: `__Host-cr_session=${phone}`, authorization: `Bearer ${PAIRING}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current })
    })
    expect(reply.status).toBe(200)
    return (await reply.json()) as { ok: boolean; code?: string; reason?: string }
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'watch-join-'))
    pairing = new WatchPairing({ file: path.join(dir, 'watch-token') })
    setWatchHost(host())
    const deps = {
      pairingToken: PAIRING,
      wallToken: 'wall',
      store: { focusedState: { nodes: [], connections: [] } },
      ptys: { get: () => undefined },
      turns: { list: () => [], seen: () => undefined },
      agents: { list: () => [] },
      ops: {},
      presets: [],
      board: { activeWorkspaceId: () => 'ws', live: () => [], ledger: () => new Map(), registry: () => [] },
      latestCheckpoint: async () => null
    } as unknown as MobileApiDeps
    stranger = await listen(
      createServer((request, response) => {
        strangerHeard.push({ path: request.url ?? '', authorization: request.headers.authorization })
        // Sent on to the real Mac, whose proof would pass if the watch followed.
        if (request.url?.startsWith('/api/watch/hello')) {
          response.writeHead(302, { location: `${mac.origin}${request.url}` })
          response.end()
          return
        }
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"Unauthorized"}')
      })
    )
    trickler = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        const drip = setInterval(() => response.write(' '), 200)
        response.on('close', () => clearInterval(drip))
      })
    )
    mac = await listen(
      createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        void handleMobileApi(request, response, url, deps).then((handled) => {
          if (handled) return
          response.writeHead(404)
          response.end()
        })
      })
    )
    site = await listen(
      createRegistry({
        store: new RegistryStore(dir),
        log: new TransparencyLog(dir),
        identity: new IdentityService(dir),
        doors: new DoorStore(dir, { allowPrivate: true }),
        stars: new StarStore(dir),
        origin: 'https://cookrew.dev',
        v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
      })
    )
    const claimed = await fetch(`${site.origin}/v2/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() } })
    })
    expect(claimed.status).toBe(201)
    token = ((await claimed.json()) as { session: { token: string } }).session.token
    await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
    })
    // The phone the owner carries: already in the account, by a code of its own.
    const code = ((await (await mint(PASSWORD)).json()) as { code: string }).code
    const joined = await fetch(`${site.origin}/v2/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: { id: randomUUID(), kind: 'phone', name: 'A phone', jwk: jwkOf() } })
    })
    expect(joined.status).toBe(201)
    phone = ((await joined.json()) as { token: string }).token

    link = createCanvasLink({ origin: () => site.origin, credential: () => ({ token, deviceId }) })
    const bridge = createCanvasBridge({ send: (line) => link!.send(line), dial: loopbackDialer(Number(new URL(mac.origin).port)) })
    link.onFrame(bridge.frame)
    link.onDrop(bridge.reset)
    link.start()
    const deadline = Date.now() + 4000
    while (!link.held()) {
      if (Date.now() > deadline) throw new Error('the desktop never held its line')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }, 20_000)

  afterAll(async () => {
    link?.stop()
    setWatchHost(null)
    await site.close()
    await mac.close()
    await stranger.close()
    await trickler.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a wrong password from the phone arms nothing', async () => {
    expect(await invite('not the password')).toEqual({ ok: false, reason: 'bad_credentials' })
    expect(pairing.pending()).toBeNull()
  })

  it('a code nobody minted gets nowhere', async () => {
    expect(await watch(site.origin, 'AAAA-AAAA')).toEqual(['step joining', 'failed failed(CookrewCore.JoinFailure.wrongCode)'])
  })

  it('one code from the phone, and the watch does the rest down the relay', async () => {
    const invited = await invite(PASSWORD)
    expect(invited.ok).toBe(true)
    const lines = await watch(site.origin, invited.code as string)
    expect(lines.slice(0, 10)).toEqual([
      'step joining',
      'step finding',
      'paired This Mac as owner',
      'bases lan,lan,lan,relay',
      'cards 0 line relay',
      'cards-home 0 line direct',
      'renewed true true',
      'cards-after-renew 0',
      'unpaired',
      'stopped unpaired'
    ])
    // The Mac spent its copy on the first claim: the same code does not pair twice.
    expect(lines[10]).toContain('ended')
    expect(lines[11]).toBe('session-ended signedOut')
    // The stranger was asked for proof, had none, and never saw the token.
    expect(strangerHeard.length).toBeGreaterThan(0)
    expect(strangerHeard.every((heard) => heard.path.startsWith('/api/watch/hello') && !heard.authorization)).toBe(true)
    expect(pairing.paired).toBe(false)
  }, 60_000)
})
