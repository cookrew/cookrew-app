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
import { WEB_V3_COPY, webCopy } from '../registry/src/v3-copy'
import { esc } from '../registry/src/site-shell'

/**
 * W4 · W5 ON cookrew.dev — joining by code, the number on both sides, and the
 * two ADD buttons.
 *
 * WHAT THIS FILE ASSERTS IS THE MARKUP AND THE BUNDLE, not the browser. The
 * CSP forbids an inline script, so a control that is not in the HTML we serve
 * is a control the reader never gets; and the scripts ship from
 * assets-bundle.ts, so a handler that exists only in registry/assets/ and was
 * never regenerated is a handler that is not deployed. Those two are exactly
 * the ways this lane can be wrong while looking right in the source tree.
 *
 * The live ceremony — type a code, approve with the number, land signed in —
 * is driven in a real browser by scratchpad/v3-13-cdp.mjs.
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

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'w4-w5-'))
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
  const made = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'drej', password: PASSWORD, device: mine })
  })
  session = ((await made.json()) as { session: { token: string } }).session.token
})
afterAll(async () => {
  await close()
})

const get = (p: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${p}`, { headers, redirect: 'manual' })

const signedIn = () => ({ cookie: `__Host-cr_session=${session}` })

describe('W4 · join with a code, in the sheet', () => {
  it('offers the join line and a code field on every app page', async () => {
    const body = await (await get('/market')).text()
    expect(body).toContain('data-acct-mode="join"')
    expect(body).toContain('id="acct-code"')
    expect(body).toContain(esc(WEB_V3_COPY['w4.join-offer']))
    // The code row starts hidden: SIGN IN is still the door this sheet opens on.
    expect(body).toMatch(/id="acct-code-row"[^>]*hidden/)
    // And the way back out of join mode ships with it, hidden until needed.
    expect(body).toContain('data-acct-mode="signin"')
    expect(body).toMatch(/id="acct-join-back"[^>]*hidden/)
  })

  it('carries the join lede and the asked sentence as data, not as a second copy', async () => {
    const body = await (await get('/market')).text()
    // The scripts cannot import the copy table, so the sentences come down on
    // the element. If these ever disappear the script falls back to a written
    // -out string, which is the drift the one table exists to stop.
    expect(body).toContain(`data-join-lede="${esc(WEB_V3_COPY['w4.join-lede'])}"`)
    expect(body).toContain(`data-asked-lede="${esc(WEB_V3_COPY['w4.asked'])}"`)
    expect(ASSETS['site.js'].body).toContain('dataset.joinLede')
    expect(ASSETS['site.js'].body).not.toContain(WEB_V3_COPY['w4.join-lede'])
    expect(ASSETS['factors.js'].body).toContain('dataset.askedLede')
  })

  it('redeems the code at /v2/join, with no username and no password on the wire', () => {
    const shipped = ASSETS['site.js'].body
    expect(shipped).toContain("'/v2/join'")
    // The join call carries the code and the device and nothing else: asking
    // for a password here would undo the whole point of joining by code.
    expect(shipped).toMatch(/'\/v2\/join',\s*\{\s*code,\s*device\s*\}/)
  })

  it('a code minted on a signed-in device attaches a browser that typed nothing else', async () => {
    const minted = await fetch(`${origin}/v2/me/join-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedIn() },
      body: JSON.stringify({ current: PASSWORD })
    })
    expect(minted.status).toBe(201)
    const { code } = (await minted.json()) as { code: string }

    const joined = await fetch(`${origin}/v2/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: device('A new browser') })
    })
    expect(joined.status).toBe(201)
    expect(((await joined.json()) as { username: string }).username).toBe('drej')
  })
})

describe('W4 · the number, on the asking side', () => {
  it('comes back on this browser’s own 401 and is drawn large', async () => {
    const out = await fetch(`${origin}/v2/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'drej', password: PASSWORD, device: device('Second browser') })
    })
    expect(out.status).toBe(401)
    const body = (await out.json()) as { error: string; match?: string }
    expect(body.error).toBe('second_factor')
    expect(body.match).toMatch(/^\d{2}$/)
    // The asked screen draws it; the class is what makes it readable across a room.
    expect(ASSETS['factors.js'].body).toContain('acct-match')
  })

  it('is never on the owner’s approvals list — that asymmetry is the mechanism', async () => {
    const list = await (await get('/v2/me/approvals', signedIn())).json()
    for (const request of list as Record<string, unknown>[]) {
      expect(Object.keys(request)).not.toContain('match')
    }
  })
})

describe('W5 · /me — requests above devices, and the two ADD buttons', () => {
  it('puts Requests before Devices, and hides the section while it is empty', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toMatch(/id="me-requests"[^>]*hidden/)
    expect(body.indexOf('id="me-requests"')).toBeLessThan(body.indexOf('id="me-devices"'))
    // The queue is a thing to answer, so it is the first thing under the head.
    expect(body.indexOf('id="me-requests"')).toBeLessThan(body.indexOf('id="me-security"'))
    expect(ASSETS['factors.js'].body).toContain('me-requests')
  })

  it('asks the approver for the number, in the row, from the copy table', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain(`data-join-row="${esc(WEB_V3_COPY['w5.join-row'])}"`)
    const shipped = ASSETS['factors.js'].body
    expect(shipped).toContain('dataset.joinRow')
    // APPROVE sends the number; the other two answers must not spend a try.
    expect(shipped).toMatch(/decision === 'approve' \? \{ decision, match/)
  })

  it('offers ADD A MAC and ADD A PHONE under the devices, both minting one code', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain('data-add-device="desktop"')
    expect(body).toContain('data-add-device="phone"')
    expect(body).toContain(`data-add-lede="${esc(WEB_V3_COPY['w5.add-lede'])}"`)
    expect(body.indexOf('id="me-devices"')).toBeLessThan(body.indexOf('data-add-device="desktop"'))
    const shipped = ASSETS['factors.js'].body
    expect(shipped).toContain("'/v2/me/join-codes'")
    // Minting widens what the account opens from, so it steps up — the same
    // rule that guards removing a factor.
    expect(shipped).toMatch(/join-codes',\s*\{\s*current\s*\}/)
  })

  it('describes the queue it actually has, naming no button that is not there', async () => {
    const body = await (await get('/me', signedIn())).text()
    expect(body).toContain(esc(webCopy('w5.requests-footer', { handle: 'drej' })))
    // D11's footer names ALLOW and SEAT THEM. They arrive with the unified
    // queue (V3-11); until then the page must not promise them.
    expect(body).not.toContain('SEAT THEM')
    expect(body).not.toContain('ALLOW gives')
  })

  it('leaves the CSP alone — everything above is markup and one same-origin script', async () => {
    const csp = (await get('/me', signedIn())).headers.get('content-security-policy') ?? ''
    // SCRIPT is the one that matters here. `style-src 'unsafe-inline'` is the
    // shell's own long-standing allowance for the inline stylesheet; widening
    // it was never on the table and asserting against it would only be this
    // test claiming credit for a rule it did not set.
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})

describe('W6 · the ask stays a copied link until seat-requests exists', () => {
  it('ships COPY LINK and files nothing at a route nobody serves', () => {
    // The design's own fallback: "if R1 is refused, this button stays COPY
    // LINK TO ASK exactly as today". A button posting to a guessed route
    // would fail silently and teach the asker to wait for nothing.
    expect(ASSETS['site.js'].body).not.toContain('/v2/seat-requests')
    expect(ASSETS['factors.js'].body).not.toContain('/v2/seat-requests')
  })
})
