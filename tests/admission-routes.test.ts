import type http from 'node:http'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { companionAccount, initialsOf } from '../src/main/companion-account'
import type { RegistryKeys } from '../src/main/canvas-token'
import {
  admittedRedirect,
  handleIdentityRoutes,
  type MobileIdentityDeps
} from '../src/main/mobile-identity-routes'
import { createPairingKeyRing } from '../src/main/pairing-key'
import { createSpentTokenStore } from '../src/main/spent-tokens'
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

/**
 * A request over TLS by default, because that is what a phone actually makes:
 * the companion is served on https and the admission ceremony is now refused
 * on the plaintext listener. `plain()` is the other case, tested on purpose.
 */
const request = (over: Partial<http.IncomingMessage> = {}): http.IncomingMessage =>
  ({
    method: 'GET',
    headers: {},
    socket: { encrypted: true, remoteAddress: '192.168.1.9', localAddress: '192.168.1.24' },
    ...over
  }) as unknown as http.IncomingMessage

/** The same request arriving in the clear on 8639. */
const plain = (over: Partial<http.IncomingMessage> = {}): http.IncomingMessage =>
  ({
    method: 'GET',
    headers: { host: '192.168.1.24:8639' },
    socket: { remoteAddress: '192.168.1.9', localAddress: '192.168.1.24' },
    ...over
  }) as unknown as http.IncomingMessage

const registry = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    keys: { jwk: publicKey.export({ format: 'jwk' }), revoked: [] } as RegistryKeys,
    // The registry's two-segment shape: base64url(claims).base64url(sig),
    // signed over the body SEGMENT and not over the JSON behind it.
    mint: (claims: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
      const key = createPrivateKey({
        key: privateKey.export({ format: 'jwk' }) as never,
        format: 'jwk'
      })
      return `${body}.${sign(null, Buffer.from(body, 'utf8'), key).toString('base64url')}`
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
    // THIS PHONE'S token, not the global one — the whole point of minting per
    // device is that the credential in this URL belongs to one phone.
    expect(written.headers.location).toMatch(/^\/\?token=[A-Za-z0-9_%-]{32,}$/)
    expect(written.headers.location).not.toContain('the-pairing-token')
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
    expect(store.list()).toMatchObject([
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

describe('a link that named the Mac goes back to the page, not to a 401', () => {
  const account = fakeAccount()
  const reg = registry()
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>

  const deps = (): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    keys: async () => reg.keys,
    refreshKeys: async () => reg.keys,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    pairingToken: () => 'the-pairing-token',
    now: () => NOW
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
  })
  afterEach(() => temp.clean())

  it('redirects with ?refused=device rather than answering 401', async () => {
    const token = reg.mint({
      sub: account.username,
      scope: 'canvas',
      aud: account.deviceId,
      dev: account.deviceId,
      exp: NOW + 60_000,
      jti: 'j1'
    })
    const { written, response } = recorder()
    await handleIdentityRoutes(
      request(),
      response,
      new URL(
        `https://mac.local:8643/?open=${token}&key=${ring.current().key}&device=${account.deviceId}`
      ),
      deps()
    )
    expect(written.status).toBe(303)
    expect(written.headers.location).toBe(
      `https://cookrew.dev/me?refused=device&desktop=${encodeURIComponent(account.deviceId)}`
    )
    expect(written.body).toBe('')
  })
})

describe('GET /api/account — the owner face the phone is shown', () => {
  const account = fakeAccount()

  it('carries the public face, the desktop name and the registry origin', () => {
    const face = companionAccount(account, 'https://reg.test/', {
      displayName: 'Andrej Dot',
      avatar: null
    })
    expect(face).toEqual({
      username: 'drej',
      displayName: 'Andrej Dot',
      initials: 'AD',
      avatar: null,
      desktopName: 'MacBook Pro',
      deviceId: account.deviceId,
      registryOrigin: 'https://reg.test'
    })
  })

  it('CARRIES NO KEY, NO SESSION AND NO UNLOCK VERIFIER', () => {
    // The account file holds the device private key beside the name. This is
    // built member by member for exactly this reason, and the test spells out
    // what "member by member" was protecting.
    const serialised = JSON.stringify(companionAccount(account, 'https://cookrew.dev'))
    for (const secret of ['privateKeyJwk', 'publicKeyJwk', 'unlock', 'session', 'claimedAt', 'd']) {
      expect(serialised, secret).not.toContain(`"${secret}"`)
    }
    expect(serialised).not.toContain(String(account.session?.token))
  })

  it('draws initials from the username when there is no display name yet', () => {
    // The phone must show a letter immediately; the display name lives on the
    // registry profile and may never have been read.
    expect(companionAccount(account, 'https://cookrew.dev')?.initials).toBe('DR')
    expect(initialsOf('drej')).toBe('DR')
    expect(initialsOf('Andrej Dot')).toBe('AD')
    expect(initialsOf('mira-lee')).toBe('ML')
    expect(initialsOf('   ')).toBe('?')
  })

  it('passes a data-URL avatar through and refuses a remote one', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(companionAccount(account, 'x', { avatar: data })?.avatar).toBe(data)
    // An http(s) avatar would be a beacon fired on every companion load.
    expect(companionAccount(account, 'x', { avatar: 'https://evil.example/a.png' })?.avatar)
      .toBeNull()
    expect(companionAccount(account, 'x', { avatar: 'javascript:alert(1)' })?.avatar).toBeNull()
  })

  it('is nothing at all when this Mac has no account', () => {
    expect(companionAccount(null, 'https://cookrew.dev')).toBeNull()
  })
})

describe('the ceremony refuses to happen in the clear', () => {
  const account = fakeAccount()
  const reg = registry()
  const claims = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 60_000,
    jti: 'j-clear'
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
    httpsReady: () => true,
    secureLocation: (_request, url) => `https://192.168.1.24:8643${url.pathname}${url.search}`,
    now: () => NOW,
    ...over
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
  })
  afterEach(() => temp.clean())

  const admissionUrl = (): URL =>
    new URL(
      `https://mac.local:8643/?open=${reg.mint(claims)}&key=${ring.current().key}&device=${PHONE}`
    )

  it('sends a plaintext admission to the secure address, query intact', async () => {
    const { written, response } = recorder()
    const url = admissionUrl()
    const handled = await handleIdentityRoutes(plain(), response, url, deps())
    expect(handled).toBe(true)
    expect(written.status).toBe(307)
    expect(written.headers.location).toBe(`https://192.168.1.24:8643/${url.search}`)
    // The whole query travels, or the ceremony dead-ends at a bare page.
    expect(written.headers.location).toContain('open=')
    expect(written.headers.location).toContain('key=')
  })

  it('NEVER HANDS A SESSION OVER PLAINTEXT, even for a perfect admission', async () => {
    const { written, response } = recorder()
    await handleIdentityRoutes(plain(), response, admissionUrl(), deps())
    expect(written.status).not.toBe(303)
    expect(written.headers.location).not.toContain('token=')
    // And nothing was admitted: the phone has not proved anything yet.
    expect(createAdmittedDeviceStore({ base: temp.base }).list()).toEqual([])
  })

  it('answers 426 with the sentence when there is no secure address to offer', async () => {
    const { written, response } = recorder()
    await handleIdentityRoutes(
      plain(),
      response,
      admissionUrl(),
      deps({ httpsReady: () => false })
    )
    expect(written.status).toBe(426)
    expect(JSON.parse(written.body).error).toBe(
      'Pair over the secure address — open it again from cookrew.dev.'
    )
  })

  it('refuses when TLS is up but no address can be named', async () => {
    const { written, response } = recorder()
    await handleIdentityRoutes(
      plain(),
      response,
      admissionUrl(),
      deps({ secureLocation: () => null })
    )
    expect(written.status).toBe(426)
  })

  it('LETS THE LOOPBACK RELAY BRIDGE THROUGH — that hop never leaves the Mac', async () => {
    const { written, response } = recorder()
    const bridged = plain({
      headers: { 'x-cookrew-relay': '1', host: '127.0.0.1:8639' },
      socket: { remoteAddress: '127.0.0.1' }
    } as never)
    await handleIdentityRoutes(bridged, response, admissionUrl(), deps())
    expect(written.status).toBe(303)
    expect(written.headers.location).toContain('token=')
  })

  it('does not take the marker alone — a header is something a caller writes', async () => {
    const { written, response } = recorder()
    const forged = plain({
      headers: { 'x-cookrew-relay': '1', host: '192.168.1.24:8639' },
      socket: { remoteAddress: '192.168.1.99' }
    } as never)
    await handleIdentityRoutes(forged, response, admissionUrl(), deps())
    expect(written.status).toBe(307)
  })

  it('does not take loopback alone either', async () => {
    const { written, response } = recorder()
    const local = plain({ socket: { remoteAddress: '127.0.0.1' } } as never)
    await handleIdentityRoutes(local, response, admissionUrl(), deps())
    expect(written.status).toBe(307)
  })

  it('completes normally over TLS', async () => {
    const { written, response } = recorder()
    await handleIdentityRoutes(request(), response, admissionUrl(), deps())
    expect(written.status).toBe(303)
  })
})

describe('a recorded admission cannot be replayed', () => {
  const account = fakeAccount()
  const reg = registry()
  let temp: { base: string; clean: () => void }
  let ring: ReturnType<typeof createPairingKeyRing>
  let spent: ReturnType<typeof createSpentTokenStore>

  const claims = {
    sub: account.username,
    scope: 'canvas',
    aud: account.deviceId,
    dev: PHONE,
    exp: NOW + 600_000,
    jti: 'j-once'
  }

  const deps = (): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    keys: async () => reg.keys,
    refreshKeys: async () => reg.keys,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    acceptsPairingKey: (key) => ring.accepts(key),
    pairingToken: () => 'the-pairing-token',
    httpsReady: () => true,
    spend: (jti, exp) => spent.spend(jti, exp),
    now: () => NOW
  })

  beforeEach(() => {
    temp = tempBase()
    ring = createPairingKeyRing({ now: () => NOW })
    spent = createSpentTokenStore({ base: temp.base, now: () => NOW })
  })
  afterEach(() => temp.clean())

  it('admits once and refuses the same link the second time', async () => {
    const token = reg.mint(claims)
    const url = new URL(
      `https://mac.local:8643/?open=${token}&key=${ring.current().key}&device=${PHONE}`
    )
    const first = recorder()
    await handleIdentityRoutes(request(), first.response, url, deps())
    expect(first.written.status).toBe(303)

    // The exact bytes, captured off the wire, inside the token's ten minutes.
    const second = recorder()
    await handleIdentityRoutes(request(), second.response, url, deps())
    expect(second.written.status).toBe(401)
    expect(JSON.parse(second.written.body).error).toBe(
      'That link was already used — open it again from cookrew.dev.'
    )
  })

  it('SURVIVES A RESTART — the spent list is on disk, not in a process', async () => {
    const url = new URL(
      `https://mac.local:8643/?open=${reg.mint(claims)}&key=${ring.current().key}&device=${PHONE}`
    )
    await handleIdentityRoutes(request(), recorder().response, url, deps())
    // A brand-new store over the same directory is what a restart looks like.
    spent = createSpentTokenStore({ base: temp.base, now: () => NOW })
    const after = recorder()
    await handleIdentityRoutes(request(), after.response, url, deps())
    expect(after.written.status).toBe(401)
  })

  it('does not burn the token when the key was simply mistyped', async () => {
    // A wrong six characters is the ordinary case, not the attack. Spending
    // the token there would force the page to mint another before the person
    // could try again.
    const token = reg.mint(claims)
    const wrong = recorder()
    await handleIdentityRoutes(
      request(),
      wrong.response,
      new URL(`https://mac.local:8643/?open=${token}&key=ZZZZZZ&device=${PHONE}`),
      deps()
    )
    expect(wrong.written.status).toBe(303)
    expect(wrong.written.headers.location).toContain('refused=key')

    const retry = recorder()
    await handleIdentityRoutes(
      request(),
      retry.response,
      new URL(`https://mac.local:8643/?open=${token}&key=${ring.current().key}&device=${PHONE}`),
      deps()
    )
    expect(retry.written.status).toBe(303)
    expect(retry.written.headers.location).toContain('token=')
  })
})
