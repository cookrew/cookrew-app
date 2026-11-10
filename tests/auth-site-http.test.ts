import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { deviceIdOf, type DeviceJwk } from '../registry/src/auth-device-transaction'
import { readAuthOrigin } from '../registry/src/auth-origin'
import { fakeOAuth, type FakeOAuth } from './support/fake-oauth'
import { getAssertion, GET_FLAGS_VERIFIED, makeCredential, p256 as passkeyPair } from './support/webauthn'

/**
 * AUTH.COOKREW.DEV OVER HTTP — one registry, two hosts, a fake provider.
 *
 * Every request names its Host, because routing by the exact host is the
 * boundary under test: the product origin is `localhost:<port>`, the auth
 * origin `auth.localhost:<port>`, and both reach the same process.
 */

const PASSWORD = 'correct horse battery staple'

let dir: string
let server: Server
let port: number
let fake: FakeOAuth
let v2: V2Identity
let clock: number
let P: string
let A: string
let logged: string[]

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = netServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as AddressInfo
      probe.close(() => resolve(free))
    })
  })

async function boot(options: { auth?: boolean } = {}): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'auth-site-'))
  fake = await fakeOAuth()
  port = await freePort()
  P = `http://localhost:${port}`
  A = `http://auth.localhost:${port}`
  clock = Date.now()
  logged = []
  v2 = createV2(dir, { secondStep: 'legacy', 
    log: (message) => logged.push(message),
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000, lookupsPerMinute: 1000, joinPerMinute: 1000 },
    oauth: fake.config(),
    origin: P,
    now: () => clock,
    ...(options.auth === false ? {} : { authOrigin: A })
  })
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    origin: P,
    v2
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
}

async function halt(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
}

beforeEach(() => boot())
afterEach(() => halt())

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  text: string
}

/** A browser or a client: one cookie jar, a Host per call. */
class Client {
  readonly jar = new Map<string, string>()
  constructor(readonly name = 'client') {}

  call(origin: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const host = new URL(origin).host
    const cookie = [...this.jar.entries()].filter(([k]) => k.startsWith(`${host}|`)).map(([k, v]) => `${k.split('|')[1]}=${v}`)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path: url,
          headers: {
            host,
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }),
            ...(cookie.length === 0 ? {} : { cookie: cookie.join('; ') }),
            ...headers
          }
        },
        (res) => {
          if (process.env.AUTH_DEBUG) console.error('CALL', method, host, url, res.statusCode)
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const set = res.headers['set-cookie'] ?? []
            for (const line of set) {
              const [pair] = line.split(';')
              const [k, ...rest] = pair.split('=')
              const value = rest.join('=')
              if (/Max-Age=0/.test(line) || value === '') this.jar.delete(`${host}|${k}`)
              else this.jar.set(`${host}|${k}`, value)
            }
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: Record<string, unknown> = {}
            try {
              parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
            } catch {
              parsed = {}
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text })
          })
        }
      )
      req.on('error', reject)
      req.end(payload)
    })
  }

  /** A page call on the auth origin, as the page's own script makes it. */
  page(method: string, url: string, request: string | null, body?: unknown): Promise<Answer> {
    return this.call(A, method, url, body, {
      origin: A,
      ...(request === null ? {} : { 'x-cookrew-auth-request': request })
    })
  }
}

interface Device {
  payload: { id: string; kind: 'desktop' | 'browser'; name: string; jwk: DeviceJwk }
  key: KeyObject
  curve: 'ed25519' | 'p256'
}

function desktopDevice(name = 'Studio Mac'): Device {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { kty: 'OKP'; crv: 'Ed25519'; x: string }
  const clean: DeviceJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
  return { payload: { id: deviceIdOf(clean), kind: 'desktop', name, jwk: clean }, key: pair.privateKey, curve: 'ed25519' }
}

function browserDevice(name = 'Chrome on macOS'): Device {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const clean: DeviceJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  return { payload: { id: deviceIdOf(clean), kind: 'browser', name, jwk: clean }, key: pair.privateKey, curve: 'p256' }
}

const signTranscript = (device: Device, transcript: string): string =>
  (device.curve === 'ed25519'
    ? sign(null, Buffer.from(transcript, 'utf8'), device.key)
    : sign('sha256', Buffer.from(transcript, 'utf8'), { key: device.key, dsaEncoding: 'ieee-p1363' })
  ).toString('base64url')

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') }
}

interface Opened {
  request: string
  verifier: string
  state: string
  body: Record<string, unknown>
}

/** A desktop opens a request and proves its key. */
async function openDesktop(app: Client, device: Device, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Opened> {
  const { verifier, challenge, state } = pkce()
  const opened = await app.call(P, 'POST', '/v2/auth/requests', {
    client: 'desktop',
    device: device.payload,
    challenge,
    state,
    back: { scheme: true, port: 53111 },
    ...extra
  }, headers)
  expect(opened.status).toBe(201)
  const proved = await app.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, {
    signature: signTranscript(device, String(opened.body.transcript))
  })
  expect(proved.status).toBe(204)
  return { request: String(opened.body.request), verifier, state, body: opened.body }
}

/** A password account with one device, made the old way. Answers its token. */
async function passwordAccount(username: string, device: Device = desktopDevice('First Mac')): Promise<{ token: string; device: Device }> {
  const made = await new Client().call(P, 'POST', '/v2/accounts', { username, password: PASSWORD, device: device.payload })
  expect(made.status, made.text).toBe(201)
  return { token: String((made.body.session as { token: string }).token), device }
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

/** The code in an app handoff. */
function codeOf(handoff: unknown): { code: string | null; state: string | null; error: string | null } {
  const url = String((handoff as { url: string }).url)
  const fields = new URLSearchParams(url.includes('#') ? url.split('#')[1] : url.split('?')[1])
  return { code: fields.get('code'), state: fields.get('state'), error: fields.get('error') }
}

describe('the auth origin', () => {
  it('is off without AUTH_ORIGIN: /v2/auth answers the 404 an old registry would', async () => {
    await halt()
    await boot({ auth: false })
    const app = new Client()
    const opened = await app.call(P, 'POST', '/v2/auth/requests', { client: 'desktop' })
    expect(opened.status).toBe(404)
    expect(opened.body.error).toBe('not_found')
  })

  it('serves the page and nothing of the product on its host', async () => {
    const browser = new Client()
    const page = await browser.call(A, 'GET', '/')
    expect(page.status).toBe(200)
    expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
    expect((await browser.call(A, 'GET', '/device')).status).toBe(200)
    expect((await browser.call(A, 'GET', '/market')).status).toBe(404)
    expect((await browser.call(A, 'GET', '/v1/doors')).status).toBe(404)
    expect((await browser.call(A, 'GET', '/v2/me')).status).toBe(404)
    expect((await browser.call(A, 'GET', '/assets/site.js')).status).toBe(404)
    expect((await browser.call(A, 'GET', '/assets/auth.js')).status).toBe(200)
    // The product origin still answers its own routes: the directory the auth host refused, as data.
    expect((await browser.call(P, 'GET', '/v1/doors')).status).toBe(200)
  })

  it('refuses a page write without its own Origin', async () => {
    const browser = new Client()
    const bare = await browser.call(A, 'POST', '/auth/api/claim', { request: 'x' })
    expect(bare.status).toBe(403)
    const foreign = await browser.call(A, 'POST', '/auth/api/claim', { request: 'x' }, { origin: P })
    expect(foreign.status).toBe(403)
  })

  it('keeps the legacy provider routes unchanged', async () => {
    const listed = await new Client().call(P, 'GET', '/v2/oauth/providers')
    expect(listed.status).toBe(200)
    expect(listed.body.providers).toEqual([
      { id: 'github', label: 'GitHub', device: true },
      { id: 'google', label: 'Google', device: false }
    ])
  })
})

describe('opening a request', () => {
  it('is unusable until the device signs its transcript, and a bad signature ends it', async () => {
    const app = new Client()
    const device = desktopDevice()
    const { challenge, state } = pkce()
    const opened = await app.call(P, 'POST', '/v2/auth/requests', {
      client: 'desktop', device: device.payload, challenge, state, back: { scheme: true }
    })
    expect(opened.status).toBe(201)
    expect(String(opened.body.authorizeUrl)).toBe(`${A}/?request=${opened.body.request}`)
    const browser = new Client('browser')
    expect((await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })).status).toBe(410)
    const other = desktopDevice()
    const forged = await app.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, {
      signature: signTranscript(other, String(opened.body.transcript))
    })
    expect(forged.status).toBe(403)
    const late = await app.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, {
      signature: signTranscript(device, String(opened.body.transcript))
    })
    expect(late.status).toBe(410)
  })

  it('refuses a device whose id is not derived from its key, and a desktop with a browser device', async () => {
    const app = new Client()
    const device = desktopDevice()
    const { challenge, state } = pkce()
    const lying = await app.call(P, 'POST', '/v2/auth/requests', {
      client: 'desktop', device: { ...device.payload, id: '11111111-1111-8111-8111-111111111111' }, challenge, state, back: { scheme: true }
    })
    expect(lying.status).toBe(400)
    const wrongKind = await app.call(P, 'POST', '/v2/auth/requests', {
      client: 'desktop', device: browserDevice().payload, challenge, state, back: { scheme: true }
    })
    expect(wrongKind.status).toBe(400)
  })

  it('names the asking app to the browser that claims it first, and to no other', async () => {
    const app = new Client()
    const opened = await openDesktop(app, desktopDevice('Studio Mac'))
    const browser = new Client('browser')
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.status).toBe(200)
    expect(claimed.body).toMatchObject({ client: 'desktop', clientLabel: 'Cookrew desktop app', device: { name: 'Studio Mac', kind: 'desktop' }, intent: 'sign-in' })
    const binding = String((claimed.headers['set-cookie'] as string[])[0])
    expect(binding).toMatch(/^__Host-cr_auth=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/)
    const thief = new Client('thief')
    expect((await thief.page('POST', '/auth/api/claim', null, { request: opened.request })).status).toBe(409)
    expect((await thief.page('POST', '/v2/sessions', opened.request, { username: 'x', password: PASSWORD })).status).toBe(410)
  })
})

describe('desktop sign-in through the page', () => {
  it('a password on a known device comes back as a one-use code only the verifier spends', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, owner.device)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    // A device in the body is not believed: the request's device is the only one.
    const signedIn = await browser.page('POST', '/v2/sessions', opened.request, {
      username: 'drej', password: PASSWORD, device: desktopDevice('Evil').payload
    })
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.status).toBe('authorized')
    expect(signedIn.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(signedIn.body)).not.toContain('token')
    const back = codeOf(signedIn.body.handoff)
    expect(back.state).toBe(opened.state)
    expect((signedIn.body.handoff as { url: string }).url.startsWith('cookrew://oauth#code=')).toBe(true)
    expect((signedIn.body.handoff as { fallback: string }).fallback).toMatch(/^http:\/\/127\.0\.0\.1:53111\/oauth\/return\?code=/)

    const spent = await app.call(P, 'POST', '/v2/auth/token', { code: back.code, verifier: opened.verifier })
    expect(spent.status).toBe(201)
    expect(spent.body).toMatchObject({ username: 'drej', deviceId: owner.device.payload.id, hasPassword: true })
    const me = await app.call(P, 'GET', '/v2/me', undefined, bearer(String(spent.body.token)))
    expect(me.status).toBe(200)
    expect((await app.call(P, 'POST', '/v2/auth/token', { code: back.code, verifier: opened.verifier })).status).toBe(401)
  })

  it('logs each way in and its ending, naming no request, code or person', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, owner.device, { username: 'drej' })
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const signedIn = await browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })
    const { code } = codeOf(signedIn.body.handoff)
    expect(logged).toEqual([
      'auth request opened: client=desktop intent=sign-in resume',
      'auth request finished: client=desktop intent=sign-in status=201'
    ])
    for (const line of logged) {
      expect(line).not.toContain(opened.request)
      expect(line).not.toContain(String(code))
      expect(line).not.toContain('drej')
    }
  })

  it('burns a code presented with the wrong verifier', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, owner.device)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const signedIn = await browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })
    const { code } = codeOf(signedIn.body.handoff)
    expect((await app.call(P, 'POST', '/v2/auth/token', { code, verifier: pkce().verifier })).status).toBe(401)
    expect((await app.call(P, 'POST', '/v2/auth/token', { code, verifier: opened.verifier })).status).toBe(401)
  })

  it('a new device still climbs the ladder, and only on the auth origin', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const fresh = desktopDevice('Second Mac')
    const opened = await openDesktop(app, fresh)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const step = await browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })
    expect(step.status).toBe(401)
    expect(step.body.error).toBe('second_factor')
    expect(step.body.next).toEqual(['approve'])
    const pending = String(step.body.pending)
    // The same pending is gone from the product origin.
    expect((await app.call(P, 'GET', `/v2/sessions/${pending}`)).status).toBe(410)
    const asked = await browser.page('POST', `/v2/sessions/${pending}/approve`, opened.request, {})
    expect(asked.status).toBe(202)
    const listed = await app.call(P, 'GET', '/v2/me/approvals', undefined, bearer(owner.token))
    const approval = (listed.body as unknown as { id: string; sentence: string }[])[0]
    expect(approval.sentence).toContain('Second Mac')
    const decided = await app.call(P, 'POST', `/v2/me/approvals/${approval.id}`, { decision: 'approve', match: step.body.match }, bearer(owner.token))
    expect(decided.status).toBe(204)
    const polled = await browser.page('GET', `/v2/sessions/${pending}`, opened.request)
    expect(polled.body.status).toBe('authorized')
    const spent = await app.call(P, 'POST', '/v2/auth/token', { code: codeOf(polled.body.handoff).code, verifier: opened.verifier })
    expect(spent.status).toBe(201)
    expect(spent.body.deviceId).toBe(fresh.payload.id)
  })

  it('a ladder opened on the product origin cannot be climbed from the page', async () => {
    await passwordAccount('drej')
    const app = new Client()
    const step = await app.call(P, 'POST', '/v2/sessions', { username: 'drej', password: PASSWORD, device: desktopDevice('Other').payload })
    expect(step.body.error).toBe('second_factor')
    const opened = await openDesktop(app, desktopDevice('Third'))
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect((await browser.page('GET', `/v2/sessions/${step.body.pending}`, opened.request)).status).toBe(410)
  })

  it('a passkey made on the product origin opens the account on the auth origin', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const options = await app.call(P, 'POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
    expect(options.status).toBe(200)
    const pair = passkeyPair()
    const credentialId = randomBytes(16)
    const credential = makeCredential({ pair, credentialId, challenge: String(options.body.challenge), origin: P, rpId: 'localhost' })
    const added = await app.call(P, 'POST', '/v2/me/passkeys', { name: 'Touch ID', credential }, bearer(owner.token))
    expect(added.status).toBe(201)

    const opened = await openDesktop(app, owner.device)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const asked = await browser.page('GET', '/v2/sessions/passkey/options', opened.request)
    expect(asked.body.rpId).toBe('localhost')
    const assertion = getAssertion({ pair, credentialId, challenge: String(asked.body.challenge), origin: A, rpId: 'localhost', signCount: 1, flags: GET_FLAGS_VERIFIED })
    const signedIn = await browser.page('POST', '/v2/sessions/passkey', opened.request, { credential: assertion })
    expect(signedIn.status).toBe(200)
    expect(signedIn.body.status).toBe('authorized')
  })

  it('cancelling hands the app its error and ends the request', async () => {
    const app = new Client()
    const opened = await openDesktop(app, desktopDevice())
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const cancelled = await browser.page('POST', '/auth/api/cancel', opened.request, {})
    expect(cancelled.status).toBe(200)
    expect(codeOf(cancelled.body.handoff)).toEqual({ code: null, state: opened.state, error: 'denied' })
    expect((await browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })).status).toBe(410)
  })

  it('a request goes cold after ten minutes', async () => {
    const app = new Client()
    const opened = await openDesktop(app, desktopDevice())
    clock += 10 * 60 * 1000 + 1
    const browser = new Client('browser')
    expect((await browser.page('POST', '/auth/api/claim', null, { request: opened.request })).status).toBe(410)
  })
})

describe('creating an account on the page', () => {
  it('shows the recovery codes once and hands the session to the app', async () => {
    const app = new Client()
    const device = desktopDevice('New Mac')
    const opened = await openDesktop(app, device, { intent: 'create' })
    const browser = new Client('browser')
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body.intent).toBe('create')
    expect((await browser.page('HEAD', '/v2/accounts/newbie', opened.request)).status).toBe(404)
    const made = await browser.page('POST', '/v2/accounts', opened.request, { username: 'newbie', password: PASSWORD })
    expect(made.status).toBe(200)
    expect(made.body.status).toBe('authorized')
    expect((made.body.codes as string[]).length).toBe(8)
    const spent = await app.call(P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier })
    expect(spent.body).toMatchObject({ username: 'newbie', deviceId: device.payload.id })
    expect(v2.accounts.recoveryCodesLeft('newbie')).toBe(8)
  })
})

describe('providers through the page', () => {
  /** The browser's half: the provider's consent and the callback, which sends it back to the page. */
  async function walk(authorizeUrl: string): Promise<string> {
    const consent = await fetch(authorizeUrl, { redirect: 'manual' })
    const callback = new URL(consent.headers.get('location') ?? '')
    expect(callback.origin).toBe(P)
    expect(callback.pathname).toBe('/v2/oauth/github/callback')
    const landed = await new Client().call(P, 'GET', `${callback.pathname}${callback.search}`)
    expect(landed.status).toBe(303)
    return String(landed.headers.location)
  }

  it('a new identity chooses a name on the page; the callback stays the registered one', async () => {
    const app = new Client()
    const device = desktopDevice()
    const opened = await openDesktop(app, device, { intent: 'github' })
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    expect(started.status).toBe(201)
    const authorize = new URL(String(started.body.authorizeUrl))
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${P}/v2/oauth/github/callback`)
    const back = await walk(String(started.body.authorizeUrl))
    expect(back).toBe(`${A}/?request=${encodeURIComponent(opened.request)}&continue=1`)
    // Another browser holding the link cannot continue it.
    expect((await new Client('thief').page('POST', '/auth/api/continue', opened.request, {})).status).toBe(410)
    const asked = await browser.page('POST', '/auth/api/continue', opened.request, {})
    expect(asked.body.status).toBe('new')
    const made = await browser.page('POST', '/v2/oauth/claim', opened.request, { ticket: asked.body.ticket, username: 'octo' })
    expect(made.body.status).toBe('authorized')
    expect((made.body.codes as string[]).length).toBe(8)
    const spent = await app.call(P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier })
    expect(spent.body).toMatchObject({ username: 'octo', hasPassword: false, deviceId: device.payload.id })
  })

  it('a verified email never merges: the same address on a password account still asks for a new name', async () => {
    await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, desktopDevice(), { intent: 'github' })
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    await walk(String(started.body.authorizeUrl))
    const asked = await browser.page('POST', '/auth/api/continue', opened.request, {})
    expect(asked.body.status).toBe('new')
  })

  it('a provider saying no sends the page to its denied screen and the request stays open', async () => {
    const app = new Client()
    const opened = await openDesktop(app, desktopDevice())
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    fake.denyNext()
    const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    const consent = await fetch(String(started.body.authorizeUrl), { redirect: 'manual' })
    const callback = new URL(consent.headers.get('location') ?? '')
    const landed = await new Client().call(P, 'GET', `${callback.pathname}${callback.search}`)
    expect(String(landed.headers.location)).toBe(`${A}/?request=${encodeURIComponent(opened.request)}&denied=1`)
    expect((await browser.page('GET', '/auth/api/request', opened.request)).body.stage).toBe('open')
  })

  it('links a provider for a signed-in desktop after a fresh proof, without signing in on the page', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const unproven = await app.call(P, 'POST', '/v2/auth/requests', {
      client: 'desktop', intent: 'link', provider: 'github', device: owner.device.payload, ...pkce(), back: { scheme: true }
    }, bearer(owner.token))
    // The same gate the app's own link passes: a password account types it.
    expect(unproven.status, unproven.text).toBe(403)
    expect(unproven.body.error).toBe('password_required')
    const opened = await openDesktop(app, owner.device, { intent: 'link', provider: 'github', current: PASSWORD }, bearer(owner.token))
    const browser = new Client('browser')
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body).toMatchObject({ intent: 'link', provider: 'github', username: 'drej' })
    expect((await browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })).status).toBe(404)
    const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    await walk(String(started.body.authorizeUrl))
    const linked = await browser.page('POST', '/auth/api/continue', opened.request, {})
    expect(linked.body.status).toBe('authorized')
    // Finishing the page links nothing: the opener writes it when it spends the code.
    const before = await app.call(P, 'GET', '/v2/me', undefined, bearer(owner.token))
    expect(before.body.links).toEqual([])
    const spent = await app.call(P, 'POST', '/v2/auth/token', { code: codeOf(linked.body.handoff).code, verifier: opened.verifier }, bearer(owner.token))
    expect(spent.status).toBe(200)
    expect(spent.body).toEqual({ status: 'linked', provider: 'github' })
    const me = await app.call(P, 'GET', '/v2/me', undefined, bearer(owner.token))
    expect((me.body.links as { provider: string }[]).map((l) => l.provider)).toEqual(['github'])
  })

  it('a link code spent without the opener’s session links nothing', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, owner.device, { intent: 'link', provider: 'github', current: PASSWORD }, bearer(owner.token))
    const thief = new Client('thief')
    await thief.page('POST', '/auth/api/claim', null, { request: opened.request })
    const started = await thief.page('POST', '/v2/oauth/github/start', opened.request, {})
    await walk(String(started.body.authorizeUrl))
    const finished = await thief.page('POST', '/auth/api/continue', opened.request, {})
    const stolen = await app.call(P, 'POST', '/v2/auth/token', { code: codeOf(finished.body.handoff).code, verifier: opened.verifier })
    expect(stolen.status).toBe(401)
    const me = await app.call(P, 'GET', '/v2/me', undefined, bearer(owner.token))
    expect(me.body.links).toEqual([])
  })
})

describe('the web', () => {
  it('signs cookrew.dev in through a code redeemed server-side, sharing no cookie', async () => {
    await passwordAccount('drej')
    const browser = new Client('browser')
    const device = browserDevice()
    const opened = await browser.call(P, 'POST', '/v2/auth/requests', { client: 'web', device: device.payload, return: '/market' }, { origin: P })
    expect(opened.status).toBe(201)
    const webCookie = String((opened.headers['set-cookie'] as string[])[0])
    expect(webCookie).toMatch(/^__Host-cr_auth_web=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/)
    expect((await browser.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) }, { origin: P })).status).toBe(204)
    await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    const signedIn = await browser.page('POST', '/v2/sessions', String(opened.body.request), { username: 'drej', password: PASSWORD })
    expect(signedIn.status).toBe(401)
    expect(signedIn.body.error).toBe('second_factor')
  })

  it('lands signed in on the return path, and the code is worthless without the browser that started', async () => {
    const browser = new Client('browser')
    const device = browserDevice()
    const opened = await browser.call(P, 'POST', '/v2/auth/requests', { client: 'web', intent: 'create', device: device.payload, return: '//evil.example/x' }, { origin: P })
    await browser.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) }, { origin: P })
    await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    const made = await browser.page('POST', '/v2/accounts', String(opened.body.request), { username: 'webby', password: PASSWORD })
    const handoff = made.body.handoff as { kind: string; url: string }
    expect(handoff.kind).toBe('web')
    const url = new URL(handoff.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${P}/auth/complete`)
    // Nothing on the auth origin is a session.
    expect([...browser.jar.keys()].filter((k) => k.startsWith('auth.localhost')).map((k) => k.split('|')[1])).toEqual(['__Host-cr_auth'])
    const stranger = new Client('stranger')
    const stolen = await stranger.call(P, 'GET', `${url.pathname}${url.search}`)
    expect(stolen.status).toBe(400)
    // The stranger's presentation burned it.
    const late = await browser.call(P, 'GET', `${url.pathname}${url.search}`)
    expect(late.status).toBe(400)
  })

  it('the browser that started it lands signed in', async () => {
    const browser = new Client('browser')
    const device = browserDevice()
    const opened = await browser.call(P, 'POST', '/v2/auth/requests', { client: 'web', intent: 'create', device: device.payload, return: '/market' }, { origin: P })
    await browser.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) }, { origin: P })
    await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    const made = await browser.page('POST', '/v2/accounts', String(opened.body.request), { username: 'webby', password: PASSWORD })
    const url = new URL((made.body.handoff as { url: string }).url)
    const landed = await browser.call(P, 'GET', `${url.pathname}${url.search}`)
    expect(landed.status).toBe(303)
    expect(landed.headers.location).toBe('/market')
    const me = await browser.call(P, 'GET', '/v2/me')
    expect(me.status).toBe(200)
    expect(me.body.username).toBe('webby')
    expect([...browser.jar.keys()]).not.toContain(`localhost:${port}|__Host-cr_auth_web`)
  })
})

describe('the review fixes', () => {
  it('a terminal request is claimed by its typed code only, then again by the same browser', async () => {
    const terminal = new Client('terminal')
    const device = desktopDevice('Box')
    const { challenge } = pkce()
    const opened = await terminal.call(P, 'POST', '/v2/auth/requests', { client: 'cli', device: device.payload, challenge })
    expect(opened.body.authorizeUrl).toBe(`${A}/device`)
    expect(opened.body.verificationUriComplete).toBeUndefined()
    await terminal.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) })
    const browser = new Client('browser')
    const byId = await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    expect(byId.status).toBe(403)
    expect(byId.body.error).toBe('use_code')
    expect((await browser.page('POST', '/auth/api/device', null, { code: opened.body.userCode })).status).toBe(200)
    expect((await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })).status).toBe(200)
  })

  it('a cancel that lands while a password is checked mints nothing', async () => {
    const owner = await passwordAccount('drej')
    const app = new Client()
    const opened = await openDesktop(app, owner.device)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const sessionsBefore = v2.accounts.get('drej')?.sessions.length ?? 0
    const signing = browser.page('POST', '/v2/sessions', opened.request, { username: 'drej', password: PASSWORD })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const cancelled = await browser.page('POST', '/auth/api/cancel', opened.request, {})
    expect(cancelled.status).toBe(200)
    const signed = await signing
    expect(signed.status).toBe(410)
    expect(signed.body.error).toBe('denied')
    expect(v2.accounts.get('drej')?.sessions.length ?? 0).toBe(sessionsBefore)
    // And a second cancel does not deny it again.
    expect((await browser.page('POST', '/auth/api/cancel', opened.request, {})).status).toBe(410)
  })

  it('an unproven request lasts a minute; one address holds ten at most', async () => {
    const app = new Client()
    const device = desktopDevice()
    const { challenge, state } = pkce()
    const open = () => app.call(P, 'POST', '/v2/auth/requests', { client: 'desktop', device: device.payload, challenge, state, back: { scheme: true } })
    const first = await open()
    clock += 61_000
    const late = await app.call(P, 'POST', `/v2/auth/requests/${first.body.request}/proof`, { signature: signTranscript(device, String(first.body.transcript)) })
    expect(late.status).toBe(410)
    for (let i = 0; i < 10; i += 1) expect((await open()).status).toBe(201)
    expect((await open()).status).toBe(429)
  })

  it('the web cannot open a link request, and a web cancel lands back where it began', async () => {
    const browser = new Client('browser')
    const device = browserDevice()
    const link = await browser.call(P, 'POST', '/v2/auth/requests', { client: 'web', intent: 'link', provider: 'github', device: device.payload }, { origin: P })
    expect(link.status).toBe(400)
    const opened = await browser.call(P, 'POST', '/v2/auth/requests', { client: 'web', device: device.payload, return: '/market' }, { origin: P })
    await browser.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) }, { origin: P })
    await browser.page('POST', '/auth/api/claim', null, { request: opened.body.request })
    const cancelled = await browser.page('POST', '/auth/api/cancel', String(opened.body.request), {})
    const url = new URL((cancelled.body.handoff as { url: string }).url)
    const landed = await browser.call(P, 'GET', `${url.pathname}${url.search}`)
    expect(landed.status).toBe(303)
    expect(landed.headers.location).toBe('/market')
  })
})

describe('cookrew login', () => {
  it('prints a short code, the browser types it, and the terminal collects the session', async () => {
    await passwordAccount('drej', desktopDevice('Box'))
    const terminal = new Client('terminal')
    const device = desktopDevice('Box 2')
    const { verifier, challenge } = pkce()
    const opened = await terminal.call(P, 'POST', '/v2/auth/requests', { client: 'cli', device: device.payload, challenge })
    expect(opened.status).toBe(201)
    expect(String(opened.body.userCode)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(opened.body.verificationUri).toBe(`${A}/device`)
    await terminal.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(device, String(opened.body.transcript)) })
    const request = String(opened.body.request)
    const waiting = await terminal.call(P, 'POST', '/v2/auth/token', { request, verifier })
    expect(waiting.status).toBe(202)
    const browser = new Client('browser')
    expect((await browser.page('POST', '/auth/api/device', null, { code: 'BBBB-BBBB' })).status).toBe(404)
    const typed = String(opened.body.userCode).toLowerCase().replace('-', ' ')
    const claimed = await browser.page('POST', '/auth/api/device', null, { code: typed })
    expect(claimed.status).toBe(200)
    expect(claimed.body).toMatchObject({ client: 'cli', clientLabel: 'cookrew login', userCode: opened.body.userCode })
    const step = await browser.page('POST', '/v2/sessions', request, { username: 'drej', password: PASSWORD })
    expect(step.body.error).toBe('second_factor')
    const asked = await browser.page('POST', `/v2/sessions/${step.body.pending}/approve`, request, {})
    expect(asked.status).toBe(202)
    v2.auth?.requests.allowPollNow(request)
    expect((await terminal.call(P, 'POST', '/v2/auth/token', { request, verifier: pkce().verifier })).status).toBe(401)
    v2.auth?.requests.allowPollNow(request)
    expect((await terminal.call(P, 'POST', '/v2/auth/token', { request, verifier })).status).toBe(202)
    // The poll is paced by the server: asking again at once is told to wait.
    const fast = await terminal.call(P, 'POST', '/v2/auth/token', { request, verifier })
    expect(fast.status).toBe(202)
    expect(fast.body.intervalMs).toBe(5000)
  })

  it('collects a finished sign-in and is told when the browser said no', async () => {
    const owner = await passwordAccount('drej', desktopDevice('Box'))
    const terminal = new Client('terminal')
    const { verifier, challenge } = pkce()
    const opened = await terminal.call(P, 'POST', '/v2/auth/requests', { client: 'cli', device: owner.device.payload, challenge })
    await terminal.call(P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, { signature: signTranscript(owner.device, String(opened.body.transcript)) })
    const request = String(opened.body.request)
    const browser = new Client('browser')
    await browser.page('POST', '/auth/api/device', null, { code: opened.body.userCode })
    const done = await browser.page('POST', '/v2/sessions', request, { username: 'drej', password: PASSWORD })
    expect(done.body).toMatchObject({ status: 'authorized', handoff: { kind: 'cli' } })
    const spent = await terminal.call(P, 'POST', '/v2/auth/token', { request, verifier })
    expect(spent.status).toBe(201)
    expect(spent.body.username).toBe('drej')

    const again = await terminal.call(P, 'POST', '/v2/auth/requests', { client: 'cli', device: owner.device.payload, challenge })
    await terminal.call(P, 'POST', `/v2/auth/requests/${again.body.request}/proof`, { signature: signTranscript(owner.device, String(again.body.transcript)) })
    await browser.page('POST', '/auth/api/device', null, { code: again.body.userCode })
    await browser.page('POST', '/auth/api/cancel', String(again.body.request), {})
    const over = await terminal.call(P, 'POST', '/v2/auth/token', { request: again.body.request, verifier })
    expect(over.status).toBe(410)
    expect(over.body.why).toBe('denied')
  })
})

describe('AUTH_ORIGIN', () => {
  it('must be a subdomain origin of the product, https or a loopback name', () => {
    expect(readAuthOrigin(undefined, 'https://cookrew.dev')).toEqual({ ok: true, origin: null })
    expect(readAuthOrigin('https://auth.cookrew.dev', 'https://cookrew.dev')).toEqual({ ok: true, origin: 'https://auth.cookrew.dev' })
    expect(readAuthOrigin('https://auth.cookrew.dev/', 'https://cookrew.dev')).toEqual({ ok: true, origin: 'https://auth.cookrew.dev' })
    expect(readAuthOrigin('http://auth.localhost:8797', 'http://localhost:8797').ok).toBe(true)
    expect(readAuthOrigin('http://auth.cookrew.dev', 'https://cookrew.dev').ok).toBe(false)
    expect(readAuthOrigin('https://auth.cookrew.dev/x', 'https://cookrew.dev').ok).toBe(false)
    expect(readAuthOrigin('https://cookrew.dev', 'https://cookrew.dev').ok).toBe(false)
    expect(readAuthOrigin('https://auth.evil.dev', 'https://cookrew.dev').ok).toBe(false)
    expect(readAuthOrigin('https://user:pw@auth.cookrew.dev', 'https://cookrew.dev').ok).toBe(false)
  })
})
