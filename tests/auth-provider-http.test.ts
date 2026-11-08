import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry, type RegistryDeps } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { createProviders } from '../registry/src/v2-oauth-providers'
import { createV2 } from '../registry/src/v2-routes'
import type { ProvenProvider } from '../registry/src/auth-device-http'
import { fakeOAuth, pkce, returnOf, type FakeOAuth } from './support/fake-oauth'

/**
 * DEVICE-BOUND PROVIDER SIGN-IN, OVER HTTP — the real registry, a fake GitHub
 * and Google on loopback, and nothing that leaves this machine.
 *
 * The auth origin opens and proves the device transaction and starts the trip;
 * the provider returns to the product's EXISTING callback path, which must pick
 * the binding or the legacy flow by the one-use state alone; the auth origin
 * finishes. Nothing here may set a session or attach a device: that is the
 * ladder's, and the ladder is a seam this layer only hands a frozen result to.
 */

const AUTH = 'http://127.0.0.1:9876'
const PRODUCT = 'http://127.0.0.1:9877'
const AUTH_HOST = new URL(AUTH).host
const PRODUCT_HOST = new URL(PRODUCT).host

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: Record<string, unknown> }

let fake: FakeOAuth | undefined
let dir: string | undefined
let server: Server | undefined

afterEach(async () => {
  if (server) {
    const closing = server
    await new Promise<void>((resolve) => { closing.closeAllConnections(); closing.close(() => resolve()) })
  }
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  fake = undefined; server = undefined; dir = undefined
})

interface Boot { ladder?: boolean; binding?: boolean; revoked?: () => boolean }

async function boot(options: Boot = {}): Promise<{ proven: ProvenProvider[] }> {
  const { ladder = true, binding = true, revoked = () => false } = options
  fake = await fakeOAuth()
  dir = mkdtempSync(path.join(tmpdir(), 'auth-provider-http-'))
  const proven: ProvenProvider[] = []
  const v2 = createV2(dir, {
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000 },
    oauth: fake.config()
  })
  const deps: RegistryDeps = {
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    v2,
    origin: PRODUCT,
    authOrigin: AUTH,
    authDeviceTransactions: { isDeviceRevoked: (id) => { void id; return revoked() } },
    ...(binding
      ? {
          authProviderBinding: {
            providers: createProviders(fake.config()),
            ...(ladder ? { ladder: (result: ProvenProvider) => { proven.push(result); return { status: 'ladder' } } } : {})
          }
        }
      : {})
  }
  const started = createRegistry(deps)
  await new Promise<void>((resolve, reject) => { started.once('error', reject); started.listen(0, '127.0.0.1', resolve) })
  server = started
  return { proven }
}

function send(method: string, pathname: string, options: { host: string; headers?: Record<string, string>; body?: unknown }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const outgoing = request({
      hostname: '127.0.0.1',
      port: (server!.address() as AddressInfo).port,
      path: pathname,
      method,
      headers: { host: options.host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try { parsed = text && response.headers['content-type']?.includes('json') ? JSON.parse(text) : {} } catch { parsed = {} }
        resolve({ status: response.statusCode!, headers: response.headers, text, body: parsed })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

/** A browser on the auth origin: its cookie, its CSRF token, and the Origin it always sends. */
interface Browser { cookie: string; csrf: string; transactionId: string; deviceId: string }
const authPost = (pathname: string, browser: Browser | null, body: unknown, extra: Record<string, string> = {}) =>
  send('POST', pathname, {
    host: AUTH_HOST,
    headers: { origin: AUTH, ...(browser ? { cookie: browser.cookie, 'x-csrf-token': browser.csrf } : {}), ...extra },
    body
  })

/** Open and prove a device transaction, as the auth site's script would. */
async function provenBrowser(): Promise<Browser> {
  const keys = generateKeyPairSync('ed25519')
  const opened = await authPost('/auth/device-transactions', null, { device: { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) } })
  expect(opened.status).toBe(201)
  const setCookie = opened.headers['set-cookie']
  const browser: Browser = {
    cookie: String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0],
    csrf: String(opened.body.csrfToken),
    transactionId: String(opened.body.transactionId),
    deviceId: String(opened.body.deviceId)
  }
  const signature = sign(null, Buffer.from(String(opened.body.transcript)), keys.privateKey).toString('base64url')
  expect((await authPost('/auth/device-transactions/proof', browser, { transactionId: browser.transactionId, signature })).status).toBe(204)
  return browser
}

/** Start the provider trip and answer the consent: the callback URL the provider sent the browser to. */
async function consent(browser: Browser, provider: 'github' | 'google'): Promise<URL> {
  const started = await authPost('/auth/provider/start', browser, { transactionId: browser.transactionId, provider })
  expect(started.status).toBe(201)
  const answered = await fetch(String(started.body.authorizeUrl), { redirect: 'manual' })
  return new URL(answered.headers.get('location')!)
}

const callback = (url: URL, host = PRODUCT_HOST) => send('GET', `${url.pathname}${url.search}`, { host })
const finish = (browser: Browser, body: unknown = { transactionId: browser.transactionId }, extra: Record<string, string> = {}) =>
  authPost('/auth/provider/finish', browser, body, extra)

describe('device-bound provider sign-in over HTTP', () => {
  it.each(['github', 'google'] as const)('%s: proven device, fixed callback origin, one-use state, no session', async (provider) => {
    const { proven } = await boot()
    const browser = await provenBrowser()
    const url = await consent(browser, provider)
    // The redirect the provider was given is the configured product origin, never a Host header.
    expect(url.origin).toBe(PRODUCT)
    expect(url.pathname).toBe(`/v2/oauth/${provider}/callback`)
    expect(fake!.authorized.at(-1)?.get('redirect_uri')).toBe(`${PRODUCT}/v2/oauth/${provider}/callback`)

    const landed = await callback(url)
    expect(landed.status).toBe(303)
    expect(landed.headers.location).toBe(`${AUTH}/sign-in`)
    expect(landed.headers['set-cookie']).toBeUndefined()
    expect(landed.headers['cache-control']).toBe('no-store')
    expect(landed.headers['referrer-policy']).toBe('no-referrer')
    // One use: the same state again is nobody's, and the legacy page says so.
    expect((await callback(url)).status).toBe(400)

    const done = await finish(browser)
    expect(done.status).toBe(200)
    expect(done.body).toEqual({ status: 'ladder' })
    expect(done.headers['set-cookie']).toBeUndefined()
    expect(done.headers['x-content-type-options']).toBe('nosniff')
    expect(proven).toHaveLength(1)
    expect(proven[0].device.device.deviceId).toBe(browser.deviceId)
    expect(proven[0].proof.provider).toBe(provider)
    expect(Object.isFrozen(proven[0])).toBe(true)
    expect((await finish(browser)).status).toBe(403)
    expect(proven).toHaveLength(1)
  })

  it('routes legacy OAuth callbacks exactly as before while a binding trip is in flight', async () => {
    await boot()
    const browser = await provenBrowser()
    const bound = await consent(browser, 'github')

    const { state, challenge, verifier } = pkce()
    const started = await send('POST', '/v2/oauth/github/start', { host: PRODUCT_HOST, body: { state, challenge, back: { scheme: true } } })
    expect(started.status).toBe(201)
    const legacy = new URL((await fetch(String(started.body.authorizeUrl), { redirect: 'manual' })).headers.get('location')!)
    const page = await callback(legacy)
    expect(page.status).toBe(200)
    const back = returnOf(page.text)
    expect(back.state).toBe(state)
    expect(back.handoff).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const redeemed = await send('POST', '/v2/oauth/redeem', { host: PRODUCT_HOST, body: { handoff: back.handoff, verifier, device: { id: '8a0c8d5e-6b0b-4c55-9a1e-2f9d1f6b1c01', kind: 'desktop', name: 'Mac', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' } } } })
    expect(redeemed.status).toBe(200)
    expect(redeemed.body.status).toBe('new')

    // The legacy trip did not touch the binding's state, and vice versa.
    expect((await callback(bound)).status).toBe(303)
    expect((await finish(browser)).status).toBe(200)
  })

  it('takes a binding callback only on the canonical product host, without spending it elsewhere', async () => {
    await boot()
    const browser = await provenBrowser()
    const url = await consent(browser, 'github')
    expect((await callback(url, AUTH_HOST)).status).toBe(404)
    expect((await callback(url, 'cookrew.evil.test')).status).toBe(400)
    expect((await callback(url, 'localhost:9877')).status).toBe(400)
    expect((await callback(url, `${PRODUCT_HOST}.`)).status).toBe(404)
    expect((await callback(url)).status).toBe(303)
  })

  it('answers concurrent replays of one state exactly once', async () => {
    await boot()
    const browser = await provenBrowser()
    const url = await consent(browser, 'google')
    const statuses = (await Promise.all([callback(url), callback(url), callback(url)])).map((r) => r.status).sort()
    expect(statuses).toEqual([303, 400, 400])
  })

  it('never takes a device from the browser after proof, and refuses foreign credentials without spending', async () => {
    const { proven } = await boot()
    const browser = await provenBrowser()
    const other = await provenBrowser()
    const smuggled = await authPost('/auth/provider/start', browser, { transactionId: browser.transactionId, provider: 'github', device: { publicKeyJwk: {} } })
    expect(smuggled.status).toBe(400)
    expect((await authPost('/auth/provider/start', browser, { transactionId: browser.transactionId, provider: 'gitlab' })).status).toBe(400)
    expect((await authPost('/auth/provider/start', browser, { transactionId: browser.transactionId, provider: 'github' }, { origin: 'https://evil.test' })).status).toBe(403)
    const url = await consent(browser, 'github')
    expect((await callback(url)).status).toBe(303)

    expect((await finish(browser, { transactionId: browser.transactionId, device: { deviceId: other.deviceId } })).status).toBe(400)
    expect((await finish({ ...browser, csrf: other.csrf })).status).toBe(403)
    expect((await finish({ ...browser, cookie: other.cookie })).status).toBe(403)
    expect((await finish(browser, { transactionId: browser.transactionId }, { origin: 'https://evil.test' })).status).toBe(403)
    expect(proven).toHaveLength(0)
    expect((await finish(browser)).status).toBe(200)
    expect(proven[0].device.device.deviceId).toBe(browser.deviceId)
  })

  it('fails closed on denied consent, provider mismatch and a device revoked before finish', async () => {
    let revoked = false
    const { proven } = await boot({ revoked: () => revoked })
    const denied = await provenBrowser()
    fake!.denyNext()
    const deniedUrl = await consent(denied, 'github')
    expect((await callback(deniedUrl)).status).toBe(400)
    expect((await finish(denied)).status).toBe(403)

    const swapped = await provenBrowser()
    const swappedUrl = await consent(swapped, 'github')
    const asGoogle = new URL(swappedUrl)
    asGoogle.pathname = '/v2/oauth/google/callback'
    expect((await callback(asGoogle)).status).toBe(400)
    expect((await callback(swappedUrl)).status).toBe(400)
    expect((await finish(swapped)).status).toBe(403)

    const late = await provenBrowser()
    expect((await callback(await consent(late, 'google'))).status).toBe(303)
    revoked = true
    expect((await finish(late)).status).toBe(403)
    expect(proven).toHaveLength(0)
  })

  it('refuses to finish, before spending anything, when no ladder is configured', async () => {
    await boot({ ladder: false })
    const browser = await provenBrowser()
    expect((await callback(await consent(browser, 'github'))).status).toBe(303)
    const refused = await finish(browser)
    expect(refused.status).toBe(503)
    expect(refused.headers['set-cookie']).toBeUndefined()
  })

  it('is dark by default: no provider routes, and the product callback is the legacy one', async () => {
    await boot({ binding: false })
    const browser = await provenBrowser()
    expect((await authPost('/auth/provider/start', browser, { transactionId: browser.transactionId, provider: 'github' })).status).toBe(404)
    expect((await authPost('/auth/provider/finish', browser, { transactionId: browser.transactionId })).status).toBe(404)
    const state = randomBytes(32).toString('base64url')
    const page = await send('GET', `/v2/oauth/github/callback?state=${state}&code=x`, { host: PRODUCT_HOST })
    expect(page.status).toBe(400)
    expect(page.text).toContain('That sign-in is over')
  })
})

describe('provider binding configuration', () => {
  const make = (overrides: Partial<RegistryDeps>) => () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'auth-provider-config-'))
    try {
      createRegistry({
        store: new RegistryStore(scratch),
        log: new TransparencyLog(scratch),
        origin: PRODUCT,
        authOrigin: AUTH,
        authDeviceTransactions: { isDeviceRevoked: () => false },
        authProviderBinding: { providers: new Map() },
        ...overrides
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  it('needs device transactions and a canonical product origin for its callback', () => {
    expect(make({ authDeviceTransactions: undefined })).toThrow('Provider binding requires device transactions')
    expect(make({ origin: undefined })).toThrow('Provider binding requires a canonical product origin')
    expect(make({ origin: 'https://cookrew.example', authOrigin: 'https://auth.cookrew.example' })).toThrow('Invalid provider callback origin')
  })
})
