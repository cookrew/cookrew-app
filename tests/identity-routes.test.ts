import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { companionAccount, initialsOf } from '../src/main/companion-account'
import { handleIdentityRoutes, type MobileIdentityDeps } from '../src/main/mobile-identity-routes'
import { fakeAccount, tempBase } from './support/idv2'

const NOW = 1_800_000_000_000
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
 * A request over TLS by default, because that is what a phone actually makes.
 */
const request = (over: Partial<http.IncomingMessage> = {}): http.IncomingMessage =>
  ({
    method: 'GET',
    headers: {},
    socket: { encrypted: true, remoteAddress: '192.168.1.9', localAddress: '192.168.1.24' },
    ...over
  }) as unknown as http.IncomingMessage

describe('GET /api/hello over the wire', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }
  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
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


/**
 * THE CEREMONY IS GONE, AND ITS QUERY IS JUST A QUERY.
 *
 * `?open=&key=&device=` was a route: it verified a registry-signed canvas
 * token, matched a six-character key, burned a jti and answered 303 with a
 * session. Reach v2.1 authorises a phone by the pairing token and by nothing
 * else, so the same URL is now an ordinary page load — the identity handler
 * declines it and the server serves what it serves for `/`.
 */
describe('a ?open= link is not a ceremony any more', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }

  const deps = (): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base, now: () => NOW }),
    now: () => NOW
  })

  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is declined by the identity handler, which writes nothing at all', async () => {
    const { written, response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      new URL('https://mac.local:8643/?open=a-token&key=ABC234&device=phone-1&name=iPhone'),
      deps()
    )
    expect(handled).toBe(false)
    expect(written.status).toBe(0)
    expect(written.body).toBe('')
  })

  it('admits nobody by arriving — the file stays empty', async () => {
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => NOW })
    const { response } = recorder()
    await handleIdentityRoutes(
      request(),
      response,
      new URL('https://mac.local:8643/?open=a-token&key=ABC234&device=phone-1'),
      { ...deps(), admitted: store }
    )
    expect(store.list()).toEqual([])
  })

  it('leaves the ordinary ?token= page load alone as well', async () => {
    const { written, response } = recorder()
    const handled = await handleIdentityRoutes(
      request(),
      response,
      new URL('https://mac.local:8643/?token=the-pairing-token'),
      deps()
    )
    expect(handled).toBe(false)
    expect(written.status).toBe(0)
  })
})
