import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { readVapidEnv, vapidOf } from '../registry/src/v2-push-vapid'
import { PUSH_PER_ACCOUNT, V2PushSubscriptions } from '../registry/src/v2-push-store'
import { pushEndpointOk } from '../registry/src/v2-push-check'

/**
 * PHONE BACKGROUND PUSH, THE REGISTRY'S HALF (HITL phase 4).
 *
 * A console page subscribes its browser; a desktop of the same account reads
 * the keys (never the endpoint) and hands the registry a payload it already
 * encrypted; the registry signs a VAPID JWT and posts it to the push service.
 * Every account, machine and endpoint here is invented, and the push service
 * is a stub that records what it was sent.
 */

const PASSWORD = 'correct horse battery staple'

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function vapidPair(): { publicKey: string; privateKey: string } {
  // By way of a JWK, whose members are always full length: ECDH's private key can drop a leading zero byte.
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string }
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return { publicKey: b64u(point), privateKey: jwk.d }
}

function browserKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) }
}

const VAPID = vapidPair()
const SUBJECT = 'mailto:ops@cookrew.dev'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: Buffer
  redirect: string | undefined
}

const service = { status: 201, throws: false, sent: [] as Sent[] }

const stubFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
  service.sent.push({ url: String(url), method: init?.method ?? 'GET', headers, body: Buffer.from(init?.body as Uint8Array), redirect: init?.redirect })
  if (service.throws) throw new TypeError('fetch failed')
  return new Response(null, { status: service.status })
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = netServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

interface Site {
  v2: V2Identity
  dir: string
  call: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string }>
  console: string
  close: () => Promise<void>
}

/** A split registry (0.6.0): the API on its own host, and the console's origin it lets call. */
async function boot(push: boolean, extra: { sendsPerMinute?: number } = {}): Promise<Site> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-push-'))
  const port = await freePort()
  const api = `http://api.localhost:${port}`
  const consoleOrigin = `http://console.localhost:${port}`
  const v2 = createV2(dir, {
    secondStep: 'legacy',
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 },
    origin: `http://localhost:${port}`,
    apiOrigin: api,
    consoleOrigin,
    ...(push ? { push: { ...VAPID, subject: SUBJECT, fetch: stubFetch, ...extra } } : {})
  })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    stars: new StarStore(dir),
    origin: `http://localhost:${port}`,
    v2
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const call: Site['call'] = (method, url, body, headers = {}) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path: url,
          headers: {
            host: new URL(api).host,
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }),
            ...headers
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: Record<string, unknown> = {}
            try {
              parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
            } catch {
              parsed = {}
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, text })
          })
        }
      )
      req.on('error', reject)
      req.end(payload)
    })
  }
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(dir, { recursive: true, force: true })
  }
  return { v2, dir, call, console: consoleOrigin, close }
}

const jwkOf = (): Record<string, string> => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

interface Who {
  username: string
  id: string
  token: string
}

/** An account whose first device is a desktop that filed its record: the one that may read keys and send. */
async function desktopAccount(site: Site, username: string): Promise<Who> {
  const id = randomUUID()
  const claimed = await site.call('POST', '/v2/accounts', { username, password: PASSWORD, device: { id, kind: 'desktop', name: 'Invented Mac', jwk: jwkOf() } })
  expect(claimed.status, claimed.text).toBe(201)
  const token = String((claimed.body.session as { token: string }).token)
  const filed = await site.call('PUT', `/v2/me/desktops/${id}`, { name: 'Invented Mac', workspaces: [] }, bearer(token))
  expect(filed.status, filed.text).toBe(204)
  return { username, id, token }
}

/** Another device on the same account, signed in directly: a console page, a phone, a desktop with no record. */
function another(site: Site, username: string, kind: 'browser' | 'phone' | 'desktop', via?: 'console'): Who {
  const id = randomUUID()
  const attached = site.v2.accounts.attachDevice(username, { id, kind, name: `Invented ${kind}`, jwk: jwkOf() })
  expect(attached.ok).toBe(true)
  const session = site.v2.accounts.startSession(username, id, via === undefined ? {} : { via })
  expect(session).not.toBeNull()
  const minted = site.v2.tokens.mintSession(username, id, session!.jti, undefined, via)
  return { username, id, token: minted.token }
}

const ENDPOINTS = {
  apple: 'https://web.push.apple.com/QGuQyavXutnMH3P1dUHxLlOVAXt',
  google: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bHq',
  mozilla: 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
  microsoft: 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB'
}

const subscribe = (site: Site, who: Who, endpoint: string, keys = browserKeys(), label?: string) =>
  site.call('POST', '/v2/me/push/subscriptions', { endpoint, keys, ...(label === undefined ? {} : { label }) }, { ...bearer(who.token), origin: site.console })

const list = (site: Site, who: Who) => site.call('GET', '/v2/me/push/subscriptions', undefined, bearer(who.token))

const RECORD = b64u(randomBytes(200))
const send = (site: Site, who: Who, body: Record<string, unknown>) =>
  site.call('POST', '/v2/me/push/send', { body: RECORD, ttl: 60, urgency: 'high', ...body }, bearer(who.token))

// ── the pieces on their own ─────────────────────────────────────────────────

describe('which endpoints a subscription may name', () => {
  it('takes the four push services and refuses everything else', () => {
    for (const good of Object.values(ENDPOINTS)) expect(pushEndpointOk(good), good).toBe(true)
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://evil.example/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://user@fcm.googleapis.com/x',
      'https://user:pw@web.push.apple.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://fcm.googleapis.com./x',
      'https://1.2.3.4/x',
      'https://[::1]/x',
      'https://push.apple.com/x',
      'https://evilpush.apple.com/x',
      'https://notify.windows.com/x',
      'https://evilnotify.windows.com/x',
      'https://updates.push.services.mozilla.com.evil.example/x',
      `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
      'not a url',
      '',
      42,
      null
    ]) {
      expect(pushEndpointOk(bad), String(bad).slice(0, 60)).toBe(false)
    }
  })
})

describe('the VAPID keys from the environment', () => {
  it('is off, and says nothing, when neither key is set', () => {
    const said: string[] = []
    expect(readVapidEnv({}, (line) => said.push(line))).toBeUndefined()
    expect(said).toEqual([])
  })

  it('is on with both keys, with the subject or the product origin', () => {
    const env = { COOKREW_VAPID_PUBLIC_KEY: VAPID.publicKey, COOKREW_VAPID_PRIVATE_KEY: VAPID.privateKey }
    expect(readVapidEnv({ ...env, COOKREW_VAPID_SUBJECT: SUBJECT })).toEqual({ ...VAPID, subject: SUBJECT })
    expect(readVapidEnv(env)).toEqual({ ...VAPID, subject: 'https://cookrew.dev' })
  })

  it('turns off and names the variable, never its value, for half a pair, a bad key, a mismatched pair or a bad subject', () => {
    const other = vapidPair()
    const cases: Record<string, string>[] = [
      { COOKREW_VAPID_PUBLIC_KEY: VAPID.publicKey },
      { COOKREW_VAPID_PRIVATE_KEY: VAPID.privateKey },
      { COOKREW_VAPID_PUBLIC_KEY: 'short', COOKREW_VAPID_PRIVATE_KEY: VAPID.privateKey },
      { COOKREW_VAPID_PUBLIC_KEY: VAPID.publicKey, COOKREW_VAPID_PRIVATE_KEY: 'short' },
      { COOKREW_VAPID_PUBLIC_KEY: other.publicKey, COOKREW_VAPID_PRIVATE_KEY: VAPID.privateKey },
      { COOKREW_VAPID_PUBLIC_KEY: VAPID.publicKey, COOKREW_VAPID_PRIVATE_KEY: VAPID.privateKey, COOKREW_VAPID_SUBJECT: 'ops@cookrew.dev' }
    ]
    for (const env of cases) {
      const said: string[] = []
      expect(readVapidEnv(env, (line) => said.push(line)), JSON.stringify(Object.keys(env))).toBeUndefined()
      expect(said.length).toBe(1)
      expect(said[0]).toMatch(/COOKREW_VAPID_/)
      expect(said[0]).not.toContain(VAPID.privateKey)
    }
  })

  it('takes what scripts/vapid-keys.mjs prints', () => {
    const printed = execFileSync(process.execPath, ['scripts/vapid-keys.mjs'], { encoding: 'utf8' })
    const env = Object.fromEntries(printed.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    expect(Object.keys(env)).toEqual(['COOKREW_VAPID_PUBLIC_KEY', 'COOKREW_VAPID_PRIVATE_KEY', 'COOKREW_VAPID_SUBJECT'])
    expect(readVapidEnv(env)).toMatchObject({ publicKey: env.COOKREW_VAPID_PUBLIC_KEY, subject: 'mailto:ops@cookrew.dev' })
  })

  it('refuses a private key whose public half is not the one named', () => {
    expect(typeof vapidOf({ ...VAPID, subject: SUBJECT })).toBe('object')
    expect(typeof vapidOf({ publicKey: vapidPair().publicKey, privateKey: VAPID.privateKey, subject: SUBJECT })).toBe('string')
  })
})

describe('the subscription store', () => {
  it('keeps one file per account, written whole, and forgets it with the account', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-store-'))
    try {
      let now = 1_000
      const store = new V2PushSubscriptions(dir, () => now)
      const first = store.put('mira', { endpoint: ENDPOINTS.google, ...browserKeys(), label: 'Pixel' })
      now += 1
      store.put('otto', { endpoint: ENDPOINTS.apple, ...browserKeys(), label: '' })
      expect(store.list('mira').map((s) => s.id)).toEqual([first.id])
      expect(store.list('otto')).toHaveLength(1)
      // Read back by a fresh store: it is on disk.
      expect(new V2PushSubscriptions(dir).list('mira')[0]).toMatchObject({ id: first.id, endpoint: ENDPOINTS.google, label: 'Pixel', createdAt: 1_000 })
      store.forget('mira')
      expect(store.list('mira')).toEqual([])
      expect(store.list('otto')).toHaveLength(1)
      const files = readdirSync(path.join(dir, 'push-v2'))
      expect(files).toEqual(['otto.json'])
      expect(readFileSync(path.join(dir, 'push-v2', 'otto.json'), 'utf8')).not.toContain('mira')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a torn file as no subscriptions, and refuses a name that is not a username', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-store-'))
    try {
      const store = new V2PushSubscriptions(dir)
      store.put('mira', { endpoint: ENDPOINTS.google, ...browserKeys(), label: '' })
      writeFileSync(path.join(dir, 'push-v2', 'mira.json'), '{"torn":')
      expect(store.list('mira')).toEqual([])
      expect(() => store.list('../etc/passwd')).toThrow()
      expect(existsSync(path.join(dir, 'etc'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── over HTTP ───────────────────────────────────────────────────────────────

let site: Site

beforeAll(async () => {
  site = await boot(true)
})

afterAll(async () => {
  await site.close()
})

describe('a registry with no VAPID key', () => {
  it('answers every push route 404 push_off', async () => {
    const off = await boot(false)
    try {
      const mac = await desktopAccount(off, 'nopush')
      const page = another(off, 'nopush', 'browser', 'console')
      const key = await off.call('GET', '/v2/me/push/key', undefined, bearer(page.token))
      expect(key.status).toBe(404)
      expect(key.body).toMatchObject({ error: 'push_off' })
      expect(typeof key.body.message).toBe('string')
      expect((await subscribe(off, page, ENDPOINTS.google)).status).toBe(404)
      expect((await list(off, mac)).status).toBe(404)
      expect((await send(off, mac, { subscription: 'x'.repeat(22) })).status).toBe(404)
      expect((await off.call('DELETE', `/v2/me/push/subscriptions/${'x'.repeat(22)}`, undefined, { ...bearer(page.token), origin: off.console })).status).toBe(404)
    } finally {
      await off.close()
    }
  })
})

describe('GET /v2/me/push/key', () => {
  it('gives the public key to a desktop and to a console page, and to nobody signed out', async () => {
    const mac = await desktopAccount(site, 'keyreader')
    const page = another(site, 'keyreader', 'browser', 'console')
    for (const who of [mac, page]) {
      const res = await site.call('GET', '/v2/me/push/key', undefined, { ...bearer(who.token), origin: site.console })
      expect(res.status, res.text).toBe(200)
      expect(res.body).toEqual({ publicKey: VAPID.publicKey })
    }
    expect((await site.call('GET', '/v2/me/push/key')).status).toBe(401)
  })
})

describe('POST /v2/me/push/subscriptions', () => {
  it('takes a console page’s subscription and answers its id', async () => {
    await desktopAccount(site, 'subone')
    const page = another(site, 'subone', 'browser', 'console')
    const res = await subscribe(site, page, ENDPOINTS.apple, browserKeys(), 'iPhone · Safari')
    expect(res.status, res.text).toBe(201)
    expect(res.body).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) })
  })

  it('takes one from a phone signed in on the account as well', async () => {
    await desktopAccount(site, 'subphone')
    const phone = another(site, 'subphone', 'phone')
    expect((await subscribe(site, phone, ENDPOINTS.google)).status).toBe(201)
  })

  it('refuses an endpoint off the allow-list, keys of the wrong shape and a label that is not a label', async () => {
    await desktopAccount(site, 'subbad')
    const page = another(site, 'subbad', 'browser', 'console')
    const good = browserKeys()
    const point = Buffer.from(good.p256dh, 'base64url')
    const bodies: unknown[] = [
      { endpoint: 'https://evil.example/push', keys: good },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: good },
      { endpoint: 'https://fcm.googleapis.com:444/fcm/send/x', keys: good },
      { endpoint: ENDPOINTS.google },
      { endpoint: ENDPOINTS.google, keys: { auth: good.auth } },
      { endpoint: ENDPOINTS.google, keys: { ...good, p256dh: b64u(point.subarray(0, 64)) } },
      { endpoint: ENDPOINTS.google, keys: { ...good, p256dh: b64u(Buffer.concat([Buffer.from([5]), point.subarray(1)])) } },
      // Sixty-five bytes that start right and are no point on the curve.
      { endpoint: ENDPOINTS.google, keys: { ...good, p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)])) } },
      { endpoint: ENDPOINTS.google, keys: { ...good, p256dh: point.toString('base64') + '+/' } },
      { endpoint: ENDPOINTS.google, keys: { ...good, auth: b64u(randomBytes(15)) } },
      { endpoint: ENDPOINTS.google, keys: { ...good, auth: b64u(randomBytes(17)) } },
      { endpoint: ENDPOINTS.google, keys: good, label: 'x'.repeat(65) },
      { endpoint: ENDPOINTS.google, keys: good, label: 'two\nlines' },
      { endpoint: ENDPOINTS.google, keys: good, label: 7 },
      'just a string',
      []
    ]
    for (const body of bodies) {
      const res = await site.call('POST', '/v2/me/push/subscriptions', body, { ...bearer(page.token), origin: site.console })
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400)
      expect(res.body).toMatchObject({ error: 'bad_push' })
    }
    expect(site.v2.pushSubscriptions.list('subbad')).toEqual([])
  })

  it('refuses a write from another site, and anybody signed out', async () => {
    await desktopAccount(site, 'suborigin')
    const page = another(site, 'suborigin', 'browser', 'console')
    const res = await site.call('POST', '/v2/me/push/subscriptions', { endpoint: ENDPOINTS.google, keys: browserKeys() }, { ...bearer(page.token), origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'bad_origin' })
    expect((await site.call('POST', '/v2/me/push/subscriptions', { endpoint: ENDPOINTS.google, keys: browserKeys() })).status).toBe(401)
  })

  it('updates the same endpoint in place, keeping its id', async () => {
    await desktopAccount(site, 'subsame')
    const page = another(site, 'subsame', 'browser', 'console')
    const first = await subscribe(site, page, ENDPOINTS.mozilla, browserKeys(), 'Firefox')
    const fresh = browserKeys()
    const again = await subscribe(site, page, ENDPOINTS.mozilla, fresh, 'Firefox on Linux')
    expect(again.status).toBe(201)
    expect(again.body.id).toBe(first.body.id)
    const held = site.v2.pushSubscriptions.list('subsame')
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ id: first.body.id, p256dh: fresh.p256dh, auth: fresh.auth, label: 'Firefox on Linux' })
  })

  it('keeps ten an account, letting the oldest go', async () => {
    await desktopAccount(site, 'subcap')
    const page = another(site, 'subcap', 'browser', 'console')
    const ids: string[] = []
    for (let n = 0; n <= PUSH_PER_ACCOUNT; n += 1) {
      const res = await subscribe(site, page, `${ENDPOINTS.google}${n}`)
      expect(res.status).toBe(201)
      ids.push(String(res.body.id))
    }
    expect(PUSH_PER_ACCOUNT).toBe(10)
    const held = site.v2.pushSubscriptions.list('subcap').map((s) => s.id)
    expect(held).toHaveLength(10)
    expect(held).not.toContain(ids[0])
    expect(held).toContain(ids[10])
  })
})

describe('DELETE /v2/me/push/subscriptions/:id', () => {
  it('takes this account’s own subscription off, and only its own', async () => {
    await desktopAccount(site, 'delmine')
    await desktopAccount(site, 'deltheirs')
    const page = another(site, 'delmine', 'browser', 'console')
    const stranger = another(site, 'deltheirs', 'browser', 'console')
    const mine = String((await subscribe(site, page, ENDPOINTS.apple)).body.id)
    const theirs = await site.call('DELETE', `/v2/me/push/subscriptions/${mine}`, undefined, { ...bearer(stranger.token), origin: site.console })
    expect(theirs.status).toBe(404)
    expect(site.v2.pushSubscriptions.list('delmine')).toHaveLength(1)
    const gone = await site.call('DELETE', `/v2/me/push/subscriptions/${mine}`, undefined, { ...bearer(page.token), origin: site.console })
    expect(gone.status).toBe(204)
    expect(site.v2.pushSubscriptions.list('delmine')).toEqual([])
    expect((await site.call('DELETE', `/v2/me/push/subscriptions/${mine}`, undefined, { ...bearer(page.token), origin: site.console })).status).toBe(404)
  })
})

describe('GET /v2/me/push/subscriptions — a desktop’s, and never the endpoint', () => {
  it('lists id, keys and label to a desktop of the account', async () => {
    const mac = await desktopAccount(site, 'listmine')
    const page = another(site, 'listmine', 'browser', 'console')
    const keys = browserKeys()
    const id = String((await subscribe(site, page, ENDPOINTS.microsoft, keys, 'Edge')).body.id)
    const res = await list(site, mac)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual([{ id, p256dh: keys.p256dh, auth: keys.auth, label: 'Edge' }])
    expect(res.text).not.toContain('notify.windows.com')
    expect(res.text).not.toContain('endpoint')
  })

  it('refuses a console page, a phone, and a desktop device that never filed its record', async () => {
    await desktopAccount(site, 'listrefuse')
    const page = another(site, 'listrefuse', 'browser', 'console')
    const phone = another(site, 'listrefuse', 'phone')
    const bare = another(site, 'listrefuse', 'desktop')
    const scoped = await list(site, page)
    expect(scoped.status).toBe(403)
    expect(scoped.body).toMatchObject({ error: 'console_scope' })
    for (const who of [phone, bare]) {
      const res = await list(site, who)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ error: 'desktop_only' })
    }
    expect((await site.call('GET', '/v2/me/push/subscriptions')).status).toBe(401)
  })

  it('shows a desktop only its own account’s', async () => {
    await desktopAccount(site, 'listone')
    const other = await desktopAccount(site, 'listtwo')
    const page = another(site, 'listone', 'browser', 'console')
    await subscribe(site, page, ENDPOINTS.apple)
    expect((await list(site, other)).body).toEqual([])
  })
})

describe('POST /v2/me/push/send', () => {
  const authOf = (sent: Sent): { jwt: string; k: string } => {
    const found = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(sent.headers.authorization)
    expect(found, sent.headers.authorization).not.toBeNull()
    return { jwt: found![1], k: found![2] }
  }

  it('posts the record to the push service with the headers RFC 8030/8292 name and a VAPID JWT that verifies', async () => {
    const mac = await desktopAccount(site, 'sendok')
    const page = another(site, 'sendok', 'browser', 'console')
    const id = String((await subscribe(site, page, ENDPOINTS.apple)).body.id)
    service.status = 201
    service.sent = []
    const before = Math.floor(Date.now() / 1000)
    const res = await send(site, mac, { subscription: id, ttl: 3600, urgency: 'high', topic: 'agent-waiting' })
    expect(res.status, res.text).toBe(202)
    expect(res.body).toEqual({ sent: true })
    expect(service.sent).toHaveLength(1)
    const [out] = service.sent
    expect(out.url).toBe(ENDPOINTS.apple)
    expect(out.method).toBe('POST')
    expect(out.redirect).toBe('manual')
    expect(out.body.equals(Buffer.from(RECORD, 'base64url'))).toBe(true)
    expect(out.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '3600',
      urgency: 'high',
      topic: 'agent-waiting'
    })
    const { jwt, k } = authOf(out)
    expect(k).toBe(VAPID.publicKey)
    const [head, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' })
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string }
    expect(body.aud).toBe('https://web.push.apple.com')
    expect(body.sub).toBe(SUBJECT)
    expect(body.exp).toBeGreaterThan(before)
    expect(body.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 12 * 60 * 60)
    const point = Buffer.from(VAPID.publicKey, 'base64url')
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' })
    const signed = Buffer.from(signature, 'base64url')
    expect(signed.byteLength).toBe(64)
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, signed)).toBe(true)
  })

  it('sends no Topic when none is named', async () => {
    const mac = await desktopAccount(site, 'sendnotopic')
    const page = another(site, 'sendnotopic', 'browser', 'console')
    const id = String((await subscribe(site, page, ENDPOINTS.google)).body.id)
    service.status = 201
    service.sent = []
    expect((await send(site, mac, { subscription: id, urgency: 'normal', ttl: 0 })).status).toBe(202)
    expect(service.sent[0].headers).not.toHaveProperty('topic')
    expect(service.sent[0].headers).toMatchObject({ ttl: '0', urgency: 'normal' })
    expect(authOf(service.sent[0]).jwt.split('.').length).toBe(3)
  })

  it('forgets a subscription the push service says is gone, and says gone', async () => {
    const mac = await desktopAccount(site, 'sendgone')
    const page = another(site, 'sendgone', 'browser', 'console')
    for (const status of [404, 410]) {
      const id = String((await subscribe(site, page, `${ENDPOINTS.mozilla}${status}`)).body.id)
      service.status = status
      const res = await send(site, mac, { subscription: id })
      expect(res.status).toBe(410)
      expect(res.body).toMatchObject({ gone: true })
      expect(site.v2.pushSubscriptions.list('sendgone').map((s) => s.id)).not.toContain(id)
    }
  })

  it('answers 502 for any other failure, and keeps the subscription', async () => {
    const mac = await desktopAccount(site, 'sendfail')
    const page = another(site, 'sendfail', 'browser', 'console')
    const id = String((await subscribe(site, page, ENDPOINTS.google)).body.id)
    for (const status of [400, 413, 429, 500, 503, 301]) {
      service.status = status
      expect((await send(site, mac, { subscription: id })).status, String(status)).toBe(502)
    }
    service.status = 201
    service.throws = true
    try {
      expect((await send(site, mac, { subscription: id })).status).toBe(502)
    } finally {
      service.throws = false
    }
    expect(site.v2.pushSubscriptions.list('sendfail')).toHaveLength(1)
  })

  it('refuses a body, ttl, urgency or topic out of shape, and an id that is not this account’s', async () => {
    const mac = await desktopAccount(site, 'sendbad')
    const other = await desktopAccount(site, 'sendbadother')
    const page = another(site, 'sendbad', 'browser', 'console')
    const id = String((await subscribe(site, page, ENDPOINTS.apple)).body.id)
    service.sent = []
    const bad: Record<string, unknown>[] = [
      { subscription: id, body: b64u(randomBytes(4097)) },
      { subscription: id, body: '' },
      { subscription: id, body: 'not base64url!' },
      { subscription: id, body: 42 },
      { subscription: id, ttl: -1 },
      { subscription: id, ttl: 86_401 },
      { subscription: id, ttl: 1.5 },
      { subscription: id, ttl: '60' },
      { subscription: id, urgency: 'urgent' },
      { subscription: id, topic: 'has space' },
      { subscription: id, topic: 'x'.repeat(33) },
      { subscription: id, topic: '' },
      { subscription: 42 },
      {}
    ]
    for (const body of bad) {
      const res = await send(site, mac, body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(res.body).toMatchObject({ error: 'bad_push' })
    }
    expect((await send(site, mac, { subscription: id, body: b64u(randomBytes(4096)) })).status).toBe(202)
    // Another account's desktop cannot name it.
    expect((await send(site, other, { subscription: id })).status).toBe(404)
    expect((await send(site, mac, { subscription: 'A'.repeat(22) })).status).toBe(404)
    expect(service.sent).toHaveLength(1)
  })

  it('is a desktop’s alone: a console page, a phone and a desktop with no record are refused', async () => {
    await desktopAccount(site, 'sendwho')
    const page = another(site, 'sendwho', 'browser', 'console')
    const phone = another(site, 'sendwho', 'phone')
    const bare = another(site, 'sendwho', 'desktop')
    const id = String((await subscribe(site, page, ENDPOINTS.apple)).body.id)
    service.sent = []
    expect((await send(site, page, { subscription: id })).status).toBe(403)
    expect((await send(site, phone, { subscription: id })).status).toBe(403)
    expect((await send(site, bare, { subscription: id })).status).toBe(403)
    expect((await site.call('POST', '/v2/me/push/send', { subscription: id, body: RECORD, ttl: 60, urgency: 'high' })).status).toBe(401)
    expect(service.sent).toEqual([])
  })

  it('is limited per account', async () => {
    const tight = await boot(true, { sendsPerMinute: 2 })
    try {
      const mac = await desktopAccount(tight, 'sendlimit')
      const page = another(tight, 'sendlimit', 'browser', 'console')
      const id = String((await subscribe(tight, page, ENDPOINTS.apple)).body.id)
      service.status = 201
      expect((await send(tight, mac, { subscription: id })).status).toBe(202)
      expect((await send(tight, mac, { subscription: id })).status).toBe(202)
      const third = await send(tight, mac, { subscription: id })
      expect(third.status).toBe(429)
      expect(third.body).toMatchObject({ error: 'rate_limited' })
    } finally {
      await tight.close()
    }
  })
})

describe('deleting the account', () => {
  it('takes its subscriptions with it', async () => {
    const mac = await desktopAccount(site, 'delacct')
    const page = another(site, 'delacct', 'browser', 'console')
    expect((await subscribe(site, page, ENDPOINTS.apple)).status).toBe(201)
    expect(existsSync(path.join(site.dir, 'push-v2', 'delacct.json'))).toBe(true)
    const res = await site.call('DELETE', '/v2/me', { confirm: 'delacct', current: PASSWORD }, bearer(mac.token))
    expect(res.status, res.text).toBe(204)
    expect(existsSync(path.join(site.dir, 'push-v2', 'delacct.json'))).toBe(false)
    expect(site.v2.pushSubscriptions.list('delacct')).toEqual([])
  })
})
