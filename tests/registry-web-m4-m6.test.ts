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
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { ASSETS } from '../registry/src/assets-bundle'
import { WEB_V3_COPY } from '../registry/src/v3-copy'
import { esc } from '../registry/src/site-shell'
import { accountPageOf } from './support/account-page'

/**
 * M4 · M5 · M6 · W6 — what is left on the web of the phone's three screens and
 * the ask.
 *
 * 0.6.0 took the registry's own pages: /join (M4's page), the desktop rows of
 * /me with USE WI-FI (M5's), and the scripts only they loaded. What stays is
 * pinned here: the routes those screens called, the requests view on the
 * account page (drawn the way the auth host draws it,
 * tests/support/account-page.ts), and the scripts that page still loads.
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
let v2: V2Identity

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'm4-m6-'))
  v2 = createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
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

const signedIn = () => ({ cookie: `__Host-cr_session=${session}` })
const mine = () => accountPageOf(v2, 'drej', deviceId)

describe('M4 · the phone joins by a code it scanned', () => {
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

})

describe('M5 · USE WI-FI — a tap on the Mac, never a scan', () => {
  it('this browser’s device carries a key an answer can be sealed to', () => {
    // The device key must be one a browser can actually derive with.
    expect(ASSETS['site.js'].body).toContain("{ name: 'ECDH', namedCurve: 'P-256' }")
    expect(ASSETS['site.js'].body).toContain('sealKey')
  })

  it('the ask itself is not taken any more: the registry has no such route (0.6.0)', async () => {
    const asked = await fetch(`${origin}/v2/me/desktops/${deviceId}/reach-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn() }
    })
    const never = await fetch(`${origin}/v2/me/desktops/${deviceId}/no-such-thing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn() }
    })
    expect(asked.status).toBe(404)
    expect(asked.status).toBe(never.status)
    expect(await asked.text()).toBe(await never.text())
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

  it('the footer names the buttons that are now actually there', () => {
    const body = mine().body
    expect(body).toContain(esc(WEB_V3_COPY['w5.requests-footer'].replace('{handle}', 'drej')))
    // A guest asking for a seat is a row the registry no longer sends (0.6.0), so no sentence here names its button.
    expect(body).not.toContain('SEAT THEM')
    // ALLOW is not on this page and no sentence here describes it: a reach row
    // is only ever handed to the Mac it names, never to a browser.
    expect(body).not.toContain('ALLOW gives')
    expect(body).toContain('Answer it on the machine itself')
  })

  it('stacks the row and grows the number field at phone width', () => {
    const body = mine().body
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

  it('but nothing serves it any more: the script is shipped text, and the table has no sentence about asking (0.6.0)', () => {
    // No page loads a seat bar for the script above, and the route it names
    // answers as any unknown route (tests/registry-v2-requests-http.test.ts
    // holds that, signed in and signed out). What is held here is the copy.
    expect(Object.keys(WEB_V3_COPY).filter((id) => id.startsWith('w6.'))).toEqual([])
    expect(Object.values(WEB_V3_COPY).join(' ')).not.toMatch(/see the request|SEAT THEM/)
  })
})
