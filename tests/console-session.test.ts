import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renewMessage } from '../registry/src/v2-renew'
import { CONSOLE_SESSION_TTL_MS } from '../registry/src/v2-tokens'
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
 * THE CONSOLE'S SESSION (0.6.0).
 *
 * console.cookrew.dev is a static page on its own origin. It signs in the way
 * the desktop app does — a request opened with its device key and a PKCE
 * challenge, finished on auth.cookrew.dev, spent for a token — and holds that
 * token in page storage, because no cookie crosses to the API host. A token a
 * page can read is a token an injected script can read, so this one is:
 *
 *   SHORT. Fifteen minutes, renewed with the device key (which a script can
 *   use but cannot take away).
 *   NARROW. It reads the account's machines, takes the device pass with a
 *   passkey, reaches machines down the relay path, and nothing else. Every
 *   sensitive act of the account is refused it: those live on the auth host.
 */

const MINUTE = 60_000
let clock = Date.UTC(2026, 10, 10, 12, 0, 0)
let site: AuthSite
const username = 'consoleowner'
let desktop: { token: string; device: Device }

const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>

/** The console's page opens a request and proves its key. */
async function openConsole(page: Client, device: Device, extra: Record<string, unknown> = {}): Promise<{ request: string; verifier: string; state: string; authorizeUrl: string }> {
  const { verifier, challenge, state } = pkce()
  const opened = await page.console('POST', '/v2/auth/requests', { client: 'console', device: device.payload, challenge, state, ...extra })
  expect(opened.status, opened.text).toBe(201)
  const proved = await page.console('POST', `/v2/auth/requests/${opened.body.request}/proof`, {
    signature: signTranscript(device, String(opened.body.transcript))
  })
  expect(proved.status).toBe(204)
  return { request: String(opened.body.request), verifier, state, authorizeUrl: String(opened.body.authorizeUrl) }
}

/** A whole console sign-in: the page on the auth host, the first machine approving, the code spent. */
async function consoleSignIn(device: Device = browserDevice('Console in Chrome')): Promise<{ page: Client; device: Device; token: string; exp: number; handoff: string }> {
  const page = new Client(site, 'console-page')
  const opened = await openConsole(page, device)
  const browser = new Client(site, 'auth-page')
  expect((await browser.page('POST', '/auth/api/claim', null, { request: opened.request })).status).toBe(200)
  const asked = await browser.page('POST', '/v2/sessions', opened.request, { username, password: PASSWORD })
  expect(asked.status, asked.text).toBe(401)
  const rung = await browser.page('POST', `/v2/sessions/${asked.body.pending}/approve`, opened.request, {})
  expect(rung.status, rung.text).toBe(202)
  const decided = await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(desktop.token))
  expect(decided.status, decided.text).toBe(204)
  const done = await browser.page('GET', `/v2/sessions/${asked.body.pending}`, opened.request)
  expect(done.status, done.text).toBe(200)
  expect(done.body.status).toBe('authorized')
  const handoff = String((done.body.handoff as { url: string }).url)
  const back = codeOf(done.body.handoff)
  expect(back.state).toBe(opened.state)
  const spent = await page.console('POST', '/v2/auth/token', { code: back.code, verifier: opened.verifier })
  expect(spent.status, spent.text).toBe(201)
  expect(spent.headers['set-cookie']).toBeUndefined()
  return { page, device, token: String(spent.body.token), exp: Number(spent.body.exp), handoff }
}

async function renew(page: Client, device: Device): Promise<{ status: number; token: string; exp: number }> {
  const nonce = await page.console('GET', '/v2/sessions/renew-nonce')
  const sig = signTranscript(device, renewMessage(username, device.payload.id, String(nonce.body.nonce)))
  const renewed = await page.console('POST', '/v2/sessions/renew', { device: device.payload.id, nonce: nonce.body.nonce, sig })
  return { status: renewed.status, token: String(renewed.body.token ?? ''), exp: Number(renewed.body.exp ?? 0) }
}

beforeAll(async () => {
  site = await bootAuthSite({ split: true, now: () => clock })
  const device = desktopDevice('Studio Mac')
  const made = await new Client(site).api('POST', '/v2/accounts', { username, password: PASSWORD, device: device.payload })
  expect(made.status, made.text).toBe(201)
  desktop = { token: String((made.body.session as { token: string }).token), device }
  const filed = await new Client(site).api(
    'PUT',
    `/v2/me/desktops/${device.payload.id}`,
    { name: 'Studio Mac', workspaces: [{ id: 'w1', name: 'Secret Plans' }] },
    bearer(desktop.token)
  )
  expect(filed.status, filed.text).toBeLessThan(300)
})

afterAll(async () => {
  await site.close()
})

describe('opening a request as the console', () => {
  it('goes to the auth host, and wants a challenge and a state of the page’s own', async () => {
    const page = new Client(site)
    const opened = await openConsole(page, browserDevice())
    expect(opened.authorizeUrl.startsWith(`${site.A}/?request=`)).toBe(true)
    const device = browserDevice()
    const { challenge, state } = pkce()
    expect((await page.console('POST', '/v2/auth/requests', { client: 'console', device: device.payload, state })).status).toBe(400)
    expect((await page.console('POST', '/v2/auth/requests', { client: 'console', device: device.payload, challenge })).status).toBe(400)
  })

  it('is a browser or a phone, never a machine', async () => {
    const { challenge, state } = pkce()
    const res = await new Client(site).console('POST', '/v2/auth/requests', { client: 'console', device: desktopDevice().payload, challenge, state })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad_device')
  })

  it('signs in and nothing else: no link, no passkey, no step-up is opened from it', async () => {
    for (const extra of [{ intent: 'link', provider: 'github' }, { intent: 'passkey' }, { intent: 'step-up', act: 'change-password' }]) {
      const { challenge, state } = pkce()
      const res = await new Client(site).console('POST', '/v2/auth/requests', { client: 'console', device: browserDevice().payload, challenge, state, ...extra }, bearer(desktop.token))
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
  })

  it('is refused on a registry that names no console: there is nowhere to come back to', async () => {
    const single = await bootAuthSite()
    const { challenge, state } = pkce()
    const res = await new Client(single).call(single.P, 'POST', '/v2/auth/requests', { client: 'console', device: browserDevice().payload, challenge, state })
    expect(res.status).toBe(400)
    await single.close()
  })
})

describe('signing in', () => {
  it('comes back to the console’s own address with a one-use code, and the page spends it for a token', async () => {
    const signed = await consoleSignIn()
    expect(signed.handoff.startsWith(`${site.C}/auth/complete?code=`)).toBe(true)
    expect(signed.token).not.toBe('')
    const me = await signed.page.console('GET', '/v2/me', undefined, bearer(signed.token))
    expect(me.status).toBe(200)
    expect(me.body.username).toBe(username)
  })

  it('a code is spent once, and only with the verifier of the page that asked', async () => {
    const page = new Client(site)
    const device = browserDevice()
    const opened = await openConsole(page, device, { intent: 'create' })
    const browser = new Client(site)
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const made = await browser.page('POST', '/v2/accounts', opened.request, { username: 'second-console', password: PASSWORD })
    expect(made.status, made.text).toBe(200)
    const { code } = codeOf(made.body.handoff)
    expect((await page.console('POST', '/v2/auth/token', { code, verifier: pkce().verifier })).status).toBe(401)
    // The wrong verifier burned it: the real one is too late, by design.
    expect((await page.console('POST', '/v2/auth/token', { code, verifier: opened.verifier })).status).toBe(401)
  })
})

describe('the token a page holds', () => {
  it('lasts fifteen minutes and says it is the console’s', async () => {
    const signed = await consoleSignIn()
    expect(signed.exp).toBe(clock + CONSOLE_SESSION_TTL_MS)
    expect(CONSOLE_SESSION_TTL_MS).toBe(15 * MINUTE)
    expect(claimsOf(signed.token).via).toBe('console')
    // A machine's own session is not: thirty days, and no such mark.
    expect(claimsOf(desktop.token).via).toBeUndefined()
  })

  it('is refused once its fifteen minutes are over', async () => {
    const signed = await consoleSignIn()
    clock += 15 * MINUTE + 1000
    expect((await signed.page.console('GET', '/v2/me', undefined, bearer(signed.token))).status).toBe(401)
  })

  it('is renewed with the device key, and stays short and the console’s', async () => {
    const signed = await consoleSignIn()
    clock += 10 * MINUTE
    const next = await renew(signed.page, signed.device)
    expect(next.status).toBe(201)
    expect(next.exp).toBe(clock + CONSOLE_SESSION_TTL_MS)
    expect(claimsOf(next.token).via).toBe('console')
    // The one it replaced is over at once, not in five minutes.
    expect((await signed.page.console('GET', '/v2/me', undefined, bearer(signed.token))).status).toBe(401)
    expect((await signed.page.console('GET', '/v2/me', undefined, bearer(next.token))).status).toBe(200)
  })

  it('can still be renewed after it lapsed, while the sign-in itself lives', async () => {
    const signed = await consoleSignIn()
    clock += 3 * 60 * MINUTE
    const next = await renew(signed.page, signed.device)
    expect(next.status).toBe(201)
    expect((await signed.page.console('GET', '/v2/me', undefined, bearer(next.token))).status).toBe(200)
  })

  it('is not renewed without the key: a stolen token dies with its fifteen minutes', async () => {
    const signed = await consoleSignIn()
    const nonce = await signed.page.console('GET', '/v2/sessions/renew-nonce')
    const thief = browserDevice()
    const sig = signTranscript(thief, renewMessage(username, signed.device.payload.id, String(nonce.body.nonce)))
    const res = await signed.page.console('POST', '/v2/sessions/renew', { device: signed.device.payload.id, nonce: nonce.body.nonce, sig }, bearer(signed.token))
    expect(res.status).toBe(401)
  })

  it('ends when the page signs out', async () => {
    const signed = await consoleSignIn()
    const out = await signed.page.console('DELETE', '/v2/sessions/current', undefined, bearer(signed.token))
    expect(out.status).toBeLessThan(300)
    expect((await signed.page.console('GET', '/v2/me', undefined, bearer(signed.token))).status).toBe(401)
    expect((await renew(signed.page, signed.device)).status).toBe(401)
  })
})

describe('what a console session may do', () => {
  let signed: Awaited<ReturnType<typeof consoleSignIn>>
  beforeAll(async () => {
    signed = await consoleSignIn()
  })

  it('reads the account’s machines as the registry knows them from outside: no workspace names', async () => {
    const res = await signed.page.console('GET', '/v2/me/desktops', undefined, bearer(signed.token))
    expect(res.status).toBe(200)
    const rows = JSON.parse(res.text) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: desktop.device.payload.id, name: 'Studio Mac', online: false })
    expect(rows[0].workspaces).toBeUndefined()
    expect(rows[0].reach).toBeUndefined()
    expect(res.text).not.toContain('Secret Plans')
    // A machine of the account still reads the names: the rule is the page's.
    const own = await new Client(site).api('GET', '/v2/me/desktops', undefined, bearer(desktop.token))
    expect(own.text).toContain('Secret Plans')
  })

  it('reaches the relay path as that account', async () => {
    const mine = await signed.page.console('GET', `/api/m/${desktop.device.payload.id}/api/fleet`, undefined, { 'x-cookrew-session': signed.token })
    expect(mine.status).toBe(503)
    expect(mine.body.error).toBe('no_link')
  })

  it('is refused every act of the account that is not the console’s to do', async () => {
    const id = desktop.device.payload.id
    const refused: [string, string, unknown?][] = [
      ['POST', '/v2/me/password', { next: 'another long password here' }],
      ['DELETE', '/v2/me'],
      ['PATCH', '/v2/me', { displayName: 'Someone Else' }],
      ['POST', '/v2/me/join-codes', {}],
      ['GET', '/v2/me/seats'],
      ['GET', '/v2/me/requests'],
      ['GET', '/v2/me/events'],
      ['POST', '/v2/me/passkeys/options', {}],
      ['POST', '/v2/me/totp', {}],
      ['POST', '/v2/me/recovery-codes', {}],
      ['PUT', `/v2/me/desktops/${id}`, { name: 'Renamed', workspaces: [] }],
      ['POST', '/v2/me/device-grant/machine', {}],
      ['POST', '/v2/me/device-grant/watch', {}],
      ['GET', `/v2/canvas/link/${signed.device.payload.id}`],
      ['POST', '/v2/oauth/github/start', {}],
      ['GET', '/v1/identity/whoami'],
      ['POST', '/v1/presets', {}]
    ]
    for (const [method, path, body] of refused) {
      const res = await signed.page.console(method, path, body, bearer(signed.token))
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.body.error, `${method} ${path}`).toBe('console_scope')
      expect(String(res.body.message), `${method} ${path}`).toMatch(/[.!]$/)
    }
  })

  it('cannot pass itself off as another client to do a signed-in act: no passkey, link or step-up is opened with it', async () => {
    // The takeover a leaked console token would otherwise allow: open a passkey
    // request as a "desktop" for the console's own device id, with a key of the
    // thief's, then make a passkey on the auth page and spend the code.
    const thief = desktopDevice('Thief')
    const asDesktop = { id: signed.device.payload.id, kind: 'desktop', name: 'x', jwk: thief.payload.jwk }
    for (const extra of [{ intent: 'passkey' }, { intent: 'link', provider: 'github' }] as Record<string, unknown>[]) {
      const { challenge, state } = pkce()
      const res = await new Client(site).api(
        'POST',
        '/v2/auth/requests',
        { client: 'desktop', device: asDesktop, challenge, state, back: { scheme: false, port: 5555 }, ...extra },
        bearer(signed.token)
      )
      expect([401, 403], JSON.stringify(extra)).toContain(res.status)
      expect(res.body.request, JSON.stringify(extra)).toBeUndefined()
    }
    // And with its own key and device, still not: the console opens a way in or the device pass, nothing else.
    const { challenge, state } = pkce()
    const own = await signed.page.console('POST', '/v2/auth/requests', { client: 'console', intent: 'passkey', device: signed.device.payload, challenge, state }, bearer(signed.token))
    expect(own.status).toBe(400)
  })

  it('is no session at all to a route that did not ask for one of its kind', async () => {
    // Refused by the allow-list first; and were that ever to miss a route, the
    // route's own reading of who is asking does not know a console session.
    const { signedIn } = await import('../registry/src/v2-http')
    const asked = { headers: { authorization: `Bearer ${signed.token}` } } as never
    expect(signedIn(asked, site.v2)).toBeNull()
    expect(signedIn(asked, site.v2, 'bearer')).toBeNull()
    expect(signedIn(asked, site.v2, 'bearer', { console: true })?.account.username).toBe(username)
    // A machine's session is one everywhere.
    expect(signedIn({ headers: { authorization: `Bearer ${desktop.token}` } } as never, site.v2)?.account.username).toBe(username)
  })

  it('may check a machine’s hello, which is how it comes to trust a direct path', async () => {
    // Reached and read as this account's: an empty hello is answered (it verifies nothing), not refused for who asks.
    const res = await signed.page.console('POST', '/v2/verify-hello', {}, bearer(signed.token))
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    expect((await new Client(site).console('POST', '/v2/verify-hello', {})).status).toBe(401)
  })

  it('does not narrow a machine’s own session', async () => {
    const res = await new Client(site).api('GET', '/v2/me/seats', undefined, bearer(desktop.token))
    expect(res.status).toBe(200)
  })

  it('never takes the account password from the console’s page: that is typed on the auth host', async () => {
    for (const password of [PASSWORD, 'not the password at all']) {
      const res = await signed.page.console('POST', '/v2/me/device-grant', { password }, bearer(signed.token))
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('password_elsewhere')
      // Not checked at all: a wrong one costs no try, and a right one opens nothing.
      expect(res.body.triesLeft).toBeUndefined()
      expect(res.body.grant).toBeUndefined()
    }
    // A machine's page-less caller is unchanged: the password is still a proof there.
    const own = await new Client(site).api('POST', '/v2/me/device-grant', { password: PASSWORD }, bearer(desktop.token))
    expect(own.status).toBe(201)
  })

  it('is told what it may prove with, and offered a passkey challenge when the account has one', async () => {
    const res = await signed.page.console('POST', '/v2/me/device-grant/options', {}, bearer(signed.token))
    expect(res.status).toBe(200)
    expect(res.body.methods).toEqual({ password: true, passkey: false })
    expect(res.body.passwordAt).toBe('auth')
  })
})
