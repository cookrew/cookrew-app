import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService, bindStatement, type IdentityConfig } from '../registry/src/identity'
import { jwkThumbprint } from '../registry/src/jwk'
import { platformAuthenticator } from './support/webauthn'

/**
 * THE ACCOUNT SURFACE, OVER HTTP.
 *
 * Everything here drives the real router, because "the store refuses that" and
 * "the registry refuses that" are different claims and only the second one is
 * about a deployment. The interesting cases are all the same shape: a request
 * that is well-formed, signed by a real key, and STILL must be refused because
 * the key does not speak for the account in the path.
 */

const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000,
  linkTtlMs: 2 * 60 * 1000
}

const b64 = (b: Buffer): string => b.toString('base64url')
const jwkOf = (keys: { publicKey: KeyObject }): Record<string, unknown> =>
  keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

interface Held {
  keys: { privateKey: KeyObject; publicKey: KeyObject }
  wire: { id: string; jwk: Record<string, unknown>; kind: string; name: string }
}

const device = (kind = 'desktop', name = 'MacBook'): Held => {
  const keys = generateKeyPairSync('ed25519')
  return { keys, wire: { id: randomUUID(), jwk: jwkOf(keys), kind, name } }
}

/** The software ceremony, as the site and the app perform it. */
function assertion(held: Held, handle: string, challenge: string): Record<string, unknown> {
  const authData = Buffer.concat([
    createHash('sha256').update(CONFIG.rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  const clientData = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }),
    'utf8'
  )
  return {
    credentialId: handle,
    clientDataJSON: b64(clientData),
    authenticatorData: b64(authData),
    signature: b64(
      sign(null, Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), held.keys.privateKey)
    )
  }
}

let base = ''
let now = 1_000_000
let identity: IdentityService
let server: { url: string; close: () => void }

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-accounts-http-'))
  now = 1_000_000
  identity = new IdentityService(base, CONFIG, () => now)
  const s = createRegistry({ store: new RegistryStore(base), log: new TransparencyLog(base), identity })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  server = { url: `http://127.0.0.1:${port}`, close: () => s.close() }
})
afterEach(() => {
  server.close()
  rmSync(base, { recursive: true, force: true })
})

const call = (
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<Response> =>
  fetch(`${server.url}${route}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    }
  })

const post = (route: string, body?: unknown, token?: string): Promise<Response> =>
  call('POST', route, body, token)

/** A token of the given scope, through the real ceremony. */
async function tokenFor(held: Held, handle: string, scope: string, aud?: string): Promise<string> {
  const challenge = (await (await post('/v1/identity/challenge')).json()) as { challenge: string }
  const out = (await (
    await post('/v1/identity/assert', {
      ...assertion(held, handle, challenge.challenge),
      scope,
      ...(aud === undefined ? {} : { aud })
    })
  ).json()) as { token?: string }
  if (!out.token) throw new Error('the ceremony was refused')
  return out.token
}

/** Mint an account over HTTP and return its first device. */
async function account(handle: string): Promise<Held> {
  const held = device()
  const res = await post('/v1/accounts', { handle, device: held.wire })
  expect(res.status).toBe(201)
  return held
}

/** The vouch a device signs about another device's key. */
function vouchFor(voucher: Held, handle: string, newDevice: Held['wire']): string {
  const thumbprint = jwkThumbprint(newDevice.jwk)
  return b64(
    sign(null, Buffer.from(bindStatement(handle, newDevice.id, String(thumbprint)), 'utf8'), voucher.keys.privateKey)
  )
}

/* ── minting ─────────────────────────────────────────────────────────────── */

describe('POST /v1/accounts', () => {
  it('mints a handle with its first device', async () => {
    const held = device()
    const res = await post('/v1/accounts', { handle: 'drej', device: held.wire })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ handle: 'drej', deviceId: held.wire.id })
    // Never cached and never shared: the answer depends on who asked.
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('is 409 for a handle somebody already holds', async () => {
    await account('drej')
    const res = await post('/v1/accounts', { handle: '@DREJ', device: device().wire })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'taken' })
  })

  it('is 400 for a handle or a device that is not one', async () => {
    expect((await post('/v1/accounts', { handle: 'Not A Handle', device: device().wire })).status).toBe(400)
    expect((await post('/v1/accounts', { handle: 'drej', device: { id: 'x' } })).status).toBe(400)
    expect((await post('/v1/accounts', {})).status).toBe(400)
  })

  it('refuses a method the route does not answer', async () => {
    const res = await call('DELETE', '/v1/accounts')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })
})

describe('HEAD|GET /v1/accounts/:handle', () => {
  it('answers taken or free, so a setup field can say so before you press', async () => {
    await account('drej')
    expect((await call('HEAD', '/v1/accounts/drej')).status).toBe(200)
    expect((await call('HEAD', '/v1/accounts/@drej')).status).toBe(200)
    expect((await call('HEAD', '/v1/accounts/mira')).status).toBe(404)
  })

  it('summarises an account without ever naming a key', async () => {
    const held = await account('drej')
    const res = await call('GET', '/v1/accounts/drej')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ handle: 'drej', devices: 1 })
    expect(JSON.stringify(body)).not.toContain(held.wire.jwk.x as string)
  })

  it('is 404 for a name that could never be a handle', async () => {
    expect((await call('GET', '/v1/accounts/Not%20A%20Handle')).status).toBe(404)
  })
})

/* ── devices ─────────────────────────────────────────────────────────────── */

describe('GET /v1/accounts/@h/devices', () => {
  it('lists them for an account token of that handle, without private material', async () => {
    const held = await account('drej')
    const token = await tokenFor(held, 'drej', 'account')
    const res = await call('GET', '/v1/accounts/@drej/devices', undefined, token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Record<string, unknown>[] }
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0]).toMatchObject({ id: held.wire.id, kind: 'desktop', boundBy: 'first' })
    expect(JSON.stringify(body)).not.toContain('"d"')
  })

  it('refuses no token, a download token, and ANOTHER ACCOUNT’S token', async () => {
    const drej = await account('drej')
    const mira = await account('mira')
    expect((await call('GET', '/v1/accounts/@drej/devices')).status).toBe(401)
    // A download token names this reader; it is not permission to read their
    // key list.
    const download = await tokenFor(drej, 'drej', 'download')
    expect((await call('GET', '/v1/accounts/@drej/devices', undefined, download)).status).toBe(401)
    // And @mira's account token says nothing about @drej, however it is aimed.
    const other = await tokenFor(mira, 'mira', 'account')
    expect((await call('GET', '/v1/accounts/@drej/devices', undefined, other)).status).toBe(401)
  })
})

describe('POST /v1/accounts/@h/devices', () => {
  it('binds a device its voucher signed for', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone', 'iPhone')
    const res = await post(
      '/v1/accounts/@drej/devices',
      { device: phone.wire, vouch: vouchFor(laptop, 'drej', phone.wire) },
      token
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ handle: 'drej', deviceId: phone.wire.id })
    expect(identity.accounts.device('drej', phone.wire.id)?.boundBy).toBe(laptop.wire.id)
    // And the new device can now sign for the account itself.
    expect(await tokenFor(phone, 'drej', 'account')).toBeTypeOf('string')
  })

  it('REFUSES a bind the token alone would have allowed', async () => {
    // The whole point of the vouch: an account token proves a device is
    // calling; only the signature proves that device named this key.
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone')
    const res = await post('/v1/accounts/@drej/devices', { device: phone.wire, vouch: 'nope' }, token)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad_vouch' })
    expect(identity.accounts.device('drej', phone.wire.id)).toBeNull()
  })

  it('refuses a vouch made over a DIFFERENT key than the one being bound', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone')
    const swapped = device('phone')
    // Signed for `swapped`'s key, presented with `phone`'s id.
    const vouch = vouchFor(laptop, 'drej', { ...swapped.wire, id: phone.wire.id })
    expect((await post('/v1/accounts/@drej/devices', { device: phone.wire, vouch }, token)).status).toBe(403)
  })

  it('refuses a vouch by a device that has been revoked', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone')
    await post(
      '/v1/accounts/@drej/devices',
      { device: phone.wire, vouch: vouchFor(laptop, 'drej', phone.wire) },
      token
    )
    const phoneToken = await tokenFor(phone, 'drej', 'account')
    identity.accounts.revoke('drej', phone.wire.id)
    const third = device('browser', 'Chrome')
    const res = await post(
      '/v1/accounts/@drej/devices',
      { device: third.wire, vouch: vouchFor(phone, 'drej', third.wire) },
      phoneToken
    )
    expect(res.status).toBe(401)
  })

  it('is 409 for an id the account already knows', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const res = await post(
      '/v1/accounts/@drej/devices',
      { device: laptop.wire, vouch: vouchFor(laptop, 'drej', laptop.wire) },
      token
    )
    expect(res.status).toBe(409)
  })

  it('accepts a single-use LINK token aimed at exactly this device', async () => {
    const laptop = await account('drej')
    const phone = device('phone')
    const link = await tokenFor(laptop, 'drej', 'link', phone.wire.id)
    const body = { device: phone.wire, vouch: vouchFor(laptop, 'drej', phone.wire) }
    expect((await post('/v1/accounts/@drej/devices', body, link)).status).toBe(201)
    // Spent. A second device cannot ride the same permission.
    const third = device('browser')
    expect(
      (
        await post(
          '/v1/accounts/@drej/devices',
          { device: third.wire, vouch: vouchFor(laptop, 'drej', third.wire) },
          link
        )
      ).status
    ).toBe(401)
  })
})

describe('DELETE /v1/accounts/@h/devices/:id', () => {
  it('revokes a device and refuses to strand the account', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone')
    await post(
      '/v1/accounts/@drej/devices',
      { device: phone.wire, vouch: vouchFor(laptop, 'drej', phone.wire) },
      token
    )
    expect((await call('DELETE', `/v1/accounts/@drej/devices/${phone.wire.id}`, undefined, token)).status).toBe(200)
    // The revoked device can no longer sign in at all.
    await expect(tokenFor(phone, 'drej', 'account')).rejects.toThrow()
    // And the last one standing cannot be dropped.
    const last = await call('DELETE', `/v1/accounts/@drej/devices/${laptop.wire.id}`, undefined, token)
    expect(last.status).toBe(409)
    expect(await last.json()).toEqual({ error: 'last_device' })
  })

  it('is 404 for a device this account never held, 401 without a token', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    expect((await call('DELETE', `/v1/accounts/@drej/devices/${randomUUID()}`, undefined, token)).status).toBe(404)
    expect((await call('DELETE', `/v1/accounts/@drej/devices/${laptop.wire.id}`)).status).toBe(401)
  })
})

/* ── link codes ──────────────────────────────────────────────────────────── */

describe('link codes', () => {
  it('carries a new browser into an account with six characters', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const issued = (await (await post('/v1/accounts/@drej/link-codes', {}, token)).json()) as {
      code: string
      exp: number
    }
    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    expect(issued.exp).toBe(now + 2 * 60 * 1000)

    const browser = device('browser', 'Chrome')
    // NO TOKEN: the browser holds no key this account knows yet, which is the
    // entire reason the code exists.
    const res = await post('/v1/accounts/@drej/link', { code: issued.code, device: browser.wire })
    expect(res.status).toBe(201)
    expect(identity.accounts.device('drej', browser.wire.id)?.boundBy).toBe(laptop.wire.id)
    expect(await tokenFor(browser, 'drej', 'download')).toBeTypeOf('string')
  })

  it('spends a code once, and answers 404 for a code that was never issued', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const issued = (await (await post('/v1/accounts/@drej/link-codes', {}, token)).json()) as { code: string }
    await post('/v1/accounts/@drej/link', { code: issued.code, device: device('browser').wire })
    const again = await post('/v1/accounts/@drej/link', { code: issued.code, device: device('browser').wire })
    expect(again.status).toBe(404)
    expect((await post('/v1/accounts/@drej/link', { code: 'ZZZZZZ', device: device('browser').wire })).status).toBe(404)
  })

  it('is 410 once the two minutes are up', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const issued = (await (await post('/v1/accounts/@drej/link-codes', {}, token)).json()) as { code: string }
    now += 2 * 60 * 1000 + 1
    const res = await post('/v1/accounts/@drej/link', { code: issued.code, device: device('browser').wire })
    expect(res.status).toBe(410)
  })

  it('refuses to hand a code to anyone but the account itself', async () => {
    await account('drej')
    const mira = await account('mira')
    const other = await tokenFor(mira, 'mira', 'account')
    expect((await post('/v1/accounts/@drej/link-codes', {}, other)).status).toBe(401)
    expect((await post('/v1/accounts/@drej/link-codes', {})).status).toBe(401)
  })

  it('does not let a code for one account bind a device to another', async () => {
    const laptop = await account('drej')
    await account('mira')
    const token = await tokenFor(laptop, 'drej', 'account')
    const issued = (await (await post('/v1/accounts/@drej/link-codes', {}, token)).json()) as { code: string }
    const res = await post('/v1/accounts/@mira/link', { code: issued.code, device: device('browser').wire })
    expect(res.status).toBe(404)
    // And it was burned, so it cannot be ground against handle after handle.
    expect((await post('/v1/accounts/@drej/link', { code: issued.code, device: device('browser').wire })).status).toBe(404)
  })
})

/* ── passkeys ────────────────────────────────────────────────────────────── */

describe('passkeys', () => {
  const authenticator = () => platformAuthenticator({ rpId: CONFIG.rpId, origin: CONFIG.origin })

  it('offers creation options shaped for navigator.credentials.create', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const res = await post('/v1/accounts/@drej/passkey/options', {}, token)
    expect(res.status).toBe(200)
    const options = (await res.json()) as Record<string, never>
    expect(options.rp).toEqual({ id: 'localhost', name: 'Cookrew' })
    expect(options.user).toEqual({
      id: Buffer.from('drej', 'utf8').toString('base64url'),
      name: 'drej',
      displayName: '@drej'
    })
    expect(options.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -8 }
    ])
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'preferred',
      userVerification: 'preferred'
    })
    expect(options.timeout).toBe(60_000)
    expect((await post('/v1/accounts/@drej/passkey/options', {})).status).toBe(401)
  })

  it('enrols a passkey and then SIGNS IN with it, no handle typed', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const options = (await (await post('/v1/accounts/@drej/passkey/options', {}, token)).json()) as {
      challenge: string
    }
    const auth = authenticator()
    const enrol = await post(
      '/v1/accounts/@drej/passkey',
      { name: 'Touch ID', credential: auth.create(options.challenge) },
      token
    )
    expect(enrol.status).toBe(201)
    const enrolled = (await enrol.json()) as { credentialId: string }
    expect(enrolled.credentialId).toBe(auth.credentialId)
    expect(identity.accounts.byCredentialId(auth.credentialId)?.handle).toBe('drej')

    // The sign-in: a real assertion, with the account discovered through the
    // devices table rather than named by the page.
    const challenge = (await (await post('/v1/identity/challenge')).json()) as { challenge: string }
    const signed = await post('/v1/identity/assert', { ...auth.get(challenge.challenge), scope: 'account' })
    expect(signed.status).toBe(200)
    const { token: minted } = (await signed.json()) as { token: string }
    expect(identity.verifyToken(minted)).toMatchObject({ sub: 'drej', scope: 'account' })
  })

  it('refuses a registration whose challenge, origin or type is wrong', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const auth = authenticator()
    const fresh = async (): Promise<string> =>
      ((await (await post('/v1/accounts/@drej/passkey/options', {}, token)).json()) as { challenge: string }).challenge

    expect(
      (await post('/v1/accounts/@drej/passkey', { name: 'x', credential: auth.create('made-up') }, token)).status
    ).toBe(400)
    expect(
      (
        await post(
          '/v1/accounts/@drej/passkey',
          { name: 'x', credential: auth.create(await fresh(), { origin: 'http://evil.test' }) },
          token
        )
      ).status
    ).toBe(400)
    // A LOGIN assertion presented as a registration.
    expect(
      (
        await post(
          '/v1/accounts/@drej/passkey',
          { name: 'x', credential: auth.create(await fresh(), { type: 'webauthn.get' }) },
          token
        )
      ).status
    ).toBe(400)
  })

  it('CONSUMES the registration challenge, so one ceremony enrols one key', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const options = (await (await post('/v1/accounts/@drej/passkey/options', {}, token)).json()) as {
      challenge: string
    }
    const auth = authenticator()
    expect(
      (await post('/v1/accounts/@drej/passkey', { name: 'x', credential: auth.create(options.challenge) }, token))
        .status
    ).toBe(201)
    const replay = await post(
      '/v1/accounts/@drej/passkey',
      { name: 'x', credential: auth.create(options.challenge) },
      token
    )
    expect(replay.status).toBe(400)
  })

  it('refuses an enrolment nobody with an account token asked for', async () => {
    await account('drej')
    const auth = authenticator()
    expect(
      (await post('/v1/accounts/@drej/passkey', { name: 'x', credential: auth.create('made-up') })).status
    ).toBe(401)
  })
})

/* ── the key document ────────────────────────────────────────────────────── */

describe('GET /v1/identity/key', () => {
  it('keeps `jwk` where it was and adds the revoked device ids', async () => {
    const laptop = await account('drej')
    const token = await tokenFor(laptop, 'drej', 'account')
    const phone = device('phone')
    await post(
      '/v1/accounts/@drej/devices',
      { device: phone.wire, vouch: vouchFor(laptop, 'drej', phone.wire) },
      token
    )
    const before = (await (await call('GET', '/v1/identity/key')).json()) as {
      jwk: Record<string, unknown>
      revoked: string[]
    }
    // An old verifier reads `jwk` from exactly where it always was.
    expect(before.jwk.kty).toBe('OKP')
    expect(before.revoked).toEqual([])
    await call('DELETE', `/v1/accounts/@drej/devices/${phone.wire.id}`, undefined, token)
    const after = (await (await call('GET', '/v1/identity/key')).json()) as { revoked: string[] }
    expect(after.revoked).toEqual([phone.wire.id])
  })
})

describe('the health self-description', () => {
  it('names every account route it actually mounts', async () => {
    const health = (await (await call('GET', '/v1/health')).json()) as { routes: string[] }
    for (const route of [
      'POST /v1/accounts',
      'HEAD /v1/accounts/:handle',
      'GET /v1/accounts/:handle/devices',
      'POST /v1/accounts/:handle/devices',
      'DELETE /v1/accounts/:handle/devices/:id',
      'POST /v1/accounts/:handle/link-codes',
      'POST /v1/accounts/:handle/link',
      'POST /v1/accounts/:handle/passkey/options',
      'POST /v1/accounts/:handle/passkey'
    ]) {
      expect(health.routes).toContain(route)
    }
  })
})
