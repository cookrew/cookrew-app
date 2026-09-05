import type http from 'node:http'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import type { RegistryKeys } from '../src/main/canvas-token'
import {
  admittedRedirect,
  handleIdentityRoutes,
  type MobileIdentityDeps
} from '../src/main/mobile-identity-routes'
import { createPairingKeyRing } from '../src/main/pairing-key'
import { fakeAccount, tempBase } from './support/idv2'

const NOW = 1_800_000_000_000
const PHONE = 'phone-1'
const REGISTRY = 'https://cookrew.dev'

/** A response object that records what a handler wrote, and nothing else. */
const recorder = () => {
  const written: { status: number; headers: Record<string, string>; body: string } = {
    status: 0,
    headers: {},
    body: ''
  }
  const response = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      written.status = status
      written.headers = { ...written.headers, ...(headers ?? {}) }
      return response
    },
    setHeader: (name: string, value: string) => void (written.headers[name] = value),
    end: (chunk?: string) => void (written.body += chunk ?? ''),
    getHeader: (name: string) => written.headers[name]
  }
  return { written, response: response as unknown as http.ServerResponse }
}

const request = (over: Partial<http.IncomingMessage> = {}): http.IncomingMessage =>
  ({ method: 'GET', headers: {}, ...over }) as http.IncomingMessage

const registry = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  return {
    keys: { jwk: publicKey.export({ format: 'jwk' }), revoked: [] } as RegistryKeys,
    mint: (claims: Record<string, unknown>) => {
      const head = b64({ alg: 'EdDSA', typ: 'JWT' })
      const body = b64(claims)
      const key = createPrivateKey({
        key: privateKey.export({ format: 'jwk' }) as never,
        format: 'jwk'
      })
      return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`
    }
  }
}

describe('GET /api/hello over the wire', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }
  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    keys: async () => null,
    refreshKeys: async () => null,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
    acceptsPairingKey: () => false,
    pairingToken: () => 'pairing-token',
    now: () => NOW,
    ...over
  })
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  const nonce = Buffer.alloc(32, 7).toString('base64url')

  it('answers a signed hello with the registry origin allowed', async () => {
    const { written, response } = recorder()
    const url = new URL(`https://mac.local:8643/api/hello?nonce=${nonce}`)
    const handled = await handleIdentityRoutes(
      request({ headers: { origin: REGISTRY } }),
      response,
      url,
      deps()
    )
    expect(handled).toBe(true)
    expect(written.status).toBe(200)
    expect(written.headers['access-control-allow-origin']).toBe(REGISTRY)
    expect(written.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(written.body)
    expect(body.deviceId).toBe(account.deviceId)
    expect(body.nonce).toBe(nonce)
    expect(typeof body.sig).toBe('string')
  })

  it('answers the preflight with 204 and the allowed verbs', async () => {
    const { written, response } = recorder()
    const handled = await handleIdentityRoutes(
      request({ method: 'OPTIONS', headers: { origin: REGISTRY } }),
      response,
      new URL('https://mac.local:8643/api/hello'),
      deps()
    )
    expect(handled).toBe(true)
    expect(written.status).toBe(204)
    expect(written.headers['access-control-allow-methods']).toBe('GET, OPTIONS')
  })

  it('answers a stranger origin with no allow-origin at all', async () => {
    const { written, response } = recorder()
    await handleIdentityRoutes(
      request({ headers: { origin: 'https://evil.example' } }),
      response,
      new URL(`https://mac.local:8643/api/hello?nonce=${nonce}`),
      deps()
    )
    expect(written.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('is 400 for a short nonce and 404 with no account', async () => {
    const short = recorder()
    await handleIdentityRoutes(
      request(),
      short.response,
      new URL('https://mac.local:8643/api/hello?nonce=AAAA'),
      deps()
    )
    expect(short.written.status).toBe(400)

    const none = recorder()
    await handleIdentityRoutes(
      request(),
      none.response,
      new URL(`https://mac.local:8643/api/hello?nonce=${nonce}`),
      deps({ account: () => null })
    )
    expect(none.written.status).toBe(404)
  })

  it('does not exist at all when identity is not wired', async () => {
    const { response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      new URL(`https://mac.local:8643/api/hello?nonce=${nonce}`),
      undefined
    )
    expect(handled).toBe(false)
  })
})

describe('GET /?open= admission over the wire', () => {
  const account = fakeAccount()
  const reg = registry()
  const claims = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 60_000,
    jti: 'j1'
  }
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>

  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    keys: async () => reg.keys,
    refreshKeys: async () => reg.keys,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    pairingToken: () => 'the-pairing-token',
    now: () => NOW,
    ...over
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
  })
  afterEach(() => temp.clean())

  const open = (query: string): URL => new URL(`https://mac.local:8643/${query}`)

  it('admits and redirects to the SAME credential a legacy pairing gives', async () => {
    const key = ring.current().key
    const { written, response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      open(`?open=${reg.mint(claims)}&key=${key}&device=${PHONE}&name=iPhone`),
      deps()
    )
    expect(handled).toBe(true)
    expect(written.status).toBe(303)
    expect(written.headers.location).toBe('/?token=the-pairing-token')
    expect(written.headers['cache-control']).toBe('no-store')
  })

  it('records the phone under the name it gave', async () => {
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => NOW })
    const { response } = recorder()
    await handleIdentityRoutes(
      request(),
      response,
      open(`?open=${reg.mint(claims)}&key=${ring.current().key}&device=${PHONE}&name=iPhone`),
      deps({ admitted: store })
    )
    expect(store.list()).toEqual([
      { deviceId: PHONE, name: 'iPhone', admittedAt: NOW, lastSeenAt: NOW }
    ])
  })

  it('sends a wrong key back to the page that sent it, with the reason', async () => {
    ring.current()
    const { written, response } = recorder()
    await handleIdentityRoutes(
      request(),
      response,
      open(`?open=${reg.mint(claims)}&key=ZZZZZZ&device=${PHONE}`),
      deps()
    )
    expect(written.status).toBe(303)
    expect(written.headers.location).toBe(
      `https://cookrew.dev/me?refused=key&desktop=${encodeURIComponent(account.deviceId)}`
    )
  })

  it('answers a bad token with 401 and the sentence, and no redirect', async () => {
    const other = registry()
    const { written, response } = recorder()
    await handleIdentityRoutes(
      request(),
      response,
      open(`?open=${other.mint(claims)}&key=${ring.current().key}&device=${PHONE}`),
      deps()
    )
    expect(written.status).toBe(401)
    expect(written.headers.location).toBeUndefined()
    expect(JSON.parse(written.body).error).toBe(
      'This sign-in is not for this Mac — open it again from cookrew.dev.'
    )
  })

  it('LEAVES THE LEGACY ?token= PATH ALONE', async () => {
    // A plain `/?token=…` load is not an admission and must fall through to
    // the renderer handler exactly as it did before any of this existed.
    const { response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      open('?token=legacy-token'),
      deps()
    )
    expect(handled).toBe(false)
  })

  it('leaves a bare page load alone', async () => {
    const { response } = recorder()
    expect(await handleIdentityRoutes(request(), response, open(''), deps())).toBe(false)
    expect(await handleIdentityRoutes(request(), response, open('index.html'), deps())).toBe(false)
  })

  it('ignores an admission on any path but the root', async () => {
    const { response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      new URL(`https://mac.local:8643/api/state?open=${reg.mint(claims)}&device=${PHONE}`),
      deps()
    )
    expect(handled).toBe(false)
  })

  it('redirects to a bare / when there is somehow no pairing token to hand over', () => {
    expect(admittedRedirect('/', null)).toBe('/')
    expect(admittedRedirect('/', 'a b')).toBe('/?token=a%20b')
  })
})
