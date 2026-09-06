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
import {
  allowedRequestHeaders,
  CANVAS_BASE_HEADER,
  canvasName,
  createCanvasRelay,
  crossSite,
  rewriteLocation,
  rewriteRefresh,
  forwardableCookies,
  isCanvasName,
  rewriteCookiePath,
  type CanvasRelay
} from '../registry/src/v2-canvas-relay'
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
 * The four rules under test are the ones that would be quiet if broken: the
 * line belongs to the desktop that signed in, the prefix belongs to the
 * account, cookrew.dev's own session never crosses, and a cookie the desktop
 * sets can never come back to cookrew.dev's own routes.
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
    const url = new URL(request.url ?? '/', 'http://mobile.local')
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
  const down = httpRequest(address, { method: 'GET', headers }, (res) => {
    let buffer = ''
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
  const asked = (await res.json()) as { pending: string }
  const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
  expect(request.status).toBe(202)
  const { approval } = (await request.json()) as { approval: string }
  const decided = await fetch(`${site.origin}/v2/me/approvals/${approval}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
    body: JSON.stringify({ decision: 'approve' })
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
      v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
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
  phoneSession = (await attach(username, 'phone', desktopToken)).token
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

const prefix = (): string => `/relay/@${username}/desktop/${deviceId}`
const asPhone = (headers: Record<string, string> = {}): Record<string, string> => ({
  cookie: `cr_session=${phoneSession}`,
  ...headers
})

// ── the name ─────────────────────────────────────────────────────────────

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
    headers: { cookie: `cr_session=${session}` }
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

describe('/relay/@user/desktop/:id — who is admitted to the prefix', () => {
  it('sends a signed-out reader a page with a way in, not a machine value', async () => {
    const res = await fetch(`${site.origin}${prefix()}/`, { headers: { accept: 'text/html' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Sign in first')
  })

  it('answers a script with JSON rather than a page', async () => {
    const res = await fetch(`${site.origin}${prefix()}/`, { headers: { accept: 'application/json' } })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('unauthenticated')
  })

  it('reads as not-there for another account, so it cannot be used to find desktops', async () => {
    const res = await fetch(`${site.origin}${prefix()}/`, {
      headers: { accept: 'text/html', cookie: `cr_session=${strangerSession}` }
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Not found')
  })

  it('says so plainly when the Mac is holding no line', async () => {
    const asleep = await claim('sleeper', 'desktop')
    const session = (await attach('sleeper', 'phone', asleep.token)).token
    const res = await fetch(`${site.origin}/relay/@sleeper/desktop/${asleep.id}/`, {
      headers: { accept: 'text/html', cookie: `cr_session=${session}` }
    })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('Not reachable just now')
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

describe('a phone of the account, reaching its own canvas', () => {
  it('carries the admission through untouched — token, key and device on the query', async () => {
    const { res, body } = await echo('/?open=TOKEN123&key=A2B3C4&device=abc', { headers: asPhone() })
    expect(res.status).toBe(200)
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/?open=TOKEN123&key=A2B3C4&device=abc')
    // Streamed, so the desktop's own length is not repeated as a promise this
    // side cannot keep.
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('forwards a deeper path and its query as they stand', async () => {
    const { body } = await echo('/api/workspaces?limit=2', { headers: asPhone() })
    expect(body.path).toBe('/api/workspaces?limit=2')
  })

  it('takes every method the canvas answers to', async () => {
    const { body } = await echo('/api/thing', {
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
        // The app's own, for its own Mac: it crosses, because that is the
        // credential the companion authenticates with. It must never be read
        // as cookrew.dev's own — the cookie is that, and the cookie is what
        // admits anyone here.
        authorization: 'Bearer a-companion-token-of-the-apps-own'
      })
    })
    expect(body.headers['x-cookrew-app']).toBe('companion')
    expect(body.headers.accept).toBe('application/json')
    expect(body.headers['x-forwarded-for']).toBeUndefined()
    expect(body.headers.authorization).toBe('Bearer a-companion-token-of-the-apps-own')
    expect(body.headers['accept-language']).toBeUndefined()
  })

  it('NEVER hands the desktop cookrew.dev’s own session', async () => {
    const { body } = await echo('/', {
      headers: { cookie: `cr_session=${phoneSession}; canvas=yes; cr_account=v1token` }
    })
    expect(body.headers.cookie).toBe('canvas=yes')
    expect(body.headers.cookie).not.toContain(phoneSession)
  })

  it('pins every cookie the desktop sets to the relay path, and strips its domain', async () => {
    const { res } = await echo('/', { headers: asPhone() })
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toBe(`canvas=yes; HttpOnly; Path=${prefix()}/`)
    expect(cookies[1]).toBe(`wide=1; Path=${prefix()}/`)
    for (const cookie of cookies) expect(cookie).not.toContain('Domain')
  })

  it('tells the desktop which prefix it is being served under', async () => {
    const { body } = await echo('/', { headers: asPhone() })
    expect(body.headers[CANVAS_BASE_HEADER]).toBe(prefix())
  })

  it('does not let a caller write that prefix for the desktop', async () => {
    const { body } = await echo('/', {
      headers: asPhone({ [CANVAS_BASE_HEADER]: '/relay/@somebody/desktop/elsewhere' })
    })
    expect(body.headers[CANVAS_BASE_HEADER]).toBe(prefix())
  })

  it('moves the admission’s own redirect under the prefix, where the Mac is', async () => {
    // THE LIVE BUG (2026-09-06): the desktop answers `303 /?token=…` because on
    // the LAN it is the root. Forwarded as it stands, OPEN landed on
    // cookrew.dev's home page with a credential in the address bar.
    const res = await fetch(
      `${site.origin}${prefix()}/redirect?code=303&to=${encodeURIComponent('/?token=abc')}`,
      { headers: asPhone(), redirect: 'manual' }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${prefix()}/?token=abc`)
  })

  it('moves a redirect the Mac wrote to its OWN origin under the prefix too', async () => {
    const res = await fetch(
      `${site.origin}${prefix()}/redirect?code=302&to=${encodeURIComponent('https://127.0.0.1:8639/board?x=1')}`,
      { headers: asPhone(), redirect: 'manual' }
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${prefix()}/board?x=1`)
  })

  it('leaves a redirect back to cookrew.dev alone — that is where ?refused= goes', async () => {
    const back = `${site.origin}/me?refused=key`
    const res = await fetch(
      `${site.origin}${prefix()}/redirect?code=303&to=${encodeURIComponent(back)}`,
      { headers: asPhone(), redirect: 'manual' }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(back)
  })

  it('moves a Refresh header by the same rule, since it is a redirect with a delay', async () => {
    const res = await fetch(`${site.origin}${prefix()}/refresh`, { headers: asPhone() })
    expect(res.headers.get('refresh')).toBe(`5; url=${prefix()}/board`)
    await res.text()
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

// ── the bounds, because anyone can claim a username ──────────────────────

/**
 * A relay of its own, with the bounds turned down far enough to reach in a
 * test. Everything else is the shipping code: the same hub, the same gate.
 */
async function standBare(
  bounds: Partial<Parameters<typeof createCanvasRelay>[0]> = {}
): Promise<{ origin: string; relay: CanvasRelay; desktop: Linked; close: () => Promise<void> }> {
  const relay = createCanvasRelay({
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } }),
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

describe('the cross-site gate on both prefixes', () => {
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
      headers: { cookie: `cr_session=${phoneSession}`, 'sec-fetch-site': 'cross-site' }
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

  it('refuses a cross-site navigation into the canvas, with a sentence', async () => {
    const res = await fetch(`${site.origin}${prefix()}/`, {
      headers: asPhone({ accept: 'text/html', 'sec-fetch-site': 'cross-site' })
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Not from here')
  })

  it('refuses a cross-site write, and answers a script in JSON', async () => {
    const res = await fetch(`${site.origin}${prefix()}/api/thing`, {
      method: 'POST',
      headers: asPhone({ accept: 'application/json', 'sec-fetch-site': 'cross-site' }),
      body: '{}'
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
  })

  it('lets the picker’s own navigation through — same-origin, and a typed address too', async () => {
    for (const site_ of ['same-origin', 'none']) {
      const { res, body } = await echo('/', { headers: asPhone({ 'sec-fetch-site': site_ }) })
      expect(res.status, site_).toBe(200)
      expect(body.method).toBe('GET')
    }
  })
})

// ── the numbers, and nothing else, in the log ─────────────────────────────

describe('what the relay keeps', () => {
  let bare: Up
  let relay: CanvasRelay
  let own: Linked
  const lines: string[] = []

  beforeAll(async () => {
    relay = createCanvasRelay({
      v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } }),
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

describe('the header and cookie rules, by themselves', () => {
  it('keeps the desktop’s cookies and drops cookrew.dev’s own', () => {
    expect(forwardableCookies('cr_session=abc; canvas=1; cr_account=xyz; other=2')).toBe('canvas=1; other=2')
    expect(forwardableCookies('cr_session=abc')).toBe('')
  })

  it('allows content-type, accept, the companion’s own credential and its headers — nothing else', () => {
    expect(
      allowedRequestHeaders({
        'content-type': 'application/json',
        accept: '*/*',
        'last-event-id': '7',
        'x-cr-run': 'abc',
        'x-forwarded-proto': 'https',
        'x-real-ip': '203.0.113.9',
        host: 'cookrew.dev',
        authorization: 'Bearer the-companion-token',
        // A caller's own copy of the base is DROPPED: it is a statement about
        // where the request was addressed, and the registry is what knows that.
        'x-cookrew-base': '/relay/@somebody/desktop/elsewhere',
        referer: 'https://cookrew.dev/me'
      })
    ).toEqual({
      'content-type': 'application/json',
      accept: '*/*',
      'last-event-id': '7',
      'x-cr-run': 'abc',
      authorization: 'Bearer the-companion-token'
    })
  })

  it('rewrites a Location by where it points, and only then', () => {
    const at = { prefix: '/relay/@u/desktop/d', path: '/?open=x', host: 'cookrew.dev' }
    expect(rewriteLocation('/?token=abc', at)).toBe('/relay/@u/desktop/d/?token=abc')
    expect(rewriteLocation('https://127.0.0.1:8639/board', at)).toBe('/relay/@u/desktop/d/board')
    expect(rewriteLocation('https://192.168.1.24:8643/x#y', at)).toBe('/relay/@u/desktop/d/x#y')
    // Ours: left exactly as written, whatever the scheme in front of it.
    expect(rewriteLocation('https://cookrew.dev/me?refused=key', at)).toBe('https://cookrew.dev/me?refused=key')
    // A relative reference resolves against the path this exchange was for,
    // which is what a browser would have done with the desktop's answer.
    expect(rewriteLocation('board', { ...at, path: '/api/thing' })).toBe('/relay/@u/desktop/d/api/board')
  })

  it('rewrites a Refresh’s url and leaves its delay alone', () => {
    const at = { prefix: '/relay/@u/desktop/d', path: '/', host: 'cookrew.dev' }
    expect(rewriteRefresh('5; url=/board', at)).toBe('5; url=/relay/@u/desktop/d/board')
    expect(rewriteRefresh('0;url="/x"', at)).toBe('0; url=/relay/@u/desktop/d/x')
    expect(rewriteRefresh('5; url=https://cookrew.dev/me', at)).toBe('5; url=https://cookrew.dev/me')
    // No target at all is not a redirect; nothing to move.
    expect(rewriteRefresh('30', at)).toBe('30')
  })

  it('replaces a cookie’s path rather than adding to it, and refuses a domain', () => {
    expect(rewriteCookiePath('a=1; Path=/; HttpOnly; SameSite=Lax', '/relay/@u/desktop/d/')).toBe(
      'a=1; HttpOnly; SameSite=Lax; Path=/relay/@u/desktop/d/'
    )
    expect(rewriteCookiePath('a=1; Domain=cookrew.dev', '/relay/@u/desktop/d/')).toBe(
      'a=1; Path=/relay/@u/desktop/d/'
    )
  })
})
