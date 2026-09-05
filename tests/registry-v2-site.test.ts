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

/**
 * IDENTITY v2 ON THE SITE — the sheet's markup, the CSP that keeps it inert,
 * and /me.
 *
 * The point of asserting the MARKUP is that it is ours: the CSP forbids an
 * inline script, so a sheet assembled by a script at load is a sheet a reader
 * cannot see in the page they were served. And /me is rendered for one reader
 * — signed out it must be a page with a way in, never a JSON body.
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
  dir = mkdtempSync(path.join(tmpdir(), 'v2-site-'))
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
  await fetch(`${origin}/v2/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ displayName: 'Drej <script>' }) })
  await fetch(`${origin}/v2/me/desktops/${mine.id}`, {
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

describe('the sign-in sheet (W1)', () => {
  it('is in the markup of an app page, with both tabs and a confirmation field', async () => {
    const body = await (await get('/market')).text()
    expect(body).toContain('id="account-sheet"')
    expect(body).toContain('data-acct-tab="signin"')
    expect(body).toContain('data-acct-tab="register"')
    expect(body).toContain('id="acct-username"')
    expect(body).toContain('id="acct-password"')
    expect(body).toContain('id="acct-confirm-row"')
    expect(body).toContain('The site never asks for an email.')
    // Register is sign-in plus a second password; the confirmation row starts
    // hidden and the tab reveals it.
    expect(body).toMatch(/id="acct-confirm-row"[^>]*hidden/)
  })

  it('is not on a document page, which has no script to work it', async () => {
    const body = await (await get('/')).text()
    expect(body).not.toContain('id="account-sheet"')
  })

  it('leaves the CSP as it was — one script, from this origin only', async () => {
    const app = await get('/market')
    const csp = app.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")

    const doc = await get('/')
    expect(doc.headers.get('content-security-policy')).toContain("script-src 'none'")
  })

  it('ships in the bundle the registry actually serves', () => {
    expect(ASSETS['site.js'].body).toContain('account-sheet')
    expect(ASSETS['site.js'].body).toContain('/v2/sessions')
    // The session token is never read by a script: the server sets the cookie.
    expect(ASSETS['site.js'].body).not.toContain('cr_session=')
  })
})

describe('/me', () => {
  it('is a page with a way in when nobody is signed in', async () => {
    const res = await get('/me')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.text()
    expect(body).toContain('data-signin')
    expect(body).toContain('A seat is yours, not a browser')
    expect(body).toContain('noindex')
  })

  it('renders the reader’s own account with the cookie', async () => {
    const res = await get('/me', { cookie: `cr_session=${session}` })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('@drej')
    expect(body).toContain('This Mac')
    expect(body).toContain('This device')
    expect(body).toContain('MacBook Pro')
    expect(body).toContain('Cookrew Dev')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('offers a passkey, an authenticator and the requests waiting to be answered', async () => {
    const body = await (await get('/me', { cookie: `cr_session=${session}` })).text()
    // Phase 4: these are verbs now, not a row that says "coming".
    expect(body).toContain('Passkey (Touch ID / Face ID)')
    expect(body).toContain('data-add-passkey')
    expect(body).toContain('Authenticator app')
    expect(body).toContain('data-add-totp')
    expect(body).toContain('id="me-approvals"')
    expect(body).toContain('data-recovery')
    expect(body).toContain('data-signout')
    expect(body).not.toContain('coming in a later release')
  })

  it('loads the ladder’s screens beside the account sheet', async () => {
    const res = await get('/me', { cookie: `cr_session=${session}` })
    expect(await res.text()).toContain('/assets/factors.js')
    // Still one origin and no inline script: the CSP has not been widened.
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  })

  it('escapes what a person typed into their own profile', async () => {
    const body = await (await get('/me', { cookie: `cr_session=${session}` })).text()
    expect(body).toContain('Drej &lt;script&gt;')
    expect(body).not.toContain('Drej <script>')
  })

  it('refuses a cookie that is not a live session', async () => {
    expect((await get('/me', { cookie: 'cr_session=rubbish.rubbish' })).status).toBe(401)
    // A v1 account cookie is not a v2 session and must not open this page.
    expect((await get('/me', { cookie: 'cr_account=rubbish.rubbish' })).status).toBe(401)
  })

  it('cannot be taken as a handle', async () => {
    // /me is reserved: an owner called "me" must never shadow this page.
    const body = await (await get('/me', { cookie: `cr_session=${session}` })).text()
    expect(body).toContain('id="me"')
  })
})
