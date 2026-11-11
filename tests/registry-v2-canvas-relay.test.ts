import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { BRIDGE_MAX_OPEN } from '../src/main/canvas-bridge'
import {
  EXCHANGES_PER_LINK,
  allowedRequestHeaders,
  callerDeviceHeaders,
  CANVAS_DEVICE_HEADER,
  CANVAS_DEVICE_NAME_HEADER,
  canvasName,
  createCanvasRelay,
  crossSite,
  isCanvasName,
  isPageType,
  relayAnswerHeaders,
  headerSafeName,
  type CanvasRelay
} from '../registry/src/v2-canvas-relay'
import { RELAY_MACHINE_HEADER, RELAY_ROUTE_HEADER, RELAY_SESSION_HEADER, isRelayedRoute, machineRelayPath } from '../src/shared/machine-relay'
import { decodeFrame, encodeFrame } from '../src/shared/relay-frame'

/**
 * IDENTITY v2, PHASE 3 — THE PRIVATE RELAY SESSION, over real HTTP.
 *
 * A desktop holds a line for its own canvas; a phone of the same account
 * reaches it through cookrew.dev. Everything here is the REGISTRY half: who
 * may hold a line, who may use one, and what cookrew.dev does and does not
 * pass on. The desktop is a fake — a tiny mobile server on loopback with a
 * bridge that speaks frames — because the app half is written next.
 *
 * The rules under test are the ones that would be quiet if broken: the line
 * belongs to the desktop that signed in, the relay path (/api/m/<machine>)
 * belongs to the account its session names, the account session never
 * crosses, and nothing a machine answers can run, redirect or set a cookie on
 * the origin it is read from.
 */

const PASSWORD = 'correct horse battery staple'

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

// ── the desktop's mobile server, which knows nothing about any relay ───────

/**
 * What a canvas looks like from the outside: an echo, a stream, some bytes and
 * two cookies — one ordinary, one trying to escape its path.
 */
const mobileServer = (): Server =>
  createServer((request, response) => {
    // A machine's API lives under /api, and only that crosses: the routes below are named without it.
    const url = new URL((request.url ?? '/').replace(/^\/api(?=[/?]|$)/, '') || '/', 'http://mobile.local')
    if (url.pathname === '/page') {
      // A page, which a machine must never be able to put on the relay's origin.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><script>fetch("/v2/me")</script>')
      return
    }
    if (url.pathname === '/typed') {
      response.writeHead(200, { 'content-type': url.searchParams.get('as') ?? 'text/plain' })
      response.end('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
      return
    }
    if (url.pathname === '/grabby') {
      // Everything a machine might send to get a hold on the origin it is read from.
      response.writeHead(200, {
        'content-type': 'application/json',
        etag: '"v7"',
        'service-worker-allowed': '/',
        refresh: '0; url=https://evil.example/',
        location: 'https://evil.example/',
        'clear-site-data': '"storage"',
        link: '</x.js>; rel=preload; as=script',
        'content-security-policy': "script-src 'unsafe-inline' *",
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
        'set-cookie': 'grab=1; Path=/'
      })
      response.end('{}')
      return
    }
    if (url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: one\n\n')
      setTimeout(() => response.write('data: two\n\n'), 30)
      return
    }
    if (url.pathname === '/redirect') {
      // Whatever the test asked to be sent back, verbatim — the three shapes a
      // desktop actually answers with are exercised through this one route.
      response.writeHead(Number(url.searchParams.get('code') ?? 303), {
        location: url.searchParams.get('to') ?? '/'
      })
      response.end()
      return
    }
    if (url.pathname === '/refresh') {
      response.writeHead(200, { 'content-type': 'text/plain', refresh: '5; url=/board' })
      response.end('later')
      return
    }
    if (url.pathname === '/hang') {
      // Never answers. A desktop that has stopped without closing anything.
      return
    }
    if (url.pathname === '/stall') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('first')
      return
    }
    if (url.pathname.endsWith('/assets-with-cookie.js')) {
      // An asset answer that also sets a cookie: per reader, so never kept.
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable',
        'set-cookie': 'cr_companion=abc; Path=/'
      })
      response.end('export const y = 2')
      return
    }
    if (url.pathname.endsWith('/assets-origin-only.js')) {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable',
        vary: 'origin'
      })
      response.end('export const w = 4')
      return
    }
    if (url.pathname.endsWith('/assets-with-vary.js')) {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable',
        vary: 'accept-encoding, origin'
      })
      response.end('export const z = 3')
      return
    }
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/nested/assets/')) {
      // A hash-named bundle asset: the companion says it can be kept forever.
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable'
      })
      response.end('export const x = 1')
      return
    }
    if (url.pathname === '/immutable-api') {
      // An API answer that CLAIMS immutability is not under /assets/: private.
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, immutable' })
      response.end('{}')
      return
    }
    if (url.pathname === '/bytes') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['canvas=yes; Path=/; HttpOnly', 'wide=1; Path=/me; Domain=cookrew.dev']
      })
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          headers: request.headers,
          bodyBytes: body.byteLength,
          bodyHead: body.subarray(0, 16).toString('utf8')
        })
      )
    })
  })

// ── the fake desktop: two long requests, and a bridge between them ────────

interface Linked {
  ready: Promise<string>
  /** Has the relay ended the downlink? */
  ended: () => boolean
  close: () => void
}

/**
 * The desktop half, as the app will have to build it: a GET whose response
 * streams requests down, a POST whose body streams answers up, a pong for
 * every ping, and base64 in both directions.
 */
function linkDesktop(relayOrigin: string, token: string, deviceId: string, mobileOrigin: string): Linked {
  const target = new URL(mobileOrigin)
  let settle: (name: string) => void = () => undefined
  const ready = new Promise<string>((resolve) => {
    settle = resolve
  })
  const headers = { authorization: `Bearer ${token}` }
  const address = `${relayOrigin}/v2/canvas/link/${deviceId}`
  const up = httpRequest(address, { method: 'POST', headers }, () => undefined)
  const send = (line: string): void => {
    if (!up.writableEnded) up.write(`${line}\n`)
  }
  /** Request bodies still arriving, by stream id. */
  const bodies = new Map<string, Buffer[]>()

  const answer = (id: string, method: string, path: string, sent: Record<string, string>, body: Buffer): void => {
    const call = httpRequest(
      { hostname: target.hostname, port: target.port, path, method, headers: sent },
      (res) => {
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) out[key] = value.join(key === 'set-cookie' ? '\n' : ', ')
          else if (typeof value === 'string') out[key] = value
        }
        send(encodeFrame({ t: 'head', id, status: res.statusCode ?? 200, headers: out }))
        res.on('data', (chunk: Buffer) => send(encodeFrame({ t: 'chunk', id, data: chunk.toString('base64') })))
        res.on('end', () => send(encodeFrame({ t: 'end', id })))
      }
    )
    call.on('error', () => send(encodeFrame({ t: 'abort', id, reason: 'mobile-server-failed' })))
    if (body.byteLength > 0) call.write(body)
    call.end()
  }

  const opens = new Map<string, { method: string; path: string; headers: Record<string, string> }>()
  let hungUp = false
  const down = httpRequest(address, { method: 'GET', headers }, (res) => {
    let buffer = ''
    res.on('close', () => {
      hungUp = true
    })
    res.setEncoding('utf8')
    res.on('data', (text: string) => {
      buffer += text
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        if (line.length === 0) continue
        const frame = decodeFrame(line)
        if (!frame) continue
        if (frame.t === 'ready') settle(frame.name)
        else if (frame.t === 'ping') send(encodeFrame({ t: 'pong', at: frame.at }))
        else if (frame.t === 'open') {
          opens.set(frame.id, { method: frame.method, path: frame.path, headers: frame.headers })
          bodies.set(frame.id, [])
        } else if (frame.t === 'body') {
          const held = bodies.get(frame.id)
          if (!held) continue
          held.push(Buffer.from(frame.data, 'base64'))
          if (frame.done === true) {
            const opened = opens.get(frame.id)
            bodies.delete(frame.id)
            opens.delete(frame.id)
            if (opened) answer(frame.id, opened.method, opened.path, opened.headers, Buffer.concat(held))
          }
        }
      }
    })
  })
  down.on('error', () => undefined)
  up.on('error', () => undefined)
  down.end()
  return {
    ready,
    ended: () => hungUp,
    close: () => {
      up.destroy()
      down.destroy()
    }
  }
}

/** Wait for a condition, so a test never races a network. */
async function until(what: () => boolean | Promise<boolean>, why: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── the account, its desktop and a phone of the same account ──────────────

let site: Up
let mobile: Up
let dir = ''
let username = ''
let deviceId = ''
let desktopToken = ''
let phoneSession = ''
let phoneDeviceId = ''
let phoneDeviceName = ''
let strangerSession = ''
let desktop: Linked | null = null

const jwkOf = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

async function claim(name: string, kind: 'desktop' | 'phone'): Promise<{ id: string; token: string }> {
  const id = randomUUID()
  const res = await fetch(`${site.origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: PASSWORD, device: { id, kind, name: 'A machine', jwk: jwkOf() } })
  })
  expect(res.status).toBe(201)
  return { id, token: ((await res.json()) as { session: { token: string } }).session.token }
}

async function attach(
  name: string,
  kind: 'phone' | 'browser' | 'desktop',
  approver: string
): Promise<{ id: string; token: string }> {
  const id = randomUUID()
  const res = await fetch(`${site.origin}/v2/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: name,
      password: PASSWORD,
      device: { id, kind, name: 'Another machine', jwk: jwkOf() }
    })
  })
  // Phase 4: a device the account has never seen climbs one rung — the first
  // device approves it, driven over the wire here.
  expect(res.status).toBe(401)
  const asked = (await res.json()) as { pending: string; match: string }
  const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
  expect(request.status).toBe(202)
  const { approval } = (await request.json()) as { approval: string }
  const decided = await fetch(`${site.origin}/v2/me/approvals/${approval}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
    body: JSON.stringify({ decision: 'approve', match: asked.match })
  })
  expect(decided.status).toBe(204)
  const done = await fetch(`${site.origin}/v2/sessions/${asked.pending}`)
  expect(done.status).toBe(201)
  return { id, token: ((await done.json()) as { token: string }).token }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-canvas-relay-'))
  mobile = await listen(mobileServer())
  site = await listen(
    createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      origin: 'https://cookrew.dev',
      v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
    })
  )
  username = 'owner'
  const claimed = await claim(username, 'desktop')
  deviceId = claimed.id
  desktopToken = claimed.token
  await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${desktopToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
  })
  const phone = await attach(username, 'phone', desktopToken)
  phoneSession = phone.token
  phoneDeviceId = phone.id
  // What `attach` names every device it makes; the header must carry it.
  phoneDeviceName = 'Another machine'
  const stranger = await claim('stranger', 'desktop')
  strangerSession = (await attach('stranger', 'phone', stranger.token)).token

  desktop = linkDesktop(site.origin, desktopToken, deviceId, mobile.origin)
  await desktop.ready
})

afterAll(async () => {
  desktop?.close()
  await site.close()
  await mobile.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The machine's API under the relay path: every route here begins `api/`, which is all that crosses. */
const prefix = (): string => `/api/m/${deviceId}/api`
const asPhone = (headers: Record<string, string> = {}): Record<string, string> => ({
  [RELAY_SESSION_HEADER]: phoneSession,
  ...headers
})

describe('the second namespace', () => {
  it('is a desktop of an account, and never a door', () => {
    expect(isCanvasName(canvasName('drej', '11111111-2222-3333-4444-555555555555'))).toBe(true)
    expect(isCanvasName('@drej/alpha')).toBe(false)
    expect(isCanvasName('@drej/desktop/not-a-uuid')).toBe(false)
    expect(isCanvasName('@Drej/desktop/11111111-2222-3333-4444-555555555555')).toBe(false)
    expect(isCanvasName('@drej/desktop/11111111-2222-3333-4444-555555555555/extra')).toBe(false)
  })
})

// ── who may hold a line ──────────────────────────────────────────────────

describe('the canvas link, and who may open one', () => {
  it('refuses a downlink with no session at all', async () => {
    const res = await fetch(`${site.origin}/v2/canvas/link/${deviceId}`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('unauthenticated')
  })

  it('refuses a session of another device of the same account', async () => {
    const res = await fetch(`${site.origin}/v2/canvas/link/${deviceId}`, {
      headers: { authorization: `Bearer ${phoneSession}` }
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('not_this_device')
  })

  it('refuses a device id that is not this token’s, however well the token verifies', async () => {
    const res = await fetch(`${site.origin}/v2/canvas/link/${randomUUID()}`, {
      headers: { authorization: `Bearer ${desktopToken}` }
    })
    expect(res.status).toBe(403)
  })

  it('ends the line when the account is deleted, and it cannot be dialled again', async () => {
    const mac = await claim('goes-away', 'desktop')
    const filed = await fetch(`${site.origin}/v2/me/desktops/${mac.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mac.token}` },
      body: JSON.stringify({ name: 'Studio', workspaces: [] })
    })
    expect(filed.status).toBe(204)
    const line = linkDesktop(site.origin, mac.token, mac.id, mobile.origin)
    await line.ready
    const status = (): Promise<Response> =>
      fetch(`${site.origin}/v2/me/desktops/${mac.id}/relay-status`, { headers: { authorization: `Bearer ${mac.token}` } })
    expect(await (await status()).json()).toEqual({ live: true })
    const gone = await fetch(`${site.origin}/v2/me`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mac.token}` },
      body: JSON.stringify({ confirm: 'goes-away', current: PASSWORD })
    })
    expect(gone.status).toBe(204)
    await until(() => line.ended(), 'the downlink to end')
    expect((await status()).status).toBe(401)
    line.close()
  })

  it('refuses an uplink for a name nobody is holding a downlink for', async () => {
    const other = await claim('lonely', 'desktop')
    const res = await fetch(`${site.origin}/v2/canvas/link/${other.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.token}` },
      body: ''
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('no_link')
  })

  it('refuses a SECOND line on a name already held, rather than taking it over', async () => {
    const res = await fetch(`${site.origin}/v2/canvas/link/${deviceId}`, {
      headers: { authorization: `Bearer ${desktopToken}` }
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"t":"abort"')
    expect(text).toContain('name-taken')
    // The line that was already there is untouched.
    expect(await relayStatus()).toEqual({ live: true })
  })
})

// ── is that Mac there ────────────────────────────────────────────────────

const relayStatus = async (
  id: string = deviceId,
  session: string = phoneSession
): Promise<{ live?: boolean; error?: string }> => {
  const res = await fetch(`${site.origin}/v2/me/desktops/${id}/relay-status`, {
    headers: { cookie: `__Host-cr_session=${session}` }
  })
  const body = (await res.json()) as { live?: boolean; error?: string }
  return body.error === undefined ? { live: body.live } : { error: body.error }
}

describe('GET /v2/me/desktops/:id/relay-status', () => {
  it('says live for a desktop of this account that is holding a line', async () => {
    expect(await relayStatus()).toEqual({ live: true })
  })

  it('says nothing at all about a device that is not this account’s desktop', async () => {
    expect(await relayStatus(randomUUID())).toEqual({ error: 'not_found' })
    expect(await relayStatus(deviceId, strangerSession)).toEqual({ error: 'not_found' })
  })

  it('needs a session', async () => {
    const res = await fetch(`${site.origin}/v2/me/desktops/${deviceId}/relay-status`)
    expect(res.status).toBe(401)
  })
})

// ── who may use the line ─────────────────────────────────────────────────

describe('/api/m/:machine — who is admitted', () => {
  it('needs a session, and says so in JSON whatever the reader accepts', async () => {
    for (const accept of ['text/html', 'application/json']) {
      const res = await fetch(`${site.origin}${prefix()}/`, { headers: { accept } })
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(((await res.json()) as { error: string }).error).toBe('unauthenticated')
    }
  })

  it('takes the session from its own header and from nowhere else', async () => {
    // A cookie admits nobody: another site can make a browser send one.
    const cookie = await fetch(`${site.origin}${prefix()}/`, { headers: { cookie: `__Host-cr_session=${phoneSession}` } })
    expect(cookie.status).toBe(401)
    await cookie.arrayBuffer()
    // Authorization is the caller's credential at the MACHINE, never read here.
    const bearer = await fetch(`${site.origin}${prefix()}/`, { headers: { authorization: `Bearer ${phoneSession}` } })
    expect(bearer.status).toBe(401)
    await bearer.arrayBuffer()
  })

  it('reads as not-there for a machine of another account, so it cannot be used to find machines', async () => {
    const res = await fetch(`${site.origin}${prefix()}/`, { headers: { [RELAY_SESSION_HEADER]: strangerSession } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_found')
    const unknown = await fetch(`${site.origin}/api/m/${randomUUID()}/api/`, { headers: asPhone() })
    expect(unknown.status).toBe(404)
    await unknown.arrayBuffer()
  })

  it('names the account from the session: nothing in the address chooses whose machine', async () => {
    // The stranger's own session with the owner's machine id is the stranger's account, where no such machine is.
    const res = await fetch(`${site.origin}/api/m/${deviceId}/api/fleet`, { headers: { [RELAY_SESSION_HEADER]: strangerSession } })
    expect(res.status).toBe(404)
    await res.arrayBuffer()
  })

  it('refuses a machine id that is not one', async () => {
    for (const id of ['not-a-uuid', '..', `${deviceId}x`]) {
      const res = await fetch(`${site.origin}/api/m/${encodeURIComponent(id)}/api/fleet`, { headers: asPhone() })
      expect(res.status, id).toBe(404)
      await res.arrayBuffer()
    }
  })

  it('refuses a route with an encoded separator or dot before the machine is asked', async () => {
    const before = (await echo('/', { headers: asPhone() })).res.status
    expect(before).toBe(200)
    // Sent raw: fetch would tidy these away, and the point is the request that does not.
    const raw = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const target = new URL(site.origin)
        const asked = httpRequest({ host: target.hostname, port: target.port, path, method: 'GET', headers: asPhone() }, (answer) => {
          answer.resume()
          answer.on('end', () => resolve(answer.statusCode ?? 0))
        })
        asked.on('error', reject)
        asked.end()
      })
    for (const route of ['api/..%2Fsecrets', 'api/%2e%2e%2Fsecrets', 'api/x%5C..%5Csecrets']) {
      expect(await raw(`/api/m/${deviceId}/${route}`), route).toBe(404)
    }
  })

  it('carries a machine’s API and nothing above it', async () => {
    for (const route of ['', 'index.html', 'assets/index-abc.js', 'apiary', 'api/../secrets']) {
      const res = await fetch(`${site.origin}/api/m/${deviceId}/${route}`, { headers: asPhone() })
      expect(res.status, route).toBe(404)
      await res.arrayBuffer()
    }
  })

  it('says so plainly when the machine is holding no line', async () => {
    const asleep = await claim('sleeper', 'desktop')
    await fetch(`${site.origin}/v2/me/desktops/${asleep.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${asleep.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Asleep', workspaces: [] })
    })
    const session = (await attach('sleeper', 'phone', asleep.token)).token
    const res = await fetch(`${site.origin}/api/m/${asleep.id}/api/fleet`, { headers: { [RELAY_SESSION_HEADER]: session } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('no_link')
  })
})

// ── what crosses ─────────────────────────────────────────────────────────

interface Echo {
  method: string
  path: string
  headers: Record<string, string>
  bodyBytes: number
  bodyHead: string
}

const echo = async (path: string, init: RequestInit = {}): Promise<{ res: Response; body: Echo }> => {
  const res = await fetch(`${site.origin}${prefix()}${path}`, init)
  return { res, body: (await res.json()) as Echo }
}

describe('a device of the account, reaching its own machine', () => {
  it('forwards the route and its query as they stand, under the machine’s own root', async () => {
    const { res, body } = await echo('/workspaces?limit=2', { headers: asPhone() })
    expect(res.status).toBe(200)
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/api/workspaces?limit=2')
    // Streamed, so the machine's own length is not repeated as a promise this side cannot keep.
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('takes every method the machine answers to', async () => {
    const { body } = await echo('/thing', {
      method: 'POST',
      headers: asPhone({ 'content-type': 'application/json' }),
      body: JSON.stringify({ hello: 'there' })
    })
    expect(body.method).toBe('POST')
    expect(body.bodyHead).toContain('hello')
  })

  it('carries only the allow-listed headers, and never the reader’s network', async () => {
    const { body } = await echo('/', {
      headers: asPhone({
        accept: 'application/json',
        'x-cookrew-app': 'companion',
        'x-forwarded-for': '203.0.113.9',
        'accept-language': 'en-GB',
        // The caller's own, for that machine: it crosses unread.
        authorization: 'Bearer a-token-of-the-callers-own-at-that-machine'
      })
    })
    expect(body.headers['x-cookrew-app']).toBe('companion')
    expect(body.headers.accept).toBe('application/json')
    expect(body.headers['x-forwarded-for']).toBeUndefined()
    expect(body.headers.authorization).toBe('Bearer a-token-of-the-callers-own-at-that-machine')
    expect(body.headers['accept-language']).toBeUndefined()
  })

  it('NEVER hands the machine the account session, nor any cookie', async () => {
    const { body } = await echo('/', { headers: asPhone({ cookie: 'canvas=yes; cr_account=v1token' }) })
    expect(body.headers[RELAY_SESSION_HEADER]).toBeUndefined()
    expect(body.headers.cookie).toBeUndefined()
    expect(JSON.stringify(body.headers)).not.toContain(phoneSession)
  })

  it('tells the machine it is not being served under any prefix', async () => {
    const { body } = await echo('/', { headers: asPhone({ 'x-cookrew-base': '/relay/@somebody/desktop/elsewhere' }) })
    expect(body.headers['x-cookrew-base']).toBeUndefined()
  })

  it('tells the machine which device of the account is asking, from the session', async () => {
    const { body } = await echo('/', {
      headers: asPhone({
        [CANVAS_DEVICE_HEADER]: '00000000-0000-4000-8000-000000000000',
        [CANVAS_DEVICE_NAME_HEADER]: "The owner's own Mac"
      })
    })
    expect(body.headers[CANVAS_DEVICE_HEADER]).toBe(phoneDeviceId)
    expect(body.headers[CANVAS_DEVICE_NAME_HEADER]).toBe(phoneDeviceName)
  })

  it('carries the reader’s accept-encoding, so the machine may compress its answer', async () => {
    const { body } = await echo('/workspace', { headers: asPhone({ 'accept-encoding': 'br, gzip' }) })
    expect(body.headers['accept-encoding']).toBe('br, gzip')
  })

  it('carries bytes that are not text, unmangled', async () => {
    const res = await fetch(`${site.origin}${prefix()}/bytes`, { headers: asPhone() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 250, 251, 252, 253, 254, 255])
  })

  it('carries a body larger than one frame, whole', async () => {
    const payload = 'x'.repeat(900 * 1024)
    const { body } = await echo('/upload', {
      method: 'POST',
      headers: asPhone({ 'content-type': 'text/plain' }),
      body: payload
    })
    expect(body.bodyBytes).toBe(payload.length)
  })

  it('refuses a body past the four-megabyte bound rather than buffering it', async () => {
    const res = await fetch(`${site.origin}${prefix()}/upload`, {
      method: 'POST',
      headers: asPhone({ 'content-type': 'application/octet-stream' }),
      body: Buffer.alloc(5 * 1024 * 1024)
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('too_large')
  })

  it('holds an SSE stream open and lets each event through as it happens', async () => {
    const control = new AbortController()
    const res = await fetch(`${site.origin}${prefix()}/events`, {
      headers: asPhone({ accept: 'text/event-stream' }),
      signal: control.signal
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const seen: string[] = []
    while (seen.join('').includes('two') === false) {
      const next = await reader.read()
      if (next.done) break
      seen.push(new TextDecoder().decode(next.value))
    }
    expect(seen.join('')).toContain('data: one')
    expect(seen.join('')).toContain('data: two')
    control.abort()
  })
})

// ── the one address (latency 0.6.1) ──────────────────────────────────────

/** The console's way: every call at `/api/m`, the machine and the route in headers. */
const atOne = (route: string, init: RequestInit & { headers?: Record<string, string> } = {}, machine = deviceId): Promise<Response> =>
  fetch(`${site.origin}/api/m`, { ...init, headers: { ...asPhone(init.headers ?? {}), [RELAY_MACHINE_HEADER]: machine, [RELAY_ROUTE_HEADER]: route } })

describe('/api/m — one address for every call, so a browser asks its preflight once', () => {
  it('reaches the machine at the route and query the header names, exactly as the path form does', async () => {
    const res = await atOne('api/workspaces?limit=2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Echo
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/api/workspaces?limit=2')
    const { body: pathForm } = await echo('/workspaces?limit=2', { headers: asPhone() })
    expect(body.path).toBe(pathForm.path)
  })

  it('carries a body and every method', async () => {
    const res = await atOne('api/thing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'there' }) })
    const body = (await res.json()) as Echo
    expect(body.method).toBe('PUT')
    expect(body.bodyHead).toContain('hello')
  })

  it('keeps its two headers for itself: the machine is told neither', async () => {
    const body = (await (await atOne('api/')).json()) as Echo
    expect(body.headers[RELAY_MACHINE_HEADER]).toBeUndefined()
    expect(body.headers[RELAY_ROUTE_HEADER]).toBeUndefined()
    expect(body.headers[RELAY_SESSION_HEADER]).toBeUndefined()
    expect(body.headers[CANVAS_DEVICE_HEADER]).toBe(phoneDeviceId)
  })

  it('holds an SSE stream open through it', async () => {
    const control = new AbortController()
    const res = await atOne('api/events', { headers: { accept: 'text/event-stream' }, signal: control.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let seen = ''
    while (!seen.includes('two')) {
      const next = await reader.read()
      if (next.done) break
      seen += new TextDecoder().decode(next.value)
    }
    expect(seen).toContain('data: two')
    control.abort()
  })

  it('admits exactly whom the path form admits', async () => {
    const none = await fetch(`${site.origin}/api/m`, { headers: { [RELAY_MACHINE_HEADER]: deviceId, [RELAY_ROUTE_HEADER]: 'api/fleet' } })
    expect(none.status).toBe(401)
    await none.arrayBuffer()
    const stranger = await fetch(`${site.origin}/api/m`, { headers: { [RELAY_SESSION_HEADER]: strangerSession, [RELAY_MACHINE_HEADER]: deviceId, [RELAY_ROUTE_HEADER]: 'api/fleet' } })
    expect(stranger.status).toBe(404)
    expect(((await stranger.json()) as { error: string }).error).toBe('not_found')
    const unknown = await atOne('api/fleet', {}, randomUUID())
    expect(unknown.status).toBe(404)
    await unknown.arrayBuffer()
  })

  it('refuses whatever the path form refuses, before the machine is asked', async () => {
    const before = (await (await atOne('api/')).json()) as Echo
    expect(before.method).toBe('GET')
    for (const route of ['', 'index.html', 'apiary', 'api/../v2/me', 'api/..%2Fsecrets', 'api/%2e%2e%2Fsecrets', 'api\\..\\secrets', '../../v2/me', 'api/fleet#x']) {
      const res = await atOne(route)
      expect(res.status, route).toBe(404)
      await res.arrayBuffer()
    }
    for (const machine of ['not-a-uuid', '..', `${deviceId}/api`]) {
      const res = await atOne('api/fleet', {}, machine)
      expect(res.status, machine).toBe(404)
      await res.arrayBuffer()
    }
  })

  it('takes no query of its own and no half of the pair', async () => {
    const queried = await fetch(`${site.origin}/api/m?route=api/fleet`, { headers: { ...asPhone(), [RELAY_MACHINE_HEADER]: deviceId, [RELAY_ROUTE_HEADER]: 'api/fleet' } })
    expect(queried.status).toBe(404)
    await queried.arrayBuffer()
    const half = await fetch(`${site.origin}/api/m`, { headers: { ...asPhone(), [RELAY_ROUTE_HEADER]: 'api/fleet' } })
    expect(half.status).toBe(404)
    await half.arrayBuffer()
  })
})

// ── a machine's bytes never run, and never set anything, on this origin ────

describe('what a machine’s answer may do here', () => {
  it('answers under a sandbox, typed as it says and never sniffed', async () => {
    const { res } = await echo('/', { headers: asPhone() })
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('drops every cookie a machine sets', async () => {
    const { res } = await echo('/', { headers: asPhone() })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('never passes a page: an HTML answer is refused whole', async () => {
    const res = await fetch(`${site.origin}${prefix()}/page`, { headers: asPhone() })
    expect(res.status).toBe(502)
    const body = await res.text()
    expect(JSON.parse(body).error).toBe('not_an_api')
    expect(body).not.toContain('<script>')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('refuses the page types a browser would also run', async () => {
    for (const type of ['application/xhtml+xml', 'image/svg+xml', 'text/xml', 'TEXT/HTML; charset=utf-8']) {
      const res = await fetch(`${site.origin}${prefix()}/typed?as=${encodeURIComponent(type)}`, { headers: asPhone() })
      expect(res.status, type).toBe(502)
      await res.arrayBuffer()
    }
  })

  it('never follows a machine somewhere else: a redirect is refused, with no Location', async () => {
    const res = await fetch(`${site.origin}${prefix()}/redirect?code=303&to=${encodeURIComponent('https://evil.example/')}`, {
      headers: asPhone(),
      redirect: 'manual'
    })
    expect(res.status).toBe(502)
    expect(res.headers.get('location')).toBeNull()
    expect(((await res.json()) as { error: string }).error).toBe('not_an_api')
  })

  it('strips the headers that would give a machine a hold on this origin', async () => {
    const res = await fetch(`${site.origin}${prefix()}/grabby`, { headers: asPhone() })
    expect(res.status).toBe(200)
    for (const name of ['service-worker-allowed', 'refresh', 'location', 'set-cookie', 'clear-site-data', 'link', 'access-control-allow-origin', 'access-control-allow-credentials']) {
      expect(res.headers.get(name), name).toBeNull()
    }
    // Its own policy is replaced by ours, never merged with it.
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'")
    await res.arrayBuffer()
  })

  it('keeps what a reader needs: the type, the encoding and a validator', async () => {
    const res = await fetch(`${site.origin}${prefix()}/grabby`, { headers: asPhone() })
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('etag')).toBe('"v7"')
    await res.arrayBuffer()
  })
})

// ── which pages may ask ──────────────────────────────────────────────────

describe('which origin may call the relay path', () => {
  it('takes a caller that is not a browser: no Origin at all', async () => {
    const { res } = await echo('/', { headers: asPhone() })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses a page of any other origin, session or not, before the machine is asked', async () => {
    for (const origin of ['https://evil.example', 'https://cookrew.dev', 'https://console.cookrew.dev.evil.example', 'null']) {
      const res = await fetch(`${site.origin}${prefix()}/thing`, { method: 'POST', headers: asPhone({ origin }), body: '{}' })
      expect(res.status, origin).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('answers no preflight for an origin it does not serve', async () => {
    const res = await fetch(`${site.origin}${prefix()}/thing`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-cookrew-session' }
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    await res.arrayBuffer()
  })
})

describe('the console’s origin, on a registry that serves one', () => {
  const CONSOLE = 'https://console.cookrew.dev'
  let split: { origin: string; relay: CanvasRelay; desktop: Linked; close: () => Promise<void> }

  beforeAll(async () => {
    split = await standBare({}, { consoleOrigin: CONSOLE })
  })
  afterAll(async () => {
    await split.close()
  })

  it('answers the console’s preflight itself, without a session and without the machine', async () => {
    const before = split.relay.stats().opened
    const res = await fetch(`${split.origin}${prefix()}/thing`, {
      method: 'OPTIONS',
      headers: { origin: CONSOLE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, x-cookrew-session, content-type' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE)
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type, if-none-match, last-event-id, x-cookrew-session, x-cookrew-machine, x-cookrew-route')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('vary')).toContain('origin')
    expect(split.relay.stats().opened).toBe(before)
  })

  it('answers the preflight of the one address the same way, and lets the console read what it carries', async () => {
    const pre = await fetch(`${split.origin}/api/m`, {
      method: 'OPTIONS',
      headers: { origin: CONSOLE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization, x-cookrew-session, x-cookrew-machine, x-cookrew-route' }
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(CONSOLE)
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-cookrew-route')
    const res = await fetch(`${split.origin}/api/m`, { headers: asPhone({ origin: CONSOLE, [RELAY_MACHINE_HEADER]: deviceId, [RELAY_ROUTE_HEADER]: 'api/' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE)
    await res.arrayBuffer()
    const other = await fetch(`${split.origin}/api/m`, { headers: asPhone({ origin: 'https://cookrew.dev', [RELAY_MACHINE_HEADER]: deviceId, [RELAY_ROUTE_HEADER]: 'api/' }) })
    expect(other.status).toBe(403)
    await other.arrayBuffer()
  })

  it('lets the console read the answer, and nobody else', async () => {
    const res = await fetch(`${split.origin}${prefix()}/`, { headers: asPhone({ origin: CONSOLE }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE)
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('vary')).toContain('origin')
    await res.arrayBuffer()
    const other = await fetch(`${split.origin}${prefix()}/`, { headers: asPhone({ origin: 'https://cookrew.dev' }) })
    expect(other.status).toBe(403)
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    await other.arrayBuffer()
  })

  it('lets the console read a refusal too, so a signed-out page can say so', async () => {
    const res = await fetch(`${split.origin}${prefix()}/`, { headers: { origin: CONSOLE } })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE)
    await res.arrayBuffer()
  })
})

// ── the bounds, because anyone can claim a username ──────────────────────

/**
 * A relay of its own, with the bounds turned down far enough to reach in a
 * test. Everything else is the shipping code: the same hub, the same gate.
 */
async function standBare(
  bounds: Partial<Parameters<typeof createCanvasRelay>[0]> = {},
  identity: Parameters<typeof createV2>[1] = {}
): Promise<{ origin: string; relay: CanvasRelay; desktop: Linked; close: () => Promise<void> }> {
  const relay = createCanvasRelay({
    v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 }, ...identity }),
    ...bounds
  })
  const up = await listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://relay.local')
      const parts = url.pathname.split('/').filter(Boolean)
      if (relay.handle(request, response, parts, url)) return
      response.writeHead(404).end()
    })
  )
  const linked = linkDesktop(up.origin, desktopToken, deviceId, mobile.origin)
  await linked.ready
  return {
    origin: up.origin,
    relay,
    desktop: linked,
    close: async () => {
      linked.close()
      relay.stop()
      await up.close()
    }
  }
}

describe('what one account may make this process hold', () => {
  it('carries a whole page boot at once: as many exchanges as the machine’s own bridge takes (latency 0.6.1)', async () => {
    // 2026-11-11: a burst of 20 reads at Solis-Core got 4 `too_many_exchanges` at 16, though
    // the machine answered each in ~6 ms, and the console waits a second before asking again.
    // A console boot asks ~20 things at once; the machine's bridge takes 64.
    expect(EXCHANGES_PER_LINK).toBe(BRIDGE_MAX_OPEN)
    const results = await Promise.all(Array.from({ length: 40 }, () => echo('/', { headers: asPhone() }).then(({ res }) => res.status)))
    expect(results.filter((status) => status === 200)).toHaveLength(40)
  })

  it('carries only so many exchanges on one line, and says so in a sentence', async () => {
    const bare = await standBare({ exchangesPerLink: 2 })
    const stop = new AbortController()
    // Two that never come back, which is what a stopped Mac looks like.
    const held = [1, 2].map(() =>
      fetch(`${bare.origin}${prefix()}/hang`, { headers: asPhone(), signal: stop.signal }).catch(() => null)
    )
    await until(() => bare.relay.stats().open === 2, 'both exchanges to be in flight')
    const third = await fetch(`${bare.origin}${prefix()}/hang`, { headers: asPhone({ accept: 'application/json' }) })
    expect(third.status).toBe(503)
    const body = (await third.json()) as { error: string; message: string }
    expect(body.error).toBe('too_many_exchanges')
    expect(body.message).toContain('2 requests')
    stop.abort()
    await Promise.all(held)
    await bare.close()
  })

  it('holds only so many lines for one account, whatever device ids it invents', async () => {
    // Attached BEFORE the relay stands up: it reads the account file once, as
    // a deployment does at boot.
    const second = await attach(username, 'desktop', desktopToken)
    const bare = await standBare({ linksPerAccount: 1 })
    const res = await fetch(`${bare.origin}/v2/canvas/link/${second.id}`, {
      headers: { authorization: `Bearer ${second.token}` }
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('too_many_links')
    expect(body.message).toMatch(/[.!]$/)
    // The line that was already there is untouched.
    expect(bare.relay.live(username, deviceId)).toBe(true)
    await bare.close()
  })

  it('gives up on an exchange the Mac never answers, and lets it go', async () => {
    const bare = await standBare({ headDeadlineMs: 80 })
    const res = await fetch(`${bare.origin}${prefix()}/hang`, { headers: asPhone({ accept: 'application/json' }) })
    expect(res.status).toBe(504)
    expect(((await res.json()) as { error: string }).error).toBe('timed_out')
    await until(() => bare.relay.stats().open === 0, 'the exchange to be released')
    await bare.close()
  })

  it('gives up on an answer that stopped mid-body, and ends the stream', async () => {
    const bare = await standBare({ idleDeadlineMs: 120 })
    const res = await fetch(`${bare.origin}${prefix()}/stall`, { headers: asPhone() })
    expect(res.status).toBe(200)
    // The head and the first chunk arrived; the stream then ends by itself
    // rather than being held open for as long as the desktop stays quiet.
    expect(await res.text()).toBe('first')
    await until(() => bare.relay.stats().open === 0, 'the stalled exchange to be released')
    await bare.close()
  })

  it('refuses a body when the whole relay is already holding as much as it will', async () => {
    const bare = await standBare({ bodyBudget: 1024 })
    const res = await fetch(`${bare.origin}${prefix()}/upload`, {
      method: 'POST',
      headers: asPhone({ 'content-type': 'application/octet-stream' }),
      body: Buffer.alloc(64 * 1024)
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('busy')
    // Given back: the next ordinary request is not refused for ever after.
    const after = await fetch(`${bare.origin}${prefix()}/`, { headers: asPhone() })
    expect(after.status).toBe(200)
    await after.text()
    await bare.close()
  })
})

// ── requests another site caused ─────────────────────────────────────────

describe('the cross-site gate on the machine’s own line', () => {
  it('reads the browser’s own account of where a request came from', () => {
    const asked = (headers: Record<string, string>): boolean =>
      crossSite({ headers } as unknown as IncomingMessage)
    expect(asked({ 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(asked({ 'sec-fetch-site': 'none' })).toBe(false)
    expect(asked({ 'sec-fetch-site': 'cross-site' })).toBe(true)
    expect(asked({ 'sec-fetch-site': 'same-site' })).toBe(true)
    // No such header: the Origin rule the rest of /v2 uses.
    expect(asked({ origin: 'https://evil.example', host: 'cookrew.dev' })).toBe(true)
    expect(asked({ host: 'cookrew.dev' })).toBe(false)
  })

  it('refuses a cross-site GET at the downlink, which would otherwise squat a name', async () => {
    const res = await fetch(`${site.origin}/v2/canvas/link/${randomUUID()}`, {
      headers: { cookie: `__Host-cr_session=${phoneSession}`, 'sec-fetch-site': 'cross-site' }
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
  })

  it('leaves the app’s Bearer path alone, which is not a browser', async () => {
    // The phone's token against the Mac's id: past the origin gate, and
    // refused by the rule that actually decides whose line this is.
    const res = await fetch(`${site.origin}/v2/canvas/link/${deviceId}`, {
      headers: { authorization: `Bearer ${phoneSession}`, 'sec-fetch-site': 'cross-site' }
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('not_this_device')
  })
})

describe('the old address', () => {
  it('is gone: nothing answers under /relay, page or call', async () => {
    for (const accept of ['text/html', 'application/json']) {
      const res = await fetch(`${site.origin}/relay/@${username}/desktop/${deviceId}/`, {
        headers: { accept, cookie: `__Host-cr_session=${phoneSession}`, [RELAY_SESSION_HEADER]: phoneSession }
      })
      expect(res.status, accept).toBe(404)
      await res.arrayBuffer()
    }
  })
})

describe('what the relay keeps', () => {
  let bare: Up
  let relay: CanvasRelay
  let own: Linked
  const lines: string[] = []

  beforeAll(async () => {
    relay = createCanvasRelay({
      v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } }),
      log: (line) => lines.push(line)
    })
    bare = await listen(
      createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://relay.local')
        const parts = url.pathname.split('/').filter(Boolean)
        if (relay.handle(request, response, parts, url)) return
        response.writeHead(404).end()
      })
    )
    own = linkDesktop(bare.origin, desktopToken, deviceId, mobile.origin)
    await own.ready
  })

  afterAll(async () => {
    own.close()
    relay.stop()
    await bare.close()
  })

  it('counts a session opening and closing, and the bytes each way', async () => {
    const before = relay.stats()
    const res = await fetch(`${bare.origin}${prefix()}/`, {
      method: 'POST',
      headers: asPhone({ 'content-type': 'text/plain' }),
      body: 'twelve bytes'
    })
    expect(res.status).toBe(200)
    await res.text()
    await until(() => relay.stats().closed === before.closed + 1, 'the session to be accounted')
    const after = relay.stats()
    expect(after.opened).toBe(before.opened + 1)
    expect(after.open).toBe(0)
    expect(after.links).toBe(1)
    expect(after.bytesUp).toBe(before.bytesUp + 12)
    expect(after.bytesDown).toBeGreaterThan(before.bytesDown)
  })

  it('logs that a session happened and never a byte of what was in it', () => {
    expect(lines.some((line) => line.includes('opened a line'))).toBe(true)
    expect(lines.some((line) => /session s\d+ opened$/.test(line))).toBe(true)
    expect(lines.some((line) => /closed, \d+b up, \d+b down$/.test(line))).toBe(true)
    for (const line of lines) {
      expect(line).not.toContain('twelve bytes')
      expect(line).not.toContain('cr_session')
      expect(line).not.toContain(phoneSession)
    }
  })

  it('stops saying a desktop is live the moment its line goes', async () => {
    expect(relay.live(username, deviceId)).toBe(true)
    own.close()
    await until(() => relay.live(username, deviceId) === false, 'the line to be released')
    expect(relay.stats().links).toBe(0)
    const res = await fetch(`${bare.origin}${prefix()}/`, { headers: asPhone({ accept: 'application/json' }) })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('no_link')
  })
})

// ── the small rules, alone ───────────────────────────────────────────────

describe('the header rules, by themselves', () => {
  it('allows content-type, accept, the caller’s own credential and its headers — nothing else', () => {
    expect(
      allowedRequestHeaders({
        'content-type': 'application/json',
        accept: '*/*',
        'last-event-id': '7',
        'x-cr-run': 'abc',
        'accept-encoding': 'br, gzip',
        'if-none-match': '"v7"',
        'x-forwarded-proto': 'https',
        'x-real-ip': '203.0.113.9',
        host: 'api.cookrew.dev',
        origin: 'https://console.cookrew.dev',
        authorization: 'Bearer the-callers-token-at-that-machine',
        // The account session is the relay's to read and never the machine's.
        'x-cookrew-session': 'the-account-session',
        // A statement about where a page is served, which nothing is any more.
        'x-cookrew-base': '/relay/@somebody/desktop/elsewhere',
        // No cookie crosses, whoever set it.
        cookie: 'canvas=1; __Host-cr_session=abc',
        referer: 'https://console.cookrew.dev/d/x'
      })
    ).toEqual({
      'content-type': 'application/json',
      accept: '*/*',
      'last-event-id': '7',
      'x-cr-run': 'abc',
      'accept-encoding': 'br, gzip',
      'if-none-match': '"v7"',
      authorization: 'Bearer the-callers-token-at-that-machine'
    })
  })

  it('drops a caller’s copy of who it is', () => {
    expect(
      allowedRequestHeaders({
        'x-cookrew-device': '00000000-0000-4000-8000-000000000000',
        'x-cookrew-device-name': 'Not this phone',
        'x-cookrew-relay': '1',
        accept: '*/*'
      })
    ).toEqual({ accept: '*/*' })
  })

  it('states the caller as two headers, and leaves an unnameable device unnamed', () => {
    expect(callerDeviceHeaders({ id: 'dev-1', name: 'A phone' })).toEqual({
      'x-cookrew-device': 'dev-1',
      'x-cookrew-device-name': 'A phone'
    })
    // A name that survives nothing is left off rather than sent empty.
    expect(callerDeviceHeaders({ id: 'dev-1', name: '\u{1F4F1}\u{1F4F1}' })).toEqual({
      'x-cookrew-device': 'dev-1'
    })
    // No id, nothing said at all: the desktop must not read a blank as a name.
    expect(callerDeviceHeaders({ id: '', name: 'A phone' })).toEqual({})
  })

  it('makes a device name something a header can carry at all', () => {
    // Node throws ERR_INVALID_CHAR on a header outside Latin-1; a fond name
    // must not become a relay that refuses every request from that phone.
    expect(headerSafeName('Dréj’s iPhone \u{1F4F1}')).toBe('Dr j s iPhone')
    expect(headerSafeName('  two\r\n  blanks  ')).toBe('two blanks')
    expect(headerSafeName('x'.repeat(200))).toHaveLength(64)
    expect(headerSafeName('')).toBe('')
  })

  it('never lets a machine’s header value reach the wire if a header cannot carry it', () => {
    // A value with a line break throws inside writeHead, and that throw was a
    // machine taking the whole relay down with one answer.
    const out = relayAnswerHeaders(
      {
        'content-type': 'application/json\r\nset-cookie: grab=1',
        etag: 'a\nb',
        'last-modified': 'Tue, 10 Nov 2026 12:00:00 GMT',
        'retry-after': '\u{1F4A5}',
        'content-encoding': 'x'.repeat(9000)
      },
      {}
    )
    expect(out['content-type']).toBe('application/octet-stream')
    expect(out.etag).toBeUndefined()
    expect(out['retry-after']).toBeUndefined()
    expect(out['content-encoding']).toBeUndefined()
    expect(out['last-modified']).toBe('Tue, 10 Nov 2026 12:00:00 GMT')
    for (const value of Object.values(out)) expect(value).toMatch(/^[\t\x20-\x7e]*$/)
  })

  it('reads every type an answer names, and refuses it if any is a page', () => {
    for (const type of ['application/json, text/html', 'text/plain,text/html;charset=utf-8', 'application/rss+xml', 'application/atom+xml', 'text/xsl', 'multipart/x-mixed-replace; boundary=x', 'application/vnd.x+xml']) {
      expect(isPageType(type), type).toBe(true)
    }
    for (const type of ['application/json; charset=utf-8', 'image/jpeg', 'audio/mpeg', 'text/event-stream']) {
      expect(isPageType(type), type).toBe(false)
    }
  })

  it('says which answers are pages a browser would run', () => {
    for (const type of ['text/html', 'text/html; charset=utf-8', ' TEXT/HTML', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']) {
      expect(isPageType(type), type).toBe(true)
    }
    for (const type of ['application/json', 'text/event-stream', 'image/png', 'application/octet-stream', 'text/plain', '']) {
      expect(isPageType(type), type).toBe(false)
    }
  })

  it('builds the relay path from a machine and a route, or refuses', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(machineRelayPath(id, 'api/fleet')).toBe(`/api/m/${id}/api/fleet`)
    expect(machineRelayPath(id.toUpperCase(), '/api/watch/cards?workspace=w1')).toBe(`/api/m/${id}/api/watch/cards?workspace=w1`)
    expect(machineRelayPath(id, 'index.html')).toBeNull()
    expect(machineRelayPath(id, 'api/../x')).toBeNull()
    expect(machineRelayPath('nope', 'api/fleet')).toBeNull()
    expect(isRelayedRoute('api')).toBe(true)
    expect(isRelayedRoute('apiary')).toBe(false)
    // The sealed session's own routes cross too; nothing else beside the API does.
    expect(machineRelayPath(id, '/~seal/hello')).toBe(`/api/m/${id}/~seal/hello`)
    expect(isRelayedRoute('~sealed/x')).toBe(false)
    expect(isRelayedRoute('assets/index.js')).toBe(false)
    // Nothing that a later reader could decode into a way out of /api.
    for (const route of ['api/../secrets', 'api/./x', 'api/..%2Fsecrets', 'api/%2e%2e/secrets', 'api/%2E%2E%2fsecrets', 'api/x%5c..%5csecrets', 'api\\..\\secrets']) {
      expect(isRelayedRoute(route), route).toBe(false)
      expect(machineRelayPath(id, route), route).toBeNull()
    }
    // A query is the machine's own to read, whatever it holds.
    expect(isRelayedRoute('api/watch/cards?next=%2Fapi%2F..')).toBe(true)
  })
})
