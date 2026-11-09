import { expect } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRegistry } from '../../registry/src/server'
import { RegistryStore } from '../../registry/src/store'
import { TransparencyLog } from '../../registry/src/log'
import { IdentityService } from '../../registry/src/identity'
import { DoorStore } from '../../registry/src/doors'
import { StarStore } from '../../registry/src/stars'
import { createV2, type V2Identity } from '../../registry/src/v2-routes'
import { deviceIdOf, type DeviceJwk } from '../../registry/src/auth-device-transaction'
import { fakeOAuth, type FakeOAuth } from './fake-oauth'

/**
 * ONE REGISTRY, TWO HOSTS, A FAKE PROVIDER — for suites that drive
 * auth.cookrew.dev over HTTP. The product origin is `localhost:<port>` and
 * the auth origin `auth.localhost:<port>`; every call names its Host, because
 * routing by the exact host is part of what is under test.
 */

export const PASSWORD = 'correct horse battery staple'

export interface AuthSite {
  P: string
  A: string
  port: number
  fake: FakeOAuth
  v2: V2Identity
  /** Every line the registry logged, in order. */
  logged: string[]
  close: () => Promise<void>
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = netServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

export async function bootAuthSite(options: { auth?: boolean; secondStep?: 'required' | 'legacy'; freshWindowMs?: number } = {}): Promise<AuthSite> {
  const dir = mkdtempSync(path.join(tmpdir(), 'auth-site-'))
  const fake = await fakeOAuth()
  const port = await freePort()
  const P = `http://localhost:${port}`
  const A = `http://auth.localhost:${port}`
  const logged: string[] = []
  const v2 = createV2(dir, {
    log: (message) => logged.push(message),
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000, lookupsPerMinute: 1000, joinPerMinute: 1000 },
    oauth: fake.config(),
    origin: P,
    // The suites on this harness test the auth page's plumbing, not Gate 1;
    // a Gate 1 suite passes 'required'.
    secondStep: options.secondStep ?? 'legacy',
    ...(options.freshWindowMs === undefined ? {} : { freshWindowMs: options.freshWindowMs }),
    ...(options.auth === false ? {} : { authOrigin: A })
  })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    origin: P,
    v2
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { P, A, port, fake, v2, logged, close }
}

export interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  text: string
}

/** A browser or a client: one cookie jar, a Host per call. */
export class Client {
  readonly jar = new Map<string, string>()
  constructor(
    private readonly site: AuthSite,
    readonly name = 'client'
  ) {}

  call(origin: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const host = new URL(origin).host
    const cookie = [...this.jar.entries()].filter(([k]) => k.startsWith(`${host}|`)).map(([k, v]) => `${k.split('|')[1]}=${v}`)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.site.port,
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
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            for (const line of res.headers['set-cookie'] ?? []) {
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
    return this.call(this.site.A, method, url, body, {
      origin: this.site.A,
      ...(request === null ? {} : { 'x-cookrew-auth-request': request })
    })
  }

  /** A write on the product origin, as one of its own pages makes it. */
  product(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    return this.call(this.site.P, method, url, body, { origin: this.site.P, ...headers })
  }
}

export interface Device {
  payload: { id: string; kind: 'desktop' | 'browser'; name: string; jwk: DeviceJwk }
  key: KeyObject
  curve: 'ed25519' | 'p256'
}

export function desktopDevice(name = 'Studio Mac'): Device {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string }
  const clean: DeviceJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
  return { payload: { id: deviceIdOf(clean), kind: 'desktop', name, jwk: clean }, key: pair.privateKey, curve: 'ed25519' }
}

export function browserDevice(name = 'Chrome on macOS'): Device {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const clean: DeviceJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  return { payload: { id: deviceIdOf(clean), kind: 'browser', name, jwk: clean }, key: pair.privateKey, curve: 'p256' }
}

export const signTranscript = (device: Device, transcript: string): string =>
  (device.curve === 'ed25519'
    ? sign(null, Buffer.from(transcript, 'utf8'), device.key)
    : sign('sha256', Buffer.from(transcript, 'utf8'), { key: device.key, dsaEncoding: 'ieee-p1363' })
  ).toString('base64url')

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') }
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

/** The code in an app or web handoff. */
export function codeOf(handoff: unknown): { code: string | null; state: string | null; error: string | null } {
  const url = String((handoff as { url: string }).url)
  const fields = new URLSearchParams(url.includes('#') ? url.split('#')[1] : url.split('?')[1])
  return { code: fields.get('code'), state: fields.get('state'), error: fields.get('error') }
}

export interface Opened {
  request: string
  verifier: string
  state: string
  body: Record<string, unknown>
}

/** A desktop opens a request and proves its key. */
export async function openDesktop(
  site: AuthSite,
  app: Client,
  device: Device,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<Opened> {
  const { verifier, challenge, state } = pkce()
  const opened = await app.call(site.P, 'POST', '/v2/auth/requests', {
    client: 'desktop',
    device: device.payload,
    challenge,
    state,
    back: { scheme: true, port: 53111 },
    ...extra
  }, headers)
  expect(opened.status, opened.text).toBe(201)
  const proved = await app.call(site.P, 'POST', `/v2/auth/requests/${opened.body.request}/proof`, {
    signature: signTranscript(device, String(opened.body.transcript))
  })
  expect(proved.status).toBe(204)
  return { request: String(opened.body.request), verifier, state, body: opened.body }
}

/** A web page opens a request (its verifier is the server's own, in a cookie) and proves its key. */
export async function openWeb(site: AuthSite, browser: Client, device: Device, extra: Record<string, unknown> = {}): Promise<Opened> {
  const opened = await browser.product('POST', '/v2/auth/requests', { client: 'web', device: device.payload, return: '/me', ...extra })
  expect(opened.status, opened.text).toBe(201)
  const proved = await browser.product('POST', `/v2/auth/requests/${opened.body.request}/proof`, {
    signature: signTranscript(device, String(opened.body.transcript))
  })
  expect(proved.status).toBe(204)
  return { request: String(opened.body.request), verifier: '', state: '', body: opened.body }
}

/** The browser's half of a provider trip: consent, then the callback, which sends it back to the page. */
export async function walk(site: AuthSite, authorizeUrl: string): Promise<string> {
  const consent = await fetch(authorizeUrl, { redirect: 'manual' })
  const callback = new URL(consent.headers.get('location') ?? '')
  expect(callback.origin).toBe(site.P)
  const landed = await new Client(site, 'callback').call(site.P, 'GET', `${callback.pathname}${callback.search}`)
  expect(landed.status).toBe(303)
  return String(landed.headers.location)
}

/** A password account with one device, made the old way. Answers its token. */
export async function passwordAccount(site: AuthSite, username: string, device: Device = desktopDevice('First Mac')): Promise<{ token: string; device: Device }> {
  const made = await new Client(site).call(site.P, 'POST', '/v2/accounts', { username, password: PASSWORD, device: device.payload })
  expect(made.status, made.text).toBe(201)
  return { token: String((made.body.session as { token: string }).token), device }
}

/**
 * An account with NO password, made on the page with GitHub from a desktop,
 * the way the owner's was. Answers the desktop's token and device.
 */
export async function passwordlessAccount(site: AuthSite, username: string, device: Device = desktopDevice('Owner Mac')): Promise<{ token: string; device: Device }> {
  const app = new Client(site, 'app')
  const opened = await openDesktop(site, app, device, { intent: 'github' })
  const browser = new Client(site, 'signup-browser')
  await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
  const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
  await walk(site, String(started.body.authorizeUrl))
  const asked = await browser.page('POST', '/auth/api/continue', opened.request, {})
  expect(asked.body.status).toBe('new')
  const made = await browser.page('POST', '/v2/oauth/claim', opened.request, { ticket: asked.body.ticket, username })
  expect(made.body.status).toBe('authorized')
  const spent = await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier })
  expect(spent.status, spent.text).toBe(201)
  expect(spent.body.hasPassword).toBe(false)
  return { token: String(spent.body.token), device }
}

/** The same, from cookrew.dev in a browser: the browser lands holding the session cookie. */
export async function webPasswordless(site: AuthSite, username: string): Promise<{ browser: Client; device: Device }> {
  const browser = new Client(site, 'web')
  const device = browserDevice()
  const opened = await openWeb(site, browser, device, { intent: 'github' })
  await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
  const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
  await walk(site, String(started.body.authorizeUrl))
  const asked = await browser.page('POST', '/auth/api/continue', opened.request, {})
  const made = await browser.page('POST', '/v2/oauth/claim', opened.request, { ticket: asked.body.ticket, username })
  const url = new URL(String((made.body.handoff as { url: string }).url))
  const landed = await browser.call(site.P, 'GET', `${url.pathname}${url.search}`)
  expect(landed.status).toBe(303)
  const me = await browser.call(site.P, 'GET', '/v2/me')
  expect(me.body.username).toBe(username)
  return { browser, device }
}
