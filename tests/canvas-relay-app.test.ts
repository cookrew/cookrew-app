import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
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
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createCanvasBridge, loopbackDialer, RELAY_MARKER } from '../src/main/canvas-bridge'

/**
 * IDENTITY v2, PHASE 3 — THE APP HALF AGAINST THE REAL REGISTRY.
 *
 * The registry's own suite proves its rules with a hand-rolled desktop. This
 * proves the opposite direction: that `canvas-link` + `canvas-bridge` — the
 * code that actually ships — speak that wire, end to end, with a real phone
 * request travelling down a real held line into a real companion listener.
 *
 * It is the test that would have caught every version of this that was written
 * against a mock and then met the registry.
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

/** The companion, reduced to an echo and one admission. */
const companion = (): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname === '/' && url.searchParams.get('open')) {
      // The admission ceremony, exactly as it answers over the LAN: the relay
      // adds no authority, so it hands the session over the same way.
      response.writeHead(303, {
        location: '/?token=the-pairing-token',
        'set-cookie': ['cr_seen=1; Path=/', 'cr_x=2; Path=/; Domain=cookrew.dev']
      })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        method: request.method,
        path: request.url,
        host: request.headers.host,
        relayed: request.headers[RELAY_MARKER] ?? null,
        cookie: request.headers.cookie ?? null,
        authorization: request.headers.authorization ?? null
      })
    )
  })

let site: Up
let phone: Up
let dir = ''
let username = ''
let deviceId = ''
let desktopToken = ''
let phoneSession = ''
let link: CanvasLink | null = null

const jwkOf = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

const until = async (
  what: () => boolean | Promise<boolean>,
  why: string,
  ms = 4000
): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'canvas-relay-app-'))
  phone = await listen(companion())
  site = await listen(
    createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      origin: 'https://cookrew.dev',
      v2: createV2(dir, {
        limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 }
      })
    })
  )
  username = 'owner'
  deviceId = randomUUID()
  const claimed = await fetch(`${site.origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() }
    })
  })
  expect(claimed.status).toBe(201)
  desktopToken = ((await claimed.json()) as { session: { token: string } }).session.token
  // Filed with the registry, which is what makes `relay-status` answer about
  // it at all — an unfiled desktop is a device id the account does not own.
  await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${desktopToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
  })
  const attached = await fetch(`${site.origin}/v2/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: { id: randomUUID(), kind: 'phone', name: 'A phone', jwk: jwkOf() }
    })
  })
  // Phase 4: a device the account has never seen climbs one rung; the Mac
  // that claimed the name approves it over the wire.
  expect(attached.status).toBe(401)
  const asked = (await attached.json()) as { pending: string }
  const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
  expect(request.status).toBe(202)
  const { approval } = (await request.json()) as { approval: string }
  const decided = await fetch(`${site.origin}/v2/me/approvals/${approval}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${desktopToken}` },
    body: JSON.stringify({ decision: 'approve' })
  })
  expect(decided.status).toBe(204)
  const done = await fetch(`${site.origin}/v2/sessions/${asked.pending}`)
  expect(done.status).toBe(201)
  phoneSession = ((await done.json()) as { token: string }).token

  // The app half, as it is wired in index.ts.
  const port = Number(new URL(phone.origin).port)
  link = createCanvasLink({
    origin: () => site.origin,
    credential: () => ({ token: desktopToken, deviceId })
  })
  const bridge = createCanvasBridge({ send: (line) => link!.send(line), dial: loopbackDialer(port) })
  link.onFrame(bridge.frame)
  link.onDrop(bridge.reset)
  link.start()
  await until(() => link!.held(), 'the desktop to hold its line')
})

afterAll(async () => {
  link?.stop()
  await site.close()
  await phone.close()
  rmSync(dir, { recursive: true, force: true })
})

const prefix = (): string => `/relay/@${username}/desktop/${deviceId}`
const asPhone = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${site.origin}${prefix()}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { cookie: `cr_session=${phoneSession}`, ...(init.headers as Record<string, string>) }
  })

describe('the app half, holding a real line', () => {
  it('is live as far as the registry is concerned', async () => {
    const status = await fetch(`${site.origin}/v2/me/desktops/${deviceId}/relay-status`, {
      headers: { authorization: `Bearer ${desktopToken}` }
    })
    expect(await status.json()).toEqual({ live: true })
    expect(link?.name()).toBe(`@${username}/desktop/${deviceId}`)
  })

  it("carries the phone's request into the companion unchanged", async () => {
    const answer = await asPhone('/api/state?scope=one')
    expect(answer.status).toBe(200)
    const echo = (await answer.json()) as Record<string, unknown>
    // The relay prefix is stripped by the registry; the companion sees the
    // path it would have seen on the LAN, query and all.
    expect(echo.path).toBe('/api/state?scope=one')
    expect(echo.method).toBe('GET')
    // The bridge speaks for itself in the host, and marks the request relayed
    // so the built bundle is served rather than Vite's live module graph.
    expect(echo.relayed).toBe('1')
    expect(echo.host).toMatch(/^127\.0\.0\.1:\d+$/)
  })

  it("never hands the desktop cookrew.dev's own session", async () => {
    const echo = (await (await asPhone('/api/state')).json()) as { cookie: string | null }
    expect(echo.cookie ?? '').not.toContain('cr_session')
  })

  it("hands the desktop the companion's OWN Authorization, which is what it is for", async () => {
    // Reversed on 2026-09-06, and the reversal is the point: the companion
    // authenticates to its Mac with `Authorization: Bearer <companion token>`
    // (mobile-http.presentedToken). Stripped, every API call the canvas makes
    // was a 401 and the phone sat on a shell that could read nothing.
    // cookrew.dev's own credential is the COOKIE, and that is still stripped.
    const echo = (await (
      await asPhone('/api/state', { headers: { authorization: 'Bearer the-companion-token' } })
    ).json()) as { authorization: string | null }
    expect(echo.authorization).toBe('Bearer the-companion-token')
  })

  it('carries a POST body through', async () => {
    const echo = (await (
      await asPhone('/api/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello from the phone' })
      })
    ).json()) as { method: string }
    expect(echo.method).toBe('POST')
  })

  it('admits a phone through the relay exactly as it does over the LAN', async () => {
    const answer = await asPhone(`/?open=a-canvas-token&key=ABC234&device=${randomUUID()}`)
    expect(answer.status).toBe(303)
    // UNDER THE PREFIX. The desktop says `/?token=…` because on the LAN it is
    // the root; forwarded as it stands that sent the phone to cookrew.dev's
    // home page with a credential in the address bar, and the canvas was never
    // reached (found on the live site, 2026-09-06).
    expect(answer.headers.get('location')).toBe(`${prefix()}/?token=the-pairing-token`)
    // The desktop said Path=/ and no Domain; the registry re-pins it under the
    // relay prefix, so nothing it sets can ever reach cookrew.dev's own routes.
    const cookies = answer.headers.getSetCookie()
    expect(cookies.every((cookie) => cookie.includes(`Path=${prefix()}/`))).toBe(true)
    expect(cookies.some((cookie) => /domain=/i.test(cookie))).toBe(false)
  })

  it('stops claiming the name the moment the desktop withdraws', async () => {
    link?.stop()
    link = null
    await until(async () => {
      const status = await fetch(`${site.origin}/v2/me/desktops/${deviceId}/relay-status`, {
        headers: { authorization: `Bearer ${desktopToken}` }
      })
      return ((await status.json()) as { live: boolean }).live === false
    }, 'the registry to let the line go')
    const answer = await asPhone('/api/state')
    expect(answer.status).toBe(503)
  })
})
