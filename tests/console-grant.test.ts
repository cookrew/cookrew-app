import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { renewMessage } from '../registry/src/v2-renew'
import { GRANT_TTL_MS } from '../registry/src/v2-tokens'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import {
  PASSWORD,
  Client,
  bearer,
  bootAuthSite,
  browserDevice,
  codeOf,
  desktopDevice,
  pkce,
  signTranscript,
  type AuthSite,
  type Device
} from './support/auth-site-harness'

/**
 * THE DEVICE PASS BY PASSWORD, FROM THE CONSOLE (owner 2026-11-10, decision F5).
 *
 * The console's page never handles the account password: a passkey is touched
 * in place, and a password is typed on auth.cookrew.dev and comes back as a
 * one-use code. The page that asked spends that code — with its own verifier
 * and the session that opened the request — for the same twelve-hour pass a
 * passkey gives, bound to its own device key.
 */

let clock = Date.UTC(2026, 10, 10, 12, 0, 0)
let site: AuthSite
const username = 'gateowner'
let desktop: { token: string; device: Device }

interface Console {
  page: Client
  device: Device
  token: string
}

async function consoleSignIn(name = username, approver = desktop.token): Promise<Console> {
  const page = new Client(site, 'console-page')
  const device = browserDevice('Console in Chrome')
  const { verifier, challenge, state } = pkce()
  const opened = await page.console('POST', '/v2/auth/requests', { client: 'console', device: device.payload, challenge, state })
  expect(opened.status, opened.text).toBe(201)
  // Proved with the session in hand, as the page sends it: the route is one a console session may ask.
  const proved = await page.console('POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) })
  expect(proved.status).toBe(204)
  const request = String(opened.body.request)
  const browser = new Client(site, 'auth-page')
  await browser.page('POST', '/auth/api/claim', null, { request })
  const asked = await browser.page('POST', '/v2/sessions', request, { username: name, password: PASSWORD })
  expect(asked.status, asked.text).toBe(401)
  const rung = await browser.page('POST', `/v2/sessions/${asked.body.pending}/approve`, request, {})
  await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(approver))
  const done = await browser.page('GET', `/v2/sessions/${asked.body.pending}`, request)
  expect(done.body.status, done.text).toBe('authorized')
  const spent = await page.console('POST', '/v2/auth/token', { code: codeOf(done.body.handoff).code, verifier })
  expect(spent.status, spent.text).toBe(201)
  return { page, device, token: String(spent.body.token) }
}

/** The console asks for the pass by password: a request, opened by its session and proved by its key. */
async function openGrant(own: Console, extra: Record<string, unknown> = {}): Promise<{ request: string; verifier: string; state: string; authorizeUrl: string }> {
  const { verifier, challenge, state } = pkce()
  const opened = await own.page.console('POST', '/v2/auth/requests', { client: 'console', intent: 'grant', device: own.device.payload, challenge, state, ...extra }, bearer(own.token))
  expect(opened.status, opened.text).toBe(201)
  // With its bearer, as the page sends every call: a console session may prove a request it opened.
  const proved = await own.page.console(
    'POST',
    `/v2/auth/requests/${opened.body.request}/proof`,
    { signature: signTranscript(own.device, String(opened.body.transcript)) },
    bearer(own.token)
  )
  expect(proved.status).toBe(204)
  return { request: String(opened.body.request), verifier, state, authorizeUrl: String(opened.body.authorizeUrl) }
}

/** The auth page, for one request. */
async function pageFor(request: string): Promise<Client> {
  const browser = new Client(site, 'auth-page')
  const claimed = await browser.page('POST', '/auth/api/claim', null, { request })
  expect(claimed.status, claimed.text).toBe(200)
  return browser
}

const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>

beforeAll(async () => {
  site = await bootAuthSite({ split: true, now: () => clock })
  const device = desktopDevice('Studio Mac')
  const made = await new Client(site).api('POST', '/v2/accounts', { username, password: PASSWORD, device: device.payload })
  expect(made.status, made.text).toBe(201)
  desktop = { token: String((made.body.session as { token: string }).token), device }
})

afterAll(async () => {
  await site.close()
})

describe('asking for the pass by password', () => {
  it('is the console’s own session asking, on its own device', async () => {
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    expect(opened.authorizeUrl.startsWith(`${site.A}/?request=`)).toBe(true)
    const { challenge, state } = pkce()
    const body = { client: 'console', intent: 'grant', device: own.device.payload, challenge, state }
    // Signed out: nobody to give a pass to.
    expect((await own.page.console('POST', '/v2/auth/requests', body)).status).toBe(401)
    // Another device's key under this session: not this device.
    const other = await own.page.console('POST', '/v2/auth/requests', { ...body, device: browserDevice().payload }, bearer(own.token))
    expect(other.status).toBe(403)
    expect(other.body.error).toBe('not_this_device')
    // A machine's session is not the console's: it proves itself its own way.
    const machine = await new Client(site).api('POST', '/v2/auth/requests', { ...body, device: desktop.device.payload }, bearer(desktop.token))
    expect(machine.status).toBe(400)
  })

  it('is only ever the console’s: no other client opens one', async () => {
    const { challenge, state } = pkce()
    for (const client of ['desktop', 'web', 'cli']) {
      const res = await new Client(site).api(
        'POST',
        '/v2/auth/requests',
        { client, intent: 'grant', device: desktop.device.payload, challenge, state, back: { scheme: true, port: 53111 } },
        bearer(desktop.token)
      )
      expect(res.status, client).toBe(400)
    }
  })

  it('tells the page who it is for and where it goes back to, and nothing else', async () => {
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = new Client(site)
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body).toMatchObject({
      client: 'console',
      clientLabel: 'Cookrew console',
      intent: 'grant',
      username,
      returnHost: new URL(site.C).host
    })
    expect(JSON.stringify(claimed.body)).not.toContain(own.token)
  })
})

describe('the screen that asks for it', () => {
  it('is served by the auth host with the page’s other scripts, and by nobody else', async () => {
    const page = await new Client(site).call(site.A, 'GET', '/')
    expect(page.text).toMatch(/<script src="\/assets\/auth-grant\.js\?v=[0-9a-f]+" defer><\/script>/)
    const script = await new Client(site).call(site.A, 'GET', '/assets/auth-grant.js')
    expect(script.status).toBe(200)
    expect(String(script.headers['content-type'])).toContain('javascript')
    expect(script.text).toContain('cookrewAuthGrant')
    expect(script.text).toContain('/auth/api/grant')
    // It parses, and it sends the password to this origin's own route and nowhere else.
    expect(() => new Function(script.text)).not.toThrow()
    expect(script.text).not.toMatch(/https?:\/\//)
    expect((await new Client(site).api('GET', '/assets/auth-grant.js')).status).toBe(404)
  })
})

describe('the password, typed on the auth host', () => {
  it('comes back to the console as a code, which the page that asked spends for the pass', async () => {
    forgetGrantRests()
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    const typed = await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })
    expect(typed.status, typed.text).toBe(200)
    expect(typed.body.status).toBe('authorized')
    expect(JSON.stringify(typed.body)).not.toContain('grant":')
    const url = String((typed.body.handoff as { url: string }).url)
    expect(url.startsWith(`${site.C}/auth/complete?code=`)).toBe(true)
    const back = codeOf(typed.body.handoff)
    expect(back.state).toBe(opened.state)

    const spent = await own.page.console('POST', '/v2/auth/token', { code: back.code, verifier: opened.verifier }, bearer(own.token))
    expect(spent.status, spent.text).toBe(201)
    expect(spent.body.deviceId).toBe(own.device.payload.id)
    expect(spent.body.exp).toBe(clock + GRANT_TTL_MS)
    const pass = site.v2.tokens.verify(String(spent.body.grant), 'grant')
    expect(pass).not.toBeNull()
    expect(pass?.sub).toBe(username)
    expect(pass?.dev).toBe(own.device.payload.id)
    // Bound to the console's own key: a machine's door asks that key to sign before it lets the pass in.
    expect(pass?.jkt).toBe(jwkThumbprint(own.device.payload.jwk as unknown as Record<string, unknown>))
    // Named for the sign-in, so signing out ends it.
    expect(typeof pass?.sid).toBe('string')
    expect(spent.headers['set-cookie']).toBeUndefined()
  })

  it('a wrong password costs a try, and three rest the account on that device for a minute', async () => {
    forgetGrantRests()
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    const first = await browser.page('POST', '/auth/api/grant', opened.request, { password: 'not the password at all' })
    expect(first.status).toBe(401)
    expect(first.body).toMatchObject({ error: 'wrong', triesLeft: 2 })
    await browser.page('POST', '/auth/api/grant', opened.request, { password: 'still not the password' })
    const third = await browser.page('POST', '/auth/api/grant', opened.request, { password: 'nor this one either' })
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('resting')
    // Resting: even the right one waits.
    expect((await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })).status).toBe(429)
    clock += 61_000
    const right = await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })
    expect(right.body.status).toBe('authorized')
  })

  it('is not a way to sign in: the ladder is not reachable from this page', async () => {
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    expect((await browser.page('POST', '/v2/sessions', opened.request, { username, password: PASSWORD })).status).toBe(404)
    expect((await browser.page('POST', '/v2/accounts', opened.request, { username: 'someone-new', password: PASSWORD })).status).toBe(404)
  })

  it('is finished by the typed password and by nothing else: no provider trip, no rung, no passkey made here', async () => {
    forgetGrantRests()
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    for (const [method, path] of [
      ['POST', '/v2/oauth/github/start'],
      ['GET', '/v2/oauth/providers'],
      ['POST', '/v2/oauth/claim'],
      ['POST', '/auth/api/continue'],
      ['POST', '/auth/api/step-up'],
      ['POST', '/auth/api/passkey/options'],
      ['POST', '/auth/api/passkey']
    ] as const) {
      const res = await browser.page(method, path, opened.request, method === 'GET' ? undefined : {})
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // Still open, and still only the password finishes it.
    const typed = await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })
    expect(typed.body.status).toBe('authorized')
  })

  it('can be cancelled from the page, and then opens nothing', async () => {
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    const cancelled = await browser.page('POST', '/auth/api/cancel', opened.request, {})
    expect(cancelled.body.status).toBe('cancelled')
    expect(String((cancelled.body.handoff as { url: string }).url).startsWith(`${site.C}/auth/complete?error=denied`)).toBe(true)
    expect((await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })).status).toBe(410)
  })

  it('is refused on a request that was not opened for it', async () => {
    const page = new Client(site)
    const device = browserDevice()
    const { challenge, state } = pkce()
    const opened = await page.console('POST', '/v2/auth/requests', { client: 'console', device: device.payload, challenge, state })
    await page.console('POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) })
    const browser = await pageFor(String(opened.body.request))
    const res = await browser.page('POST', '/auth/api/grant', String(opened.body.request), { password: PASSWORD })
    expect(res.status).toBe(404)
  })

  it('is refused once the session that asked has ended', async () => {
    forgetGrantRests()
    const own = await consoleSignIn()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    await own.page.console('DELETE', '/v2/sessions/current', undefined, bearer(own.token))
    const res = await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('session_over')
  })
})

describe('spending the code', () => {
  /** A request taken as far as its code. */
  async function coded(own: Console): Promise<{ code: string; verifier: string }> {
    forgetGrantRests()
    const opened = await openGrant(own)
    const browser = await pageFor(opened.request)
    const typed = await browser.page('POST', '/auth/api/grant', opened.request, { password: PASSWORD })
    expect(typed.body.status, typed.text).toBe('authorized')
    return { code: String(codeOf(typed.body.handoff).code), verifier: opened.verifier }
  }

  it('needs the session that asked: the code alone, or another session’s, opens nothing', async () => {
    const own = await consoleSignIn()
    const refused = async (res: Promise<{ status: number; body: Record<string, unknown> }>, who: string): Promise<void> => {
      const answer = await res
      expect(answer.status, who).toBe(401)
      // Refused for who is asking, after the code and its verifier were found good.
      expect(answer.body.error, who).toBe('unauthenticated')
      expect(answer.body.grant, who).toBeUndefined()
    }
    await refused(own.page.console('POST', '/v2/auth/token', await coded(own)), 'no session')
    const second = await coded(own)
    const other = await consoleSignIn()
    await refused(other.page.console('POST', '/v2/auth/token', second, bearer(other.token)), 'another console session of the account')
    await refused(new Client(site).api('POST', '/v2/auth/token', await coded(own), bearer(desktop.token)), 'a machine’s session')
  })

  it('needs the verifier of the page that asked', async () => {
    const own = await consoleSignIn()
    const held = await coded(own)
    expect((await own.page.console('POST', '/v2/auth/token', { code: held.code, verifier: pkce().verifier }, bearer(own.token))).status).toBe(401)
  })

  it('still works after the page renewed its token while the person was typing: it is the same sign-in', async () => {
    const own = await consoleSignIn()
    const held = await coded(own)
    const nonce = await own.page.console('GET', '/v2/sessions/renew-nonce')
    const sig = signTranscript(own.device, renewMessage(username, own.device.payload.id, String(nonce.body.nonce)))
    const renewed = await own.page.console('POST', '/v2/sessions/renew', { device: own.device.payload.id, nonce: nonce.body.nonce, sig })
    expect(renewed.status).toBe(201)
    const spent = await own.page.console('POST', '/v2/auth/token', held, bearer(String(renewed.body.token)))
    expect(spent.status, spent.text).toBe(201)
    expect(claimsOf(String(spent.body.grant)).scope).toBe('grant')
  })

  it('is spent once', async () => {
    const own = await consoleSignIn()
    const held = await coded(own)
    expect((await own.page.console('POST', '/v2/auth/token', held, bearer(own.token))).status).toBe(201)
    expect((await own.page.console('POST', '/v2/auth/token', held, bearer(own.token))).status).toBe(401)
  })
})
