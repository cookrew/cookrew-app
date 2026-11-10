import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { readHostOrigins } from '../registry/src/auth-origin'
import { relyingParty } from '../registry/src/v2-factor-http'
import type { V2Context } from '../registry/src/v2-http'
import { PASSWORD, Client, bearer, bootAuthSite, browserDevice, desktopDevice, type AuthSite } from './support/auth-site-harness'

/**
 * FOUR HOSTS (0.6.0), AND WHAT THE REGISTRY ANSWERS ON EACH.
 *
 * cookrew.dev and console.cookrew.dev are static sites hosted elsewhere; this
 * process answers two names and nothing else:
 *
 *   api.cookrew.dev    /v1, /v2 and the relay path. No page, no cookie read
 *                      and none set; the session is a header. One origin may
 *                      call it from a page: the console's, exactly.
 *   auth.cookrew.dev   the sign-in page and its own calls: the one host with
 *                      a cookie.
 *
 * A registry given no API origin is the single-host arrangement the older
 * suites and a dev binary run; nothing here changes it.
 */

let site: AuthSite
let app: Client
let token = ''
const username = 'hostowner'

beforeAll(async () => {
  site = await bootAuthSite({ split: true })
  app = new Client(site, 'app')
  const claimed = await app.api('POST', '/v2/accounts', { username, password: PASSWORD, device: desktopDevice().payload })
  expect(claimed.status).toBe(201)
  token = String((claimed.body.session as { token: string }).token)
})

afterAll(async () => {
  await site.close()
})

describe('a name this registry does not serve', () => {
  it('answers nothing on the product host: that is a static site now, hosted elsewhere', async () => {
    for (const path of ['/', '/me', '/market', '/v2/keys', '/v1/doors', `/api/m/${desktopDevice().payload.id}/api/fleet`]) {
      const res = await app.call(site.P, 'GET', path, undefined, bearer(token))
      expect(res.status, path).toBe(404)
      expect(res.headers['set-cookie'], path).toBeUndefined()
    }
  })

  it('answers nothing on a host nobody configured', async () => {
    const res = await app.call(`http://evil.localhost:${site.port}`, 'GET', '/v2/keys')
    expect(res.status).toBe(404)
  })
})

describe('the API host', () => {
  it('answers the API', async () => {
    expect((await app.api('GET', '/v2/keys')).status).toBe(200)
    expect((await app.api('GET', '/v1/health')).status).toBe(200)
    expect((await app.api('GET', '/v2/me', undefined, bearer(token))).status).toBe(200)
  })

  it('serves no page at all', async () => {
    for (const path of ['/', '/me', '/me/account', '/market', '/features', '/start', '/download', `/${username}`, '/auth/complete?code=x&state=y', '/install/abc', '/favicon.svg', '/assets/site.js']) {
      const res = await app.api('GET', path, undefined, { accept: 'text/html', ...bearer(token) })
      expect(res.status, path).toBe(404)
      expect(String(res.headers['content-type']), path).toContain('application/json')
    }
  })

  it('reads no cookie: a session in one opens nothing', async () => {
    const res = await app.api('GET', '/v2/me', undefined, { cookie: `__Host-cr_session=${token}` })
    expect(res.status).toBe(401)
  })

  it('sets no cookie, whatever a route would have set elsewhere', async () => {
    const claimed = await new Client(site).api('POST', '/v2/accounts', { username: 'cookieless', password: PASSWORD, device: desktopDevice().payload })
    expect(claimed.status).toBe(201)
    expect(claimed.headers['set-cookie']).toBeUndefined()
    const signed = await new Client(site).api('POST', '/v2/sessions', { username: 'cookieless', password: PASSWORD, device: desktopDevice().payload })
    expect(signed.headers['set-cookie']).toBeUndefined()
  })
})

describe('the one question any name may ask', () => {
  it('answers a liveness probe by the pod’s own address, and nothing else that way', async () => {
    // A cluster's probe names no host of ours. It learns the process is up, and that is all.
    const probe = await app.call(`http://127.0.0.1:${site.port}`, 'GET', '/v1/health', undefined, { cookie: `__Host-cr_session=${token}` })
    expect(probe.status).toBe(200)
    expect(probe.headers['set-cookie']).toBeUndefined()
    for (const [method, path] of [['GET', '/v1/health/x'], ['GET', '/v2/keys'], ['POST', '/v1/health'], ['GET', '/v1/doors'], ['GET', '/']] as const) {
      expect((await app.call(`http://127.0.0.1:${site.port}`, method, path, undefined, bearer(token))).status, `${method} ${path}`).toBe(404)
    }
  })
})

describe('which page may call the API host', () => {
  it('answers the console’s preflight, and names exactly that origin', async () => {
    const res = await app.call(site.API, 'OPTIONS', '/v2/me', undefined, {
      origin: site.C,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization'
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(site.C)
    expect(res.headers['access-control-allow-headers']).toBe('authorization, content-type')
    expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, DELETE')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    expect(String(res.headers.vary)).toContain('origin')
  })

  it('lets the console read an answer, and no other origin', async () => {
    const mine = await app.console('GET', '/v2/me', undefined, bearer(token))
    expect(mine.status).toBe(200)
    expect(mine.headers['access-control-allow-origin']).toBe(site.C)
    expect(mine.headers['access-control-allow-credentials']).toBeUndefined()
    for (const origin of [site.P, site.A, 'https://evil.example', 'null']) {
      const other = await app.api('GET', '/v2/keys', undefined, { origin })
      expect(other.headers['access-control-allow-origin'], origin).toBeUndefined()
    }
  })

  it('says every answer varies by origin, granted or not, so a cache never hands one reader another’s', async () => {
    for (const headers of [{}, { origin: site.C }, { origin: 'https://evil.example' }] as Record<string, string>[]) {
      const res = await app.api('GET', '/v2/keys', undefined, headers)
      expect(String(res.headers.vary).toLowerCase(), JSON.stringify(headers)).toMatch(/(^|,\s*)origin(\s*,|$)/)
    }
    const health = await app.api('GET', '/v1/health')
    expect(String(health.headers.vary).toLowerCase()).toContain('origin')
  })

  it('answers no preflight for any other origin', async () => {
    for (const origin of [site.P, site.A, 'https://evil.example']) {
      const res = await app.call(site.API, 'OPTIONS', '/v2/me', undefined, { origin, 'access-control-request-method': 'GET' })
      expect(res.status, origin).toBe(403)
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined()
    }
  })

  it('takes a write from the console’s page and from an app, and from no other page', async () => {
    const body = { username: 'nobody-here', password: PASSWORD, device: browserDevice().payload }
    // Refused for what it says (no such account), which is past the origin gate.
    for (const res of [await app.console('POST', '/v2/sessions', body), await app.api('POST', '/v2/sessions', body)]) {
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('bad_credentials')
    }
    for (const origin of [site.P, site.A, site.API, 'https://evil.example', 'null']) {
      const res = await app.api('POST', '/v2/sessions', body, { origin })
      expect(res.status, origin).toBe(403)
      expect(res.body.error, origin).toBe('bad_origin')
    }
  })
})

describe('the auth host, beside it', () => {
  it('still serves the sign-in page, and only on its own name', async () => {
    const page = await app.call(site.A, 'GET', '/')
    expect(page.status).toBe(200)
    expect(String(page.headers['content-type'])).toContain('text/html')
    expect((await app.api('GET', '/', undefined, { accept: 'text/html' })).status).toBe(404)
  })

  it('reads no bearer: a session token a client holds opens nothing there', async () => {
    // The account page's session is this host's own cookie. A token presented
    // any other way is not looked at, so a token taken from an app or from
    // the console's page is worth nothing here.
    const read = await app.call(site.A, 'GET', '/v2/me', undefined, bearer(token))
    expect(read.status).toBe(401)
    const write = await app.call(site.A, 'PATCH', '/v2/me', { displayName: 'Taken' }, { ...bearer(token), origin: site.A })
    expect(write.status).toBe(401)
    for (const path of ['/v2/keys/x', '/v1/health', `/v2/canvas/link/${desktopDevice().payload.id}`, '/v2/me/desktops']) {
      expect((await app.call(site.A, 'GET', path, undefined, bearer(token))).status, path).toBe(404)
    }
  })

  it('is where a provider comes back to, and nowhere else is', async () => {
    // An unsolicited callback is answered (a page saying it is over), which is the route being there.
    const here = await app.call(site.A, 'GET', '/v2/oauth/github/callback?state=nothing&code=x')
    expect(here.status).toBe(400)
    expect(String(here.headers['content-type'])).toContain('text/html')
    const api = await app.api('GET', '/v2/oauth/github/callback?state=nothing&code=x')
    expect(api.status).toBe(404)
    expect(String(api.headers['content-type'])).toContain('application/json')
  })
})

describe('what a passkey must have been touched on', () => {
  const ctxOn = (via: V2Context['via'], auth = false): V2Context =>
    ({
      v2: site.v2,
      via,
      secure: false,
      request: { headers: { host: new URL(site.API).host } } as IncomingMessage,
      ...(auth ? { auth: { request: {} } } : {})
    }) as unknown as V2Context

  it('is the console’s origin for a ceremony the API host checks, never the product’s', () => {
    expect(relyingParty(ctxOn('api'))).toEqual({ origin: site.C, rpId: 'localhost' })
  })

  it('is the auth origin for a ceremony on the auth host', () => {
    expect(relyingParty(ctxOn('auth'))).toEqual({ origin: site.A, rpId: 'localhost' })
    expect(relyingParty(ctxOn('auth', true))).toEqual({ origin: site.A, rpId: 'localhost' })
  })

  it('names no page at all on an API host with no console: nothing touched anywhere is taken', () => {
    const lone = { ...ctxOn('api'), v2: { ...site.v2, consoleOrigin: null } } as V2Context
    const { origin } = relyingParty(lone)
    expect(origin).not.toBe(site.P)
    expect(origin).not.toBe(site.API)
    expect(origin).toMatch(/\.invalid$/)
  })
})

describe('a registry given no API origin', () => {
  let single: AuthSite
  beforeAll(async () => {
    single = await bootAuthSite()
  })
  afterAll(async () => {
    await single.close()
  })

  it('answers the API on its one host, as before', async () => {
    const res = await new Client(single).call(single.P, 'GET', '/v2/keys')
    expect(res.status).toBe(200)
  })
})

describe('the origins a registry is started with', () => {
  const PRODUCT = 'https://cookrew.dev'
  const ALL = { AUTH_ORIGIN: 'https://auth.cookrew.dev', API_ORIGIN: 'https://api.cookrew.dev', CONSOLE_ORIGIN: 'https://console.cookrew.dev' }

  it('takes the three together', () => {
    expect(readHostOrigins(ALL, PRODUCT, { dev: false })).toEqual({
      ok: true,
      auth: 'https://auth.cookrew.dev',
      api: 'https://api.cookrew.dev',
      console: 'https://console.cookrew.dev'
    })
  })

  it('refuses to start a real registry without all three: one host would read cookies on the API name', () => {
    for (const missing of ['AUTH_ORIGIN', 'API_ORIGIN', 'CONSOLE_ORIGIN'] as const) {
      const env = { ...ALL, [missing]: undefined }
      const read = readHostOrigins(env, PRODUCT, { dev: false })
      expect(read.ok, missing).toBe(false)
      if (!read.ok) expect(read.reason, missing).toContain(missing)
    }
    expect(readHostOrigins({}, PRODUCT, { dev: false }).ok).toBe(false)
  })

  it('lets a dev binary be one host, with or without the sign-in page', () => {
    expect(readHostOrigins({}, 'http://localhost:8797', { dev: true })).toEqual({ ok: true, auth: null, api: null, console: null })
    expect(readHostOrigins({ AUTH_ORIGIN: 'http://auth.localhost:8797' }, 'http://localhost:8797', { dev: true })).toEqual({
      ok: true,
      auth: 'http://auth.localhost:8797',
      api: null,
      console: null
    })
  })

  it('never takes half a split, dev or not', () => {
    const local = { AUTH_ORIGIN: 'http://auth.localhost:8797', API_ORIGIN: 'http://api.localhost:8797', CONSOLE_ORIGIN: 'http://console.localhost:8797' }
    expect(readHostOrigins(local, 'http://localhost:8797', { dev: true }).ok).toBe(true)
    expect(readHostOrigins({ ...local, CONSOLE_ORIGIN: undefined }, 'http://localhost:8797', { dev: true }).ok).toBe(false)
    expect(readHostOrigins({ ...local, API_ORIGIN: undefined }, 'http://localhost:8797', { dev: true }).ok).toBe(false)
    expect(readHostOrigins({ ...local, AUTH_ORIGIN: undefined }, 'http://localhost:8797', { dev: true }).ok).toBe(false)
  })

  it('wants three different names, each a subdomain of the product, each an origin alone', () => {
    const bad: Record<string, string>[] = [
      { ...ALL, API_ORIGIN: ALL.AUTH_ORIGIN },
      { ...ALL, CONSOLE_ORIGIN: ALL.API_ORIGIN },
      { ...ALL, API_ORIGIN: PRODUCT },
      { ...ALL, CONSOLE_ORIGIN: 'https://console.cookrew.dev.evil.example' },
      { ...ALL, API_ORIGIN: 'https://api.cookrew.dev/v2' },
      { ...ALL, API_ORIGIN: 'http://api.cookrew.dev' },
      { ...ALL, CONSOLE_ORIGIN: 'https://user:pw@console.cookrew.dev' },
      { ...ALL, CONSOLE_ORIGIN: 'not a url' }
    ]
    for (const env of bad) expect(readHostOrigins(env, PRODUCT, { dev: false }).ok, JSON.stringify(env)).toBe(false)
  })
})
