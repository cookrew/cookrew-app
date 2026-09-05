import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { DEV_CONFIG, IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { ASSETS } from '../registry/src/assets-bundle'
import { legacyDeviceId } from '../registry/src/v2-migrate-routes'
import { deviceIdFor } from '../src/main/account-v2'

/**
 * PHASE 6 — TODAY'S HANDLES BECOME ACCOUNTS.
 *
 * A handle in credentials.json with no account behind it is RESERVED for the
 * key that holds it: nobody else may claim the name, and the holder turns it
 * into an account by signing the same v1 ceremony they already sign, then
 * setting a password.
 *
 * Two things are proved here that matter more than the happy path. The old
 * app is untouched — /v1/identity/assert keeps minting for a handle that has
 * been migrated, so a desktop that has not been updated keeps serving. And
 * nothing here can be spent by a stranger: a name with no key behind it, an
 * assertion signed by the wrong key, and an assertion naming another handle
 * are all refused before a password is stretched.
 */

const PASSWORD = 'correct horse battery staple'
const HANDLE = 'drej'

/** A desktop device, in the shape /v2/accounts already takes. */
const device = (name = 'This Mac'): Record<string, unknown> => ({
  id: randomUUID(),
  kind: 'desktop',
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

/**
 * THE v1 CEREMONY, produced the way the old app and the site produce it —
 * rpIdHash ‖ flags ‖ counter, signed whole with the legacy key. Written here
 * rather than imported so this test proves the WIRE, not a shared helper.
 */
function assertionFor(
  keys: { privateKey: KeyObject },
  challenge: string,
  credentialId = HANDLE
): Record<string, string> {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', origin: DEV_CONFIG.origin, challenge }),
    'utf8'
  )
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(DEV_CONFIG.rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  const signature = sign(
    null,
    Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
    keys.privateKey
  )
  return {
    credentialId,
    clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: authenticatorData.toString('base64url'),
    signature: signature.toString('base64url')
  }
}

interface Up {
  origin: string
  identity: IdentityService
  close: () => Promise<void>
}

async function up(limits?: { accountsPerMinute: number; sessionsPerMinute: number }): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-migrate-'))
  const identity = new IdentityService(dir)
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity,
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, limits === undefined ? {} : { limits })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    identity,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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
let keys: { privateKey: KeyObject; publicKey: KeyObject }

const call = (method: string, at: string, body?: unknown): Promise<Response> =>
  fetch(`${site.origin}${at}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })

/** A fresh single-use nonce, exactly as the app asks for one. */
async function challenge(): Promise<string> {
  const answer = (await (await call('POST', '/v1/identity/challenge', {})).json()) as {
    challenge?: string
  }
  return answer.challenge ?? ''
}

const migrateBody = async (
  over: Record<string, unknown> = {},
  signing = keys
): Promise<Record<string, unknown>> => ({
  username: HANDLE,
  password: PASSWORD,
  device: device(),
  assertion: assertionFor(signing, await challenge()),
  ...over
})

beforeEach(async () => {
  site = await up({ accountsPerMinute: 1000, sessionsPerMinute: 1000 })
  keys = generateKeyPairSync('ed25519')
  // The handle as it exists today: a credential id and the key that signs for it.
  site.identity.register(HANDLE, keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
})
afterEach(async () => {
  await site.close()
})

describe('a v1 handle is reserved for the key that holds it', () => {
  it('reads as taken, so no sheet offers it as free', async () => {
    expect((await call('HEAD', `/v2/accounts/${HANDLE}`)).status).toBe(200)
    expect((await call('HEAD', '/v2/accounts/nobody')).status).toBe(404)
  })

  it('refuses a claim with the sentence that says where the name went', async () => {
    const refused = await call('POST', '/v2/accounts', {
      username: HANDLE,
      password: PASSWORD,
      device: device()
    })
    expect(refused.status).toBe(409)
    const body = (await refused.json()) as { error?: string; message?: string }
    expect(body.error).toBe('legacy')
    expect(body.message).toBe(
      `@${HANDLE} already exists from before passwords — sign in with the key that holds it and set a password.`
    )
  })

  it('leaves every other name claimable', async () => {
    const claimed = await call('POST', '/v2/accounts', {
      username: 'somebody',
      password: PASSWORD,
      device: device()
    })
    expect(claimed.status).toBe(201)
  })
})

describe('GET /v2/migrate/:username — is this name waiting for a password?', () => {
  it('names the name and carries the sentence the sheet shows', async () => {
    const answer = await call('GET', `/v2/migrate/${HANDLE}`)
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { username?: string; legacy?: boolean; message?: string }
    expect(body).toMatchObject({ username: HANDLE, legacy: true })
    expect(body.message).toContain('from before passwords')
  })

  it('is a 404 for a stranger, and for a name that has already crossed', async () => {
    expect((await call('GET', '/v2/migrate/nobody')).status).toBe(404)
    expect((await call('POST', '/v2/migrate', await migrateBody())).status).toBe(201)
    expect((await call('GET', `/v2/migrate/${HANDLE}`)).status).toBe(404)
  })
})

describe('POST /v2/migrate', () => {
  it('mints the account, seats this desktop, and keeps the old key as a device', async () => {
    const desktop = device('MacBook Pro')
    const answer = await call('POST', '/v2/migrate', await migrateBody({ device: desktop }))
    expect(answer.status).toBe(201)
    expect(answer.headers.get('set-cookie') ?? '').toContain('cr_session=')
    const body = (await answer.json()) as {
      username?: string
      deviceId?: string
      session?: { token?: string; exp?: number }
    }
    expect(body.username).toBe(HANDLE)
    expect(body.deviceId).toBe(desktop.id)
    expect(typeof body.session?.token).toBe('string')

    const me = await fetch(`${site.origin}/v2/me`, {
      headers: { authorization: `Bearer ${body.session?.token ?? ''}` }
    })
    expect(me.status).toBe(200)
    const profile = (await me.json()) as { devices: { id: string; kind: string; name: string }[] }
    expect(profile.devices).toHaveLength(2)
    const legacy = profile.devices.find((d) => d.kind === 'legacy')
    expect(legacy?.id).toBe(
      legacyDeviceId(keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
    )
    expect(legacy?.name).toBe(`@${HANDLE} key`)
  })

  it('signs the account in — the name is taken from then on', async () => {
    expect((await call('POST', '/v2/migrate', await migrateBody())).status).toBe(201)
    const again = await call('POST', '/v2/accounts', {
      username: HANDLE,
      password: PASSWORD,
      device: device()
    })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error?: string }).error).toBe('taken')
    // And the same password is now the account's, like any other: a device the
    // account has never seen is offered the phase 4 rung rather than refused.
    const session = await call('POST', '/v2/sessions', {
      username: HANDLE,
      password: PASSWORD,
      device: device('Another Mac')
    })
    expect(session.status).toBe(401)
    expect(((await session.json()) as { error?: string }).error).toBe('second_factor')
  })

  it('refuses a migration twice — the second is a name somebody holds', async () => {
    expect((await call('POST', '/v2/migrate', await migrateBody())).status).toBe(201)
    const twice = await call('POST', '/v2/migrate', await migrateBody())
    expect(twice.status).toBe(409)
    expect(((await twice.json()) as { error?: string }).error).toBe('taken')
  })

  it('refuses an assertion signed by another key, and one naming another handle', async () => {
    const stranger = generateKeyPairSync('ed25519')
    const wrongKey = await call('POST', '/v2/migrate', await migrateBody({}, stranger))
    expect(wrongKey.status).toBe(401)
    expect(((await wrongKey.json()) as { error?: string }).error).toBe('bad_credentials')

    site.identity.register(
      'other',
      generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    )
    const wrongName = await call('POST', '/v2/migrate', {
      ...(await migrateBody()),
      username: 'other'
    })
    expect(wrongName.status).toBe(401)
  })

  it('refuses a name no key holds, before it looks at a password', async () => {
    const answer = await call('POST', '/v2/migrate', {
      ...(await migrateBody()),
      username: 'nobody'
    })
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error?: string }).error).toBe('not_found')
  })

  it('refuses a password under the floor, and a device that says nothing', async () => {
    const weak = await call('POST', '/v2/migrate', await migrateBody({ password: 'short' }))
    expect(weak.status).toBe(400)
    expect(((await weak.json()) as { error?: string }).error).toBe('weak_password')
    const nameless = await call('POST', '/v2/migrate', await migrateBody({ device: { id: 'x' } }))
    expect(nameless.status).toBe(400)
    expect(((await nameless.json()) as { error?: string }).error).toBe('bad_device')
  })

  it('spends a nonce once: the same assertion cannot be replayed', async () => {
    const body = await migrateBody()
    const first = await call('POST', '/v2/migrate', { ...body, password: 'short' })
    expect(first.status).toBe(400)
    // The ceremony was consumed by the attempt, weak password and all.
    const replay = await call('POST', '/v2/migrate', body)
    expect(replay.status).toBe(401)
  })

  it('is bounded like a claim', async () => {
    const bounded = await up({ accountsPerMinute: 1, sessionsPerMinute: 5 })
    try {
      const answer = await fetch(`${bounded.origin}/v2/migrate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: HANDLE, password: PASSWORD, device: device() })
      })
      expect(answer.status).not.toBe(429)
      const again = await fetch(`${bounded.origin}/v2/migrate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: HANDLE, password: PASSWORD, device: device() })
      })
      expect(again.status).toBe(429)
    } finally {
      await bounded.close()
    }
  })

  it('refuses a cookie-carried write from another site', async () => {
    const answer = await fetch(`${site.origin}/v2/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' },
      body: JSON.stringify(await migrateBody())
    })
    expect(answer.status).toBe(403)
  })
})

describe('the old app keeps working against the new registry', () => {
  it('still mints a v1 token for a handle that has been migrated', async () => {
    expect((await call('POST', '/v2/migrate', await migrateBody())).status).toBe(201)
    const asserted = await call('POST', '/v1/identity/assert', {
      ...assertionFor(keys, await challenge()),
      scope: 'download'
    })
    expect(asserted.status).toBe(200)
    expect(typeof ((await asserted.json()) as { token?: string }).token).toBe('string')
  })
})

describe('the site’s sheet carries the crossing', () => {
  it('is in the shipped bundle, with the sentence for a key on another device', () => {
    expect(ASSETS['site.js'].body).toContain('/v2/migrate')
    expect(ASSETS['site.js'].body).toContain('This name belongs to a key on another device')
    // The ceremony is the v1 one this script already performs, not a new copy.
    expect(ASSETS['site.js'].body).toContain('assertion(account')
  })
})

describe('the legacy device id', () => {
  it('is the same value the desktop derives from the same key', () => {
    const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(legacyDeviceId(jwk)).toBe(deviceIdFor(jwk))
  })

  it('is null for anything that is not a public device key', () => {
    expect(legacyDeviceId({ kty: 'RSA' })).toBe(null)
  })
})
