import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrivateKey, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { createRenewNonces, renewMessage, RENEW_NONCE_TTL_MS } from '../registry/src/v2-renew'
import { deviceIdFor, mintDeviceKey } from '../src/main/account-v2'

/**
 * A SESSION THAT RENEWS ITSELF ON THE DEVICE KEY.
 *
 * The bargain being proved: a Mac's doors stop going dark because nobody typed
 * a password for a month, WITHOUT renewal being weaker than the attachment it
 * extends. The device key is already what attached the device, so the tests
 * below are about the three things that make a signature safe to mint a month
 * on — it is this device's, it is fresh, and it is spent.
 */

const PASSWORD = 'correct horse battery staple'

interface Up {
  origin: string
  close: () => Promise<void>
}

async function up(loose = true): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-renew-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, {
      limits: {
        accountsPerMinute: 1000,
        sessionsPerMinute: 1000,
        lookupsPerMinute: 1000,
        ...(loose ? { renewPerMinute: 1000 } : {})
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
}

let site: Up
beforeAll(async () => {
  site = await up()
})
afterAll(async () => {
  await site.close()
})

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${site.origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

interface Mac {
  username: string
  deviceId: string
  token: string
  privateKeyJwk: Record<string, unknown>
}

let minted = 0
/** An account whose one device holds a real key, so its signatures are real. */
async function claim(): Promise<Mac> {
  const username = `renewer${++minted}`
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  const res = await call('POST', '/v2/accounts', {
    username,
    password: PASSWORD,
    device: { id: deviceId, kind: 'desktop', name: 'MacBook Pro', jwk: keys.publicKeyJwk }
  })
  expect(res.status).toBe(201)
  const out = await bodyOf<{ session: { token: string } }>(res)
  return { username, deviceId, token: out.session.token, privateKeyJwk: keys.privateKeyJwk }
}

const signWith = (privateKeyJwk: Record<string, unknown>, message: string): string =>
  sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: privateKeyJwk as never, format: 'jwk' })).toString(
    'base64url'
  )

const nonce = async (): Promise<string> =>
  (await bodyOf<{ nonce: string }>(await call('GET', '/v2/sessions/renew-nonce'))).nonce

const renew = async (mac: Mac, over: { nonce?: string; sig?: string; device?: string } = {}): Promise<Response> => {
  const n = over.nonce ?? (await nonce())
  return call('POST', '/v2/sessions/renew', {
    device: over.device ?? mac.deviceId,
    nonce: n,
    sig: over.sig ?? signWith(mac.privateKeyJwk, renewMessage(mac.username, over.device ?? mac.deviceId, n))
  })
}

/* ── the nonce store, on its own ───────────────────────────────────────────── */

describe('the renewal nonce', () => {
  it('is spendable exactly once', () => {
    const nonces = createRenewNonces()
    const { nonce: one } = nonces.issue()
    expect(nonces.spend(one)).toBe(true)
    expect(nonces.spend(one)).toBe(false)
  })

  it('is gone after two minutes', () => {
    let clock = 1_000
    const nonces = createRenewNonces(() => clock)
    const { nonce: one, expiresAt } = nonces.issue()
    expect(expiresAt).toBe(1_000 + RENEW_NONCE_TTL_MS)
    clock += RENEW_NONCE_TTL_MS
    expect(nonces.spend(one)).toBe(false)
  })

  it('refuses anything it did not issue', () => {
    const nonces = createRenewNonces()
    for (const bad of [undefined, null, 42, '', 'made-up']) expect(nonces.spend(bad)).toBe(false)
  })
})

/* ── the route ─────────────────────────────────────────────────────────────── */

describe('POST /v2/sessions/renew', () => {
  it('SUCCEEDS for an attached device, and the old session is closed', async () => {
    const mac = await claim()
    // The session it claimed with works right now.
    expect((await call('GET', '/v2/me', undefined, { authorization: `Bearer ${mac.token}` })).status).toBe(200)

    const res = await renew(mac)
    expect(res.status).toBe(201)
    const out = await bodyOf<{ token: string; deviceId: string; username: string; exp: number }>(res)
    expect(out.deviceId).toBe(mac.deviceId)
    expect(out.username).toBe(mac.username)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')

    // The new one is live…
    expect((await call('GET', '/v2/me', undefined, { authorization: `Bearer ${out.token}` })).status).toBe(200)
    // …and the old one is not. A renewal replaces; a month of renewals must
    // not be a month of bearer tokens that all still work.
    expect(out.token).not.toBe(mac.token)
    expect((await call('GET', '/v2/me', undefined, { authorization: `Bearer ${mac.token}` })).status).toBe(401)
  })

  it('FAILS 401 for a revoked device', async () => {
    const mac = await claim()
    // A second device, so the last-device rule does not refuse the revoke.
    // By join code, not by password: a password on an unknown machine is
    // exactly what the ladder refuses, which is the point of the ladder.
    const code = (
      await bodyOf<{ code: string }>(
        await call('POST', '/v2/me/join-codes', { current: PASSWORD }, { authorization: `Bearer ${mac.token}` })
      )
    ).code
    const other = mintDeviceKey()
    const otherId = deviceIdFor(other.publicKeyJwk)
    const joined = await call('POST', '/v2/join', {
      code,
      device: { id: otherId, kind: 'desktop', name: 'Mac mini', jwk: other.publicKeyJwk }
    })
    expect(joined.status).toBe(201)
    const second = await bodyOf<{ token: string }>(joined)

    expect(
      (
        await call('DELETE', `/v2/me/devices/${mac.deviceId}`, { current: PASSWORD }, {
          authorization: `Bearer ${second.token}`
        })
      ).status
    ).toBe(204)

    // The key still signs perfectly. Taking a device back has to mean its key
    // stops buying a fresh month, or taking it back means nothing.
    const res = await renew(mac)
    expect(res.status).toBe(401)
  })

  it('FAILS for a replayed nonce, even with a signature that is otherwise perfect', async () => {
    const mac = await claim()
    const one = await nonce()
    expect((await renew(mac, { nonce: one })).status).toBe(201)
    const replay = await renew(mac, { nonce: one })
    expect(replay.status).toBe(401)
  })

  it('spends the nonce even when what came with it was wrong', async () => {
    // Otherwise a caller holds a nonce open by sending deliberate rubbish
    // against it until something works.
    const mac = await claim()
    const one = await nonce()
    expect((await renew(mac, { nonce: one, sig: 'not-a-signature' })).status).toBe(401)
    expect((await renew(mac, { nonce: one })).status).toBe(401)
  })

  it('refuses another device’s signature, and an unknown device', async () => {
    const mac = await claim()
    const stranger = await claim()
    const one = await nonce()
    // A real signature, over the right message, by the wrong key.
    const wrong = signWith(stranger.privateKeyJwk, renewMessage(mac.username, mac.deviceId, one))
    expect((await renew(mac, { nonce: one, sig: wrong })).status).toBe(401)
    expect((await renew(mac, { device: 'no-such-device' })).status).toBe(401)
  })

  it('refuses a signature over a different message', async () => {
    const mac = await claim()
    const one = await nonce()
    // The prefix is what stops a signature minted for one purpose being spent
    // at another; prove the message is checked and not merely the key.
    const other = signWith(mac.privateKeyJwk, `cookrew-hello/2 ${mac.deviceId} x 1 ${one}`)
    expect((await renew(mac, { nonce: one, sig: other })).status).toBe(401)
  })

  it('is rate-limited per device', async () => {
    const solo = await up(false)
    try {
      const keys = mintDeviceKey()
      const deviceId = deviceIdFor(keys.publicKeyJwk)
      const username = 'limited'
      const claimed = await fetch(`${solo.origin}/v2/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password: PASSWORD,
          device: { id: deviceId, kind: 'desktop', name: 'MacBook Pro', jwk: keys.publicKeyJwk }
        })
      })
      expect(claimed.status).toBe(201)
      let last = 0
      for (let i = 0; i < 6; i += 1) {
        const got = await fetch(`${solo.origin}/v2/sessions/renew-nonce`)
        const { nonce: n } = (await got.json()) as { nonce: string }
        const res = await fetch(`${solo.origin}/v2/sessions/renew`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            device: deviceId,
            nonce: n,
            sig: signWith(keys.privateKeyJwk, renewMessage(username, deviceId, n))
          })
        })
        last = res.status
      }
      expect(last).toBe(429)
    } finally {
      await solo.close()
    }
  })
})
