import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PASSWORD,
  Client,
  bearer,
  bootAuthSite,
  browserDevice,
  desktopDevice,
  signTranscript,
  type AuthSite,
  type Device
} from './support/auth-site-harness'

/**
 * ACCOUNT & SECURITY LIVE ON THE AUTH HOST (0.6.0).
 *
 * cookrew.dev is a static site and the console is a page that draws what
 * machines send, so neither is where a password is changed, a factor added or
 * an account deleted. That page is auth.cookrew.dev/account: the one host with
 * a session cookie, reached from the console's avatar. It carries the account,
 * its devices and its security, and nothing of any machine: no machine list,
 * no device pass, no relay.
 */

let site: AuthSite
const username = 'accountowner'
let browser: Client
let device: Device
let desktopToken = ''
let desktopId = ''

/** A browser signs in for the account page: a web request on the auth host, finished on the same host. */
async function signInBrowser(client: Client, own: Device, name: string): Promise<void> {
  const opened = await client.page('POST', '/v2/auth/requests', null, { client: 'web', device: own.payload, return: '/account' })
  expect(opened.status, opened.text).toBe(201)
  const request = String(opened.body.request)
  const proved = await client.page('POST', `/v2/auth/requests/${request}/proof`, null, { signature: signTranscript(own, String(opened.body.transcript)) })
  expect(proved.status).toBe(204)
  expect((await client.page('POST', '/auth/api/claim', null, { request })).status).toBe(200)
  const asked = await client.page('POST', '/v2/sessions', request, { username: name, password: PASSWORD })
  expect(asked.status, asked.text).toBe(401)
  const rung = await client.page('POST', `/v2/sessions/${asked.body.pending}/approve`, request, {})
  await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(desktopToken))
  const done = await client.page('GET', `/v2/sessions/${asked.body.pending}`, request)
  expect(done.body.status, done.text).toBe('authorized')
  const url = new URL(String((done.body.handoff as { url: string }).url))
  // The way back is this same host: the account page lives here.
  expect(url.origin).toBe(site.A)
  expect(url.pathname).toBe('/auth/complete')
  const landed = await client.call(site.A, 'GET', `${url.pathname}${url.search}`)
  expect(landed.status).toBe(303)
  expect(landed.headers.location).toBe('/account')
  const cookies = (landed.headers['set-cookie'] as string[]).join('\n')
  expect(cookies).toMatch(/__Host-cr_session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure/)
}

beforeAll(async () => {
  site = await bootAuthSite({ split: true })
  const first = desktopDevice('Studio Mac')
  desktopId = first.payload.id
  const made = await new Client(site).api('POST', '/v2/accounts', { username, password: PASSWORD, device: first.payload })
  expect(made.status, made.text).toBe(201)
  desktopToken = String((made.body.session as { token: string }).token)
  await new Client(site).api('PUT', `/v2/me/desktops/${desktopId}`, { name: 'Studio Mac', workspaces: [{ id: 'w1', name: 'Secret Plans' }] }, bearer(desktopToken))
  browser = new Client(site, 'browser')
  device = browserDevice('Chrome on macOS')
  await signInBrowser(browser, device, username)
})

afterAll(async () => {
  await site.close()
})

describe('the account page, signed out', () => {
  it('is a page with a way in, and nothing of the old site around it', async () => {
    const res = await new Client(site).call(site.A, 'GET', '/account', undefined, { accept: 'text/html' })
    expect(res.status).toBe(401)
    expect(String(res.headers['content-type'])).toContain('text/html')
    expect(res.text).toContain('data-signin')
    expect(res.text).not.toContain('href="/market"')
    expect(res.text).not.toContain('Marketplace')
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'")
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
    expect(res.headers['cache-control']).toBe('private, no-store')
  })

  it('is given its scripts by this host', async () => {
    for (const name of ['site.js', 'factors.js', 'step-up.js', 'device-id.js']) {
      const res = await new Client(site).call(site.A, 'GET', `/assets/${name}`)
      expect(res.status, name).toBe(200)
      expect(String(res.headers['content-type']), name).toContain('javascript')
    }
    // And none of the machine scripts: nothing here reaches a machine.
    for (const name of ['machines.js', 'reach.js', 'line.js', 'xterm.js']) {
      expect((await new Client(site).call(site.A, 'GET', `/assets/${name}`)).status, name).toBe(404)
    }
  })
})

describe('the account page, signed in', () => {
  it('shows the account, its devices and its security', async () => {
    const res = await browser.call(site.A, 'GET', '/account')
    expect(res.status).toBe(200)
    expect(res.text).toContain(`@${username}`)
    expect(res.text).toContain('id="security"')
    expect(res.text).toContain('id="me-devices"')
    expect(res.text).toContain('data-signout')
    expect(res.text).toContain('Delete account')
  })

  it('carries nothing of any machine, and points at the console for them', async () => {
    const res = await browser.call(site.A, 'GET', '/account')
    expect(res.text).not.toContain('Secret Plans')
    expect(res.text).not.toContain('me-console')
    expect(res.text).not.toContain('me-desktops')
    expect(res.text).not.toContain('/relay/')
    expect(res.text).not.toContain('machines.js')
    expect(res.text).not.toContain('reach.js')
    expect(res.text).toContain(`href="${site.C}/"`)
  })

  it('links out to the site by its own address, never as a path on this host', async () => {
    const res = await browser.call(site.A, 'GET', '/account')
    expect(res.text).toContain(`href="${site.P}/"`)
    expect(res.text).not.toMatch(/href="\/(market|#features|#start|#download)"/)
  })

  it('tells its script where home is, so signing out lands on a page that exists', async () => {
    const res = await browser.call(site.A, 'GET', '/account')
    expect(res.text).toContain('data-home="/account"')
  })

  it('takes the old address of this page and of its returns to the new one', async () => {
    for (const [from, to] of [
      ['/me', '/account'],
      ['/me/account', '/account'],
      ['/me?stepped=change-password', '/account?stepped=change-password'],
      ['/me?passkey=added', '/account?passkey=added']
    ]) {
      const res = await browser.call(site.A, 'GET', from)
      expect(res.status, from).toBe(303)
      expect(res.headers.location, from).toBe(to)
    }
  })
})

describe('what the account page’s session opens on the auth host', () => {
  it('reads and changes the account', async () => {
    const me = await browser.call(site.A, 'GET', '/v2/me')
    expect(me.status).toBe(200)
    expect(me.body.username).toBe(username)
    const renamed = await browser.page('PATCH', '/v2/me', null, { displayName: 'The Owner' })
    expect(renamed.status).toBe(200)
    expect((await browser.call(site.A, 'GET', '/v2/me/requests')).status).toBe(200)
    // Reached (not the 404 of a route this host does not carry), and answered for this account.
    const fresh = await browser.call(site.A, 'GET', '/v2/me/step-up/change-password')
    expect(fresh.status).toBe(200)
    expect(typeof fresh.body.fresh).toBe('boolean')
  })

  it('opens nothing of a machine: no list, no pass, no line, no relay', async () => {
    for (const [method, path] of [
      ['GET', '/v2/me/desktops'],
      ['GET', '/v2/me/presence'],
      ['POST', '/v2/me/device-grant'],
      ['POST', '/v2/me/device-grant/options'],
      ['POST', '/v2/me/device-grant/machine'],
      ['PUT', `/v2/me/desktops/${desktopId}`],
      ['GET', `/v2/canvas/link/${desktopId}`],
      ['GET', `/api/m/${desktopId}/api/fleet`],
      ['GET', '/v1/health'],
      ['GET', '/v2/teams/@x/y/seat'],
      ['POST', '/v2/join']
    ] as const) {
      const res = await browser.page(method, path, null, method === 'GET' ? undefined : {})
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('is not a way to sign in or claim a name without the sign-in page’s own request', async () => {
    const claimed = await new Client(site).page('POST', '/v2/accounts', null, { username: 'sneaky', password: PASSWORD, device: browserDevice().payload })
    expect(claimed.status).toBe(410)
    const signed = await new Client(site).page('POST', '/v2/sessions', null, { username, password: PASSWORD, device: browserDevice().payload })
    expect(signed.status).toBe(410)
  })

  it('refuses a write another site caused, cookie or not', async () => {
    for (const origin of [site.P, site.C, site.API, 'https://evil.example']) {
      const res = await browser.call(site.A, 'PATCH', '/v2/me', { displayName: 'Hijacked' }, { origin })
      expect(res.status, origin).toBe(403)
    }
    const me = await browser.call(site.A, 'GET', '/v2/me')
    expect(me.body.displayName).toBe('The Owner')
  })

  it('stays on this host: the cookie opens nothing on the API host', async () => {
    const cookie = [...browser.jar.entries()].filter(([key]) => key.endsWith('|__Host-cr_session')).map(([, value]) => value)[0]
    expect(cookie).toBeTruthy()
    const res = await new Client(site).api('GET', '/v2/me', undefined, { cookie: `__Host-cr_session=${cookie}` })
    expect(res.status).toBe(401)
  })

  it('signs out here', async () => {
    const other = new Client(site, 'other')
    await signInBrowser(other, browserDevice('Safari'), username)
    expect((await other.page('POST', '/v2/sessions/current', null, {})).status).toBeLessThan(300)
    expect((await other.call(site.A, 'GET', '/v2/me')).status).toBe(401)
    expect((await other.call(site.A, 'GET', '/account')).status).toBe(401)
  })
})

describe('a console session, brought to the auth host', () => {
  /** A console session for this account, the way the console's page gets one. */
  async function consoleToken(): Promise<string> {
    const page = new Client(site, 'console-page')
    const own = browserDevice('Console in Chrome')
    const verifier = 'v'.repeat(43)
    const { createHash } = await import('node:crypto')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const opened = await page.console('POST', '/v2/auth/requests', { client: 'console', device: own.payload, challenge, state: 's'.repeat(22) })
    expect(opened.status, opened.text).toBe(201)
    const request = String(opened.body.request)
    await page.console('POST', `/v2/auth/requests/${request}/proof`, { signature: signTranscript(own, String(opened.body.transcript)) })
    const authPage = new Client(site, 'auth-page')
    await authPage.page('POST', '/auth/api/claim', null, { request })
    const asked = await authPage.page('POST', '/v2/sessions', request, { username, password: PASSWORD })
    const rung = await authPage.page('POST', `/v2/sessions/${asked.body.pending}/approve`, request, {})
    await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(desktopToken))
    const done = await authPage.page('GET', `/v2/sessions/${asked.body.pending}`, request)
    const code = new URL(String((done.body.handoff as { url: string }).url)).searchParams.get('code')
    const spent = await page.console('POST', '/v2/auth/token', { code, verifier })
    expect(spent.status, spent.text).toBe(201)
    return String(spent.body.token)
  }

  it('opens nothing there, in a cookie or as a bearer: the account’s security is not the console’s', async () => {
    const stolen = await consoleToken()
    const thief = new Client(site, 'thief')
    const asCookie = { cookie: `__Host-cr_session=${stolen}`, origin: site.A }
    for (const [method, path, body] of [
      ['GET', '/account'],
      ['GET', '/v2/me'],
      ['PATCH', '/v2/me', { displayName: 'Taken' }],
      ['POST', '/v2/me/password', { next: 'a new long password here' }],
      ['DELETE', '/v2/me'],
      ['POST', '/v2/me/recovery-codes', {}],
      ['POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act: 'change-password', device: browserDevice().payload }]
    ] as const) {
      const res = await thief.call(site.A, method, path, body, asCookie)
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.body.error, `${method} ${path}`).toBe('console_scope')
      const viaBearer = await thief.call(site.A, method, path, body, { ...bearer(stolen), origin: site.A })
      expect(viaBearer.status, `${method} ${path} bearer`).toBe(403)
      expect(viaBearer.body.error, `${method} ${path} bearer`).toBe('console_scope')
    }
  })
})

describe('a console session, hidden behind another credential on the auth host', () => {
  it('is still refused: the cookie is what this host reads, so the cookie is what is judged', async () => {
    const page = new Client(site, 'console-page')
    const own = browserDevice('Console in Chrome')
    const { createHash } = await import('node:crypto')
    const verifier = 'w'.repeat(43)
    const opened = await page.console('POST', '/v2/auth/requests', {
      client: 'console',
      device: own.payload,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
      state: 't'.repeat(22)
    })
    const request = String(opened.body.request)
    await page.console('POST', `/v2/auth/requests/${request}/proof`, { signature: signTranscript(own, String(opened.body.transcript)) })
    const authPage = new Client(site, 'auth-page')
    await authPage.page('POST', '/auth/api/claim', null, { request })
    const asked = await authPage.page('POST', '/v2/sessions', request, { username, password: PASSWORD })
    const rung = await authPage.page('POST', `/v2/sessions/${asked.body.pending}/approve`, request, {})
    await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(desktopToken))
    const done = await authPage.page('GET', `/v2/sessions/${asked.body.pending}`, request)
    const spent = await page.console('POST', '/v2/auth/token', { code: new URL(String((done.body.handoff as { url: string }).url)).searchParams.get('code'), verifier })
    const stolen = String(spent.body.token)
    expect(stolen.length).toBeGreaterThan(20)

    const thief = new Client(site, 'thief')
    // A bearer that is nothing, so a check that reads the bearer first sees no console session at all.
    for (const junk of ['Bearer x', 'Bearer ', `Bearer ${desktopToken.slice(0, 20)}`]) {
      const hidden = { authorization: junk, cookie: `__Host-cr_session=${stolen}`, origin: site.A }
      for (const [method, path, body] of [
        ['GET', '/v2/me'],
        ['GET', '/account'],
        ['PATCH', '/v2/me', { displayName: 'Taken' }],
        ['POST', '/v2/me/recovery-codes', {}],
        ['GET', '/v2/me/requests'],
        ['POST', '/v2/auth/requests', { client: 'web', intent: 'passkey', device: browserDevice().payload }]
      ] as const) {
        const res = await thief.call(site.A, method, path, body, hidden)
        expect(res.status, `${junk} ${method} ${path}`).toBe(403)
        expect(res.body.error, `${junk} ${method} ${path}`).toBe('console_scope')
      }
    }
    expect((await browser.call(site.A, 'GET', '/v2/me')).body.displayName).toBe('The Owner')
  })
})

describe('the web client, on a registry that splits its hosts', () => {
  it('is opened on the auth host only: its verifier is a cookie, and the API host sets none', async () => {
    const res = await new Client(site).console('POST', '/v2/auth/requests', { client: 'web', device: browserDevice().payload, return: '/account' })
    expect(res.status).toBe(400)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns to the account page when it names nowhere', async () => {
    const client = new Client(site)
    const own = browserDevice()
    const opened = await client.page('POST', '/v2/auth/requests', null, { client: 'web', intent: 'create', device: own.payload })
    await client.page('POST', `/v2/auth/requests/${opened.body.request}/proof`, null, { signature: signTranscript(own, String(opened.body.transcript)) })
    await client.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    const made = await client.page('POST', '/v2/accounts', String(opened.body.request), { username: 'returner', password: PASSWORD })
    expect(made.body.status, made.text).toBe('authorized')
    const url = new URL(String((made.body.handoff as { url: string }).url))
    const landed = await client.call(site.A, 'GET', `${url.pathname}${url.search}`)
    expect(landed.headers.location).toBe('/account')
  })
})
