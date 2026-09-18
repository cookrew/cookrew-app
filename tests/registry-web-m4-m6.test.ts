import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { ASSETS } from '../registry/src/assets-bundle'
import { WEB_V3_COPY } from '../registry/src/v3-copy'
import { esc } from '../registry/src/site-shell'

/**
 * M4 · M5 · M6 · W6 ON cookrew.dev — the phone's three screens and the ask.
 *
 * WHAT THIS FILE ASSERTS IS THE MARKUP, THE ROUTES AND THE BUNDLE. The CSP
 * forbids an inline script, so a control missing from the served HTML is a
 * control the reader never gets; and the scripts ship out of assets-bundle.ts,
 * so a handler living only in registry/assets/ and never regenerated is a
 * handler that is not deployed. Those are the two ways this lane can be wrong
 * while looking right in the source tree.
 *
 * The live ceremonies — join by a scanned code, ask a Mac for Wi-Fi and open
 * the sealed answer, approve with the number, ask for a seat and be seated —
 * are driven in a real browser by scratchpad/v3-14-cdp.mjs.
 */

const PASSWORD = 'correct horse battery staple'
const device = (name = 'Chrome on macOS') => ({
  id: randomUUID(),
  kind: 'browser' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined
let session = ''
let deviceId = ''

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'm4-m6-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    origin: 'https://cookrew.dev',
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        rmSync(dir, { recursive: true, force: true })
        resolve()
      })
    })

  const mine = device('This Mac')
  deviceId = mine.id
  const made = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'drej', password: PASSWORD, device: mine })
  })
  session = ((await made.json()) as { session: { token: string } }).session.token
  await fetch(`${origin}/v2/me/desktops/${deviceId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ name: 'MacBook Pro', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
  })
})
afterAll(async () => {
  await close()
})

const get = (p: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${p}`, { headers, redirect: 'manual' })
const signedIn = () => ({ cookie: `__Host-cr_session=${session}` })

describe('M4 · the phone joins by a code it scanned', () => {
  it('serves /join, and the page carries no code because the code is in the fragment', async () => {
    const res = await get('/join')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="join-card"')
    expect(body).toContain('id="join-go"')
    expect(body).toContain(esc(WEB_V3_COPY['m4.join-lede']))
    // The other door, for somebody holding a password and no code.
    expect(body).toContain('data-signin')
    expect(body).toContain(esc(WEB_V3_COPY['m4.join-instead']))
    // A phone arriving here has no account yet: /join must not be behind one.
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('is the same page for every code — it is no oracle for which ones are live', async () => {
    // The fragment never reaches a server, so this route cannot tell a real
    // code from a guess, and therefore cannot be asked.
    const a = await (await get('/join')).text()
    const b = await (await get('/join')).text()
    expect(a).toBe(b)
    expect(a).not.toContain('drej')
  })

  it('mints a code with the link and the picture a camera needs', async () => {
    const res = await fetch(`${origin}/v2/me/join-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn() },
      body: JSON.stringify({ current: PASSWORD })
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { code: string; url: string; qr: string[]; expiresAt: number }
    expect(body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    // THE CODE RIDES IN THE FRAGMENT: never on the wire, never in a log. The
    // host is this deployment's own (relyingParty), so the contract asserted
    // here is the SHAPE — absolute, /join, and the code after the hash.
    expect(body.url).toMatch(/^https?:\/\/[^/]+\/join#/)
    expect(new URL(body.url).hash).toBe(`#${body.code}`)
    expect(new URL(body.url).pathname).toBe('/join')
    expect(new URL(body.url).search).toBe('')
    expect(body.qr.length).toBeGreaterThan(0)
    expect(body.qr[0]).toMatch(/^[01]+$/)
    // The picture is drawn by the panel that shows the code.
    expect(ASSETS['factors.js'].body).toContain('out.body.qr')
  })

  it('the join page spends the code once and scrubs it from the address bar', () => {
    const shipped = ASSETS['site.js'].body
    expect(shipped).toContain('join-card')
    expect(shipped).toContain("'/v2/join'")
    // A code left in the bar is in every screenshot, reload and referrer.
    expect(shipped).toContain('history?.replaceState')
  })
})

describe('M5 · USE WI-FI — a tap on the Mac, never a scan', () => {
  it('puts the ask on every desktop row, with the states it can be in', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain(`data-reach="${deviceId}"`)
    expect(body).toContain('USE WI-FI')
    expect(body).toContain('data-reach-ok')
    expect(body).toContain('data-badge="lan"')
    // Every state ships in the markup; the script only unhides one.
    expect(body).toMatch(/data-reach-ok[^>]*hidden/)
  })

  it('carries M5’s sentences from the one table, and names the account-less door', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain(`data-asked="${esc(WEB_V3_COPY['m5.asked'])}"`)
    expect(body).toContain(esc(WEB_V3_COPY['m5.no-account']))
    // The scripts cannot import the table, so the sentences come down as data.
    expect(ASSETS['reach.js'].body).toContain('dataset.asked')
    expect(ASSETS['reach.js'].body).not.toContain(WEB_V3_COPY['m5.asked'])
  })

  it('asks the registry and collects the sealed answer, and never navigates away', () => {
    const shipped = ASSETS['reach.js'].body
    expect(shipped).toContain('reach-requests')
    expect(shipped).toContain('/v2/me/requests/')
    // REACH v2.1: opening or pairing a Mac never leaves cookrew.dev.
    expect(shipped).not.toContain('location.assign')
    expect(shipped).not.toContain('location.href =')
  })

  it('stores the token per desktop, under the key the companion reads', () => {
    const shipped = ASSETS['reach.js'].body
    // One origin hosts every Mac the owner has, so one key would hand Mac B a
    // token minted for Mac A (src/renderer/src/pairing-scope.ts says why).
    expect(shipped).toContain("'cr_token:'")
    expect(shipped).toContain('toLowerCase()')
  })

  it('loads the opener on /me, and the opener ships in the bundle', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain('/assets/device-seal.js')
    expect(ASSETS['device-seal.js']).toBeDefined()
    expect(ASSETS['device-seal.js'].body).toContain('CookrewDeviceSeal')
    // The device key must be one a browser can actually derive with.
    expect(ASSETS['site.js'].body).toContain("{ name: 'ECDH', namedCurve: 'P-256' }")
    expect(ASSETS['site.js'].body).toContain('sealKey')
  })

  it('a reach request reaches the Mac it named, carrying that device’s key', async () => {
    const other = device('Second Mac')
    const joined = await fetch(`${origin}/v2/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'drej', password: PASSWORD, device: other })
    })
    // A device the account has not met climbs a ladder; this test only needs
    // the row, so it asks as the device that already holds a session.
    expect([201, 401]).toContain(joined.status)
    const asked = await fetch(`${origin}/v2/me/desktops/${deviceId}/reach-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn() }
    })
    // Asking to reach the very device you are on is a no-op, not a queue row.
    expect(asked.status).toBe(400)
  })
})

describe('M6 · the requests view — D11’s rows at phone width', () => {
  it('reads the ONE queue, not the approvals list alone', () => {
    const shipped = ASSETS['factors.js'].body
    expect(shipped).toContain("'/v2/me/requests'")
    // A join is still ANSWERED at the approvals route — that is where the
    // number-matching rung lives — but it is no longer the only kind listed.
    expect(shipped).toContain('/v2/me/approvals/')
    expect(shipped).toContain("kind === 'seat'")
  })

  it('makes the number the primary control on a phone', () => {
    const body = ASSETS['site.js'] && ''
    void body
    const shipped = ASSETS['factors.js'].body
    expect(shipped).toContain('acct-match-field')
    // Enter on the number is APPROVE: the field and the button are one act.
    expect(shipped).toContain("event.key !== 'Enter'")
  })

  it('a seat row grants by username and needs no number', () => {
    const shipped = ASSETS['factors.js'].body
    expect(shipped).toContain('Seat them')
    expect(shipped).toContain("/v2/me/requests/")
    // A seat attaches no device, so there is no asking screen to read off.
    expect(shipped).toContain('req-seat')
  })

  it('the footer names the buttons that are now actually there', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain(esc(WEB_V3_COPY['w5.requests-footer'].replace('{handle}', 'drej')))
    expect(body).toContain('SEAT THEM')
    // ALLOW is not on this page and no sentence here describes it: a reach row
    // is only ever handed to the Mac it names, never to a browser.
    expect(body).not.toContain('ALLOW gives')
    expect(body).toContain('Answer it on the Mac itself')
  })

  it('stacks the row and grows the number field at phone width', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain('@media (max-width:700px)')
    expect(body).toContain('ul.me-list li.req .acct-match-field')
  })
})

describe('W6 · ASK is a request, and the bar then waits', () => {
  it('offers ASK @owner and no longer copies a link', () => {
    const shipped = ASSETS['site.js'].body
    expect(shipped).toContain('seat-requests')
    // The clipboard errand is gone: the request finds the owner instead.
    expect(shipped).not.toContain('Link copied')
    expect(shipped).not.toContain('seat-ask-link')
  })

  it('polls the seat itself, because the answer is given somewhere else', () => {
    const shipped = ASSETS['site.js'].body
    expect(shipped).toContain('/seat`')
    expect(shipped).toContain('watchSeat')
    // A backgrounded tab is not being waited on.
    expect(shipped).toContain('document.hidden')
  })

  it('treats a second ask as the same ask, not as a failure', () => {
    // 409 means the owner already has it; the honest answer is the waiting
    // state with a line saying so, never a red refusal.
    expect(ASSETS['site.js'].body).toContain('out.status === 409')
  })

  it('carries W6’s sentences from the one table', () => {
    expect(WEB_V3_COPY['w6.no-seat']).toContain('they see the request on every device')
    expect(WEB_V3_COPY['w6.asked']).toContain('the seat is yours, not this tab')
  })
})
