import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { CANVAS_BASE_HEADER } from '../registry/src/v2-canvas-relay'
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createCanvasBridge, loopbackDialer } from '../src/main/canvas-bridge'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { createPairingKeyRing } from '../src/main/pairing-key'
import { createSpentTokenStore } from '../src/main/spent-tokens'
import { handleIdentityRoutes, type MobileIdentityDeps } from '../src/main/mobile-identity-routes'
import { pairingAuthorized } from '../src/main/mobile-http'
import type { RegistryKeys } from '../src/main/canvas-token'
import { mintDeviceKey, deviceIdFor } from '../src/main/account-v2'
import { fakeAccount, tempBase } from './support/idv2'

/**
 * THE PERMANENT GATE: PRESSING OPEN LANDS ON THE CANVAS.
 *
 * Every piece here is the shipping one — the registry's router, the app's own
 * canvas link and bridge, the real admission ceremony with a real canvas token
 * from a real registry and a real six-character key — and the assertion is the
 * only one the owner cares about: the phone that pressed OPEN ends up looking
 * at the companion, and the companion can then read its API.
 *
 * IT EXISTS BECAUSE THE PIECES WERE ALL GREEN AND THE PRODUCT WAS NOT. The
 * desktop answers the admission with `303 Location: /?token=…` — correct on
 * the LAN, where it is the root — and the relay forwarded that untouched, so
 * OPEN over the relay navigated to cookrew.dev's HOME PAGE with a credential
 * in the address bar (live, 2026-09-06). Nothing in either half's own suite
 * could see it: the bug lived exactly in the seam between them.
 *
 * So the rule this file enforces is stated as a walk, not as a unit: follow
 * the redirects, and every one of them must stay under the relay prefix.
 */

const PASSWORD = 'correct horse battery staple'
/** What the desktop's own mobile server would serve at `/`. */
const ROOT_MARKER = '<div id="root"></div>'

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

const until = async (what: () => boolean, why: string, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let site: Up
let desktop: Up
let dir = ''
let base: { base: string; clean: () => void }
let link: CanvasLink | null = null
let username = ''
let deviceId = ''
let desktopToken = ''
let phoneSession = ''
let phoneDeviceId = ''
const ring = createPairingKeyRing()
const PAIRING_TOKEN = 'the-legacy-pairing-token'

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'open-canvas-gate-'))
  base = tempBase()

  // ── the registry, whole ─────────────────────────────────────────────────
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

  // ── the desktop's account, claimed with the key it will actually hold ────
  const keys = mintDeviceKey()
  username = 'owner'
  deviceId = deviceIdFor(keys.publicKeyJwk)
  const account = fakeAccount({
    username,
    deviceId,
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    registry: site.origin
  })
  const claimed = await fetch(`${site.origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: keys.publicKeyJwk }
    })
  })
  expect(claimed.status).toBe(201)
  desktopToken = ((await claimed.json()) as { session: { token: string } }).session.token
  await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${desktopToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
  })

  // ── the desktop's mobile server: the real admission, and a companion ─────
  const admitted = createAdmittedDeviceStore({ base: base.base })
  const spent = createSpentTokenStore({ base: base.base })
  const registryKeys = async (): Promise<RegistryKeys | null> => {
    const res = await fetch(`${site.origin}/v2/keys`)
    return res.ok ? ((await res.json()) as RegistryKeys) : null
  }
  const identity: MobileIdentityDeps = {
    account: () => account,
    registryOrigin: () => site.origin,
    keys: registryKeys,
    refreshKeys: registryKeys,
    admitted,
    acceptsPairingKey: (key) => ring.accepts(key),
    pairingToken: () => PAIRING_TOKEN,
    spend: spent.spend
  }
  desktop = await listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleIdentityRoutes(request, response, url, identity).then((handled) => {
        if (handled) return
        if (url.pathname === '/api/reach') {
          // The companion's own gate, unchanged: the token it was handed in
          // the admission redirect, as a Bearer (mobile-http.presentedToken).
          if (!pairingAuthorized(request, url, PAIRING_TOKEN, admitted.accepts)) {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end('{"error":"unpaired"}')
            return
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ lan: [], relay: true }))
          return
        }
        if (url.pathname === '/') {
          // THE SHELL, with the prefix the registry told us about injected the
          // way mobile-server injects COOKREW_SLUG today. Through the relay
          // this header is the ONLY way the desktop can know where it is being
          // served from — nothing else in the request says so.
          const told = request.headers[CANVAS_BASE_HEADER]
          const injected = typeof told === 'string' ? told : ''
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end(
            `<!doctype html><html><head><script>window.COOKREW_BASE=${JSON.stringify(injected)}</script></head><body>${ROOT_MARKER}</body></html>`
          )
          return
        }
        response.writeHead(404).end()
      })
    })
  )

  // ── the phone: a device the account has never seen, approved by the Mac ──
  phoneDeviceId = randomUUID()
  const attached = await fetch(`${site.origin}/v2/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: {
        id: phoneDeviceId,
        kind: 'phone',
        name: 'A phone',
        jwk: mintDeviceKey().publicKeyJwk
      }
    })
  })
  expect(attached.status).toBe(401)
  const asked = (await attached.json()) as { pending: string }
  const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
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

  // ── the Mac holds its line, exactly as index.ts wires it ────────────────
  link = createCanvasLink({
    origin: () => site.origin,
    credential: () => ({ token: desktopToken, deviceId })
  })
  const bridge = createCanvasBridge({
    send: (line) => link?.send(line),
    dial: loopbackDialer(Number(new URL(desktop.origin).port))
  })
  link.onFrame(bridge.frame)
  link.onDrop(bridge.reset)
  link.start()
  await until(() => link?.held() === true, 'the Mac to hold its line')
})

afterAll(async () => {
  link?.stop()
  await site.close()
  await desktop.close()
  base.clean()
  rmSync(dir, { recursive: true, force: true })
})

const prefix = (): string => `/relay/@${username}/desktop/${deviceId}`

/** The picker's own request: same-origin, with the browser's session cookie. */
const asPhone = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${site.origin}${path}`, {
    redirect: 'manual',
    ...init,
    headers: {
      cookie: `__Host-cr_session=${phoneSession}`,
      'sec-fetch-site': 'same-origin',
      accept: 'text/html',
      ...(init.headers as Record<string, string>)
    }
  })

/** A canvas token for this Mac, minted the way the picker mints one. */
const openToken = async (): Promise<string> => {
  const res = await fetch(`${site.origin}/v2/me/desktops/${deviceId}/open`, {
    method: 'POST',
    headers: { cookie: `__Host-cr_session=${phoneSession}` }
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { token: string }).token
}

describe('pressing OPEN with the relay path', () => {
  it('walks the admission to the companion, never leaving the relay prefix', async () => {
    const token = await openToken()
    const admission = `${prefix()}/?open=${encodeURIComponent(token)}&key=${ring.current().key}&device=${phoneDeviceId}`

    let at = admission
    let answer = await asPhone(at)
    const walked: string[] = []
    let companionToken: string | null = null
    for (let hop = 0; hop < 5 && answer.status >= 300 && answer.status < 400; hop += 1) {
      const location = answer.headers.get('location') ?? ''
      walked.push(location)
      // THE WHOLE POINT. A Location that leaves the prefix is a reader sent to
      // cookrew.dev's own pages with the canvas never reached.
      expect(location.startsWith(`${prefix()}/`), `hop ${hop} left the prefix: ${location}`).toBe(true)
      const asUrl = new URL(location, site.origin)
      companionToken = asUrl.searchParams.get('token') ?? companionToken
      at = `${asUrl.pathname}${asUrl.search}`
      answer = await asPhone(at)
    }

    expect(walked.length).toBeGreaterThan(0)
    // The credential the ceremony hands over, once, in the redirect.
    expect(companionToken).toBeTruthy()
    expect(companionToken).not.toBe(PAIRING_TOKEN)

    // The companion itself, served under the prefix.
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toContain('text/html')
    const html = await answer.text()
    expect(html).toContain(ROOT_MARKER)
    // And it knows where it is: every API path the client builds hangs off this.
    expect(html).toContain(`window.COOKREW_BASE="${prefix()}"`)

    // The API the shell will call, under the same prefix and with the
    // credential the admission handed over.
    const reach = await asPhone(`${prefix()}/api/reach`, {
      headers: { accept: 'application/json', authorization: `Bearer ${companionToken}` }
    })
    expect(reach.status).toBe(200)
    expect((await reach.json()) as { relay: boolean }).toEqual({ lan: [], relay: true })

    // An unauthenticated call is still refused: the relay carries the asking,
    // it never admits anyone at the Mac.
    const bare = await asPhone(`${prefix()}/api/reach`, { headers: { accept: 'application/json' } })
    expect(bare.status).toBe(401)

    // REPLAY. The same recorded admission, inside the token's ten minutes.
    const again = await asPhone(admission)
    expect(again.status).toBe(401)
  })
})
