import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { FRESH_MS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../registry/src/v2-session-age'
import { renewMessage } from '../registry/src/v2-renew'
import { classify } from '../src/main/account-wire'
import { codeNow, finishSetupWithTotp } from './support/second-step'
import { b64u, ed25519, getAssertion, GET_FLAGS_VERIFIED, makeCredential } from './support/webauthn'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'

/**
 * GATE 1 OVER HTTP, AS DEPLOYED (auth UX 2026-11-09, the green box).
 *
 * The registry here is built the way main.ts builds it — no option names a
 * mode — on a clock this file moves. Every rule in the ruling is driven:
 * the second step is mandatory, a passkey is the whole sign-in, approve is no
 * second step, an account without one sets it up first (and only where a
 * stranger could not), sessions end idle at seven days and absolutely at
 * thirty, and the sensitive acts ask again after five minutes.
 */

const PASSWORD = 'correct horse battery staple'

let clock = Date.now()
let site: { origin: string; rpId: string; v2: V2Identity; close: () => Promise<void> }

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate1-'))
  const v2 = createV2(dir, { now: () => clock, limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, renewPerMinute: 1000 } })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  site = {
    origin: `http://127.0.0.1:${port}`,
    rpId: '127.0.0.1',
    v2,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
})
afterAll(async () => {
  await site.close()
})

const call = async (method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${site.origin}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let parsed: Record<string, unknown> = {}
  try {
    parsed = (await res.json()) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { status: res.status, body: parsed }
}

interface Desk {
  id: string
  kind: string
  name: string
  jwk: Record<string, unknown>
  key: ReturnType<typeof generateKeyPairSync>['privateKey']
}
const device = (kind = 'desktop', name = 'Solis'): Desk => {
  const pair = generateKeyPairSync('ed25519')
  return { id: randomUUID(), kind, name, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>, key: pair.privateKey }
}
const wire = (d: Desk) => ({ id: d.id, kind: d.kind, name: d.name, jwk: d.jwk })

let minted = 0
/** A new account, through its set-up, with an authenticator. */
async function owner(): Promise<{ username: string; desk: Desk; token: string; secret: string; codes: string[] }> {
  const username = `gate${++minted}`
  const desk = device()
  const claimed = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: wire(desk) })
  expect(claimed.status).toBe(403)
  const done = await finishSetupWithTotp(site.origin, String(claimed.body.pending), clock)
  return { username, desk, token: done.token, secret: done.secret, codes: done.codes }
}

describe('a new account', () => {
  it('is made, but gets no session until it has a second step and has saved its codes', async () => {
    const username = `fresh${++minted}`
    const desk = device()
    const claimed = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: wire(desk) })
    expect(claimed.status).toBe(403)
    expect(claimed.body).toMatchObject({ error: 'second_step_setup', setup: ['passkey', 'totp'] })
    expect(claimed.body.token).toBeUndefined()
    const pending = String(claimed.body.pending)
    // Not before a factor, and not before the codes are said to be saved.
    expect((await call('POST', `/v2/sessions/${pending}/setup/finish`, { saved: true })).status).toBe(400)
    const started = await call('POST', `/v2/sessions/${pending}/setup/totp`, {})
    const confirmed = await call('POST', `/v2/sessions/${pending}/setup/totp/confirm`, { code: codeNow(String(started.body.secret), clock) })
    expect(confirmed.status).toBe(201)
    expect((confirmed.body.codes as string[]).length).toBe(8)
    expect((await call('POST', `/v2/sessions/${pending}/setup/finish`, {})).status).toBe(400)
    const finished = await call('POST', `/v2/sessions/${pending}/setup/finish`, { saved: true })
    expect(finished.status).toBe(201)
    expect((await call('GET', '/v2/me', undefined, String(finished.body.token))).status).toBe(200)
  })

  it('can set up a passkey instead, and the passkey must verify the person', async () => {
    const username = `pk${++minted}`
    const claimed = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: wire(device()) })
    const pending = String(claimed.body.pending)
    const options = await call('POST', `/v2/sessions/${pending}/setup/passkey/options`, {})
    expect(options.status).toBe(200)
    expect((options.body.authenticatorSelection as { userVerification: string }).userVerification).toBe('required')
    const credential = makeCredential({ pair: ed25519(), credentialId: randomBytes(16), challenge: String(options.body.challenge), origin: site.origin, rpId: site.rpId })
    const added = await call('POST', `/v2/sessions/${pending}/setup/passkey`, { name: 'Touch ID', credential })
    expect(added.status).toBe(201)
    expect(added.body.setUp).toBe('passkey')
    expect((await call('POST', `/v2/sessions/${pending}/setup/finish`, { saved: true })).status).toBe(201)
  })
})

describe('signing in', () => {
  it('a password is the first step only: the ladder follows, and approve is never offered', async () => {
    const me = await owner()
    const fresh = await call('POST', '/v2/sessions', { username: me.username, password: PASSWORD, device: wire(device('browser', 'Chrome')) })
    expect(fresh.status).toBe(401)
    expect(fresh.body.next).toEqual(['totp', 'recovery'])
    // Not even on a device the account already knows.
    const known = await call('POST', '/v2/sessions', { username: me.username, password: PASSWORD, device: wire(me.desk) })
    expect(known.status).toBe(401)
    expect((await call('POST', `/v2/sessions/${String(fresh.body.pending)}/approve`, {})).status).toBe(400)
    // The next code: the one the set-up spent cannot be spent twice.
    const done = await call('POST', `/v2/sessions/${String(fresh.body.pending)}/totp`, { code: codeNow(me.secret, clock + 30_000) })
    expect(done.status).toBe(201)
  })

  it('a passkey with user verification is the whole sign-in', async () => {
    const me = await owner()
    const pair = ed25519()
    const credentialId = randomBytes(16)
    const opts = await call('POST', '/v2/me/passkeys/options', {}, me.token)
    expect(opts.status).toBe(200)
    const credential = makeCredential({ pair, credentialId, challenge: String(opts.body.challenge), origin: site.origin, rpId: site.rpId })
    expect((await call('POST', '/v2/me/passkeys', { name: 'Face ID', credential }, me.token)).status).toBe(201)
    const challenge = await call('GET', '/v2/sessions/passkey/options')
    const asserted = getAssertion({ pair, credentialId, challenge: String(challenge.body.challenge), origin: site.origin, rpId: site.rpId, flags: GET_FLAGS_VERIFIED })
    const signedIn = await call('POST', '/v2/sessions/passkey', { credential: asserted, device: wire(device('phone', 'iPhone')) })
    expect(signedIn.status).toBe(201)
  })

  it('an account that predates the ruling sets its second step up on a device it knows, and nowhere else', async () => {
    const username = `old${++minted}`
    const desk = device()
    const made = await site.v2.accounts.create({ username, password: PASSWORD, device: wire(desk) })
    expect(made.ok).toBe(true)
    const stranger = await call('POST', '/v2/sessions', { username, password: PASSWORD, device: wire(device('browser', 'Elsewhere')) })
    expect(stranger.status).toBe(403)
    expect(stranger.body).toMatchObject({ error: 'second_step_elsewhere' })
    expect(stranger.body.pending).toBeUndefined()
    // Even on its own device, the DIRECT path opens no set-up: a device id and
    // its public key are no secret, so a phished password must not be able to
    // enrol a factor by naming the owner's laptop (review, 11-09). The set-up
    // runs on auth.cookrew.dev, where the key is proven (gate1-auth-site.test).
    const home = await call('POST', '/v2/sessions', { username, password: PASSWORD, device: wire(desk) })
    expect(home.status).toBe(403)
    expect(home.body.error).toBe('second_step_setup')
    expect(home.body.pending).toBeUndefined()
  })

  it('tells an app that cannot set one up exactly what to do, in a sentence it shows as it is', async () => {
    const username = `app${++minted}`
    const desk = device()
    await site.v2.accounts.create({ username, password: PASSWORD, device: wire(desk) })
    const res = await fetch(`${site.origin}/v2/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, device: wire(desk) })
    })
    const body = (await res.json()) as { error: string; message: string }
    // What a 0.5.x app's classify() makes of it: not a wrong password, and the sentence intact.
    const read = classify(res.status, body)
    expect(read.reason).not.toBe('bad_credentials')
    expect(read.message).toContain('auth.cookrew.dev')
    expect(read.message).toContain('update Cookrew')
  })
})

describe('five minutes for the sensitive acts', () => {
  it('a fresh sign-in may add a factor; five minutes later it must prove itself, and then may again', async () => {
    const me = await owner()
    expect((await call('POST', '/v2/me/recovery-codes', {}, me.token)).status).toBe(201)
    clock += FRESH_MS + 1000
    const asked = await call('POST', '/v2/me/recovery-codes', {}, me.token)
    expect(asked.status).toBe(401)
    expect(asked.body.error).toBe('step_up')
    expect((await call('POST', '/v2/me/recovery-codes', { current: PASSWORD }, me.token)).status).toBe(201)
    // Proved just now: the next sensitive act inside the window is not asked.
    expect((await call('DELETE', '/v2/me/totp', {}, me.token)).status).toBe(204)
  })

  it('removing a device asks too, once the window has passed', async () => {
    const me = await owner()
    const second = await call('POST', '/v2/sessions', { username: me.username, password: PASSWORD, device: wire(device('phone', 'iPhone')) })
    const phone = await call('POST', `/v2/sessions/${String(second.body.pending)}/totp`, { code: codeNow(me.secret, clock + 30_000) })
    expect(phone.status).toBe(201)
    clock += FRESH_MS + 1000
    expect((await call('DELETE', `/v2/me/devices/${String(phone.body.deviceId)}`, undefined, me.token)).status).toBe(401)
  })
})

describe('how long a session lives', () => {
  it('ends after seven days unused', async () => {
    const me = await owner()
    clock += SESSION_IDLE_MS + 1000
    expect((await call('GET', '/v2/me', undefined, me.token)).status).toBe(401)
  })

  it('ends thirty days after the sign-in however much it is used, and renewal does not restart the clock', async () => {
    const me = await owner()
    let token = me.token
    for (let day = 0; day < 29; day += 6) {
      clock += 6 * 24 * 60 * 60 * 1000
      expect((await call('GET', '/v2/me', undefined, token)).status).toBe(200)
      const nonce = await call('GET', '/v2/sessions/renew-nonce')
      const sig = sign(null, Buffer.from(renewMessage(me.username, me.desk.id, String(nonce.body.nonce))), me.desk.key).toString('base64url')
      const renewed = await call('POST', '/v2/sessions/renew', { device: me.desk.id, nonce: nonce.body.nonce, sig })
      expect(renewed.status).toBe(201)
      token = String(renewed.body.token)
    }
    clock += SESSION_ABSOLUTE_MS
    expect((await call('GET', '/v2/me', undefined, token)).status).toBe(401)
    const nonce = await call('GET', '/v2/sessions/renew-nonce')
    const sig = sign(null, Buffer.from(renewMessage(me.username, me.desk.id, String(nonce.body.nonce))), me.desk.key).toString('base64url')
    const late = await call('POST', '/v2/sessions/renew', { device: me.desk.id, nonce: nonce.body.nonce, sig })
    expect(late.status).toBe(401)
    expect(String(late.body.message)).toContain('Sign in again')
  })

  it('a session written before the ruling gets thirty days from its first use after the deploy', async () => {
    const me = await owner()
    const account = site.v2.accounts.get(me.username)!
    // As an old file held it: no clocks at all.
    const bare = account.sessions.map(({ jti, dev, issuedAt }) => ({ jti, dev, issuedAt: issuedAt - 60 * 24 * 60 * 60 * 1000 }))
    ;(site.v2.accounts as unknown as { replace: (a: unknown) => void }).replace({ ...account, sessions: bare })
    expect((await call('GET', '/v2/me', undefined, me.token)).status).toBe(200)
    const touched = site.v2.accounts.get(me.username)!.sessions.find((x) => x.jti === bare[0].jti)!
    // Its thirty days start now, not from an issue date sixty days ago.
    expect(touched.signedInAt).toBe(clock)
    expect(touched.lastUsedAt).toBe(clock)
  })
})

it('main.ts builds the registry with the gate on: no option is the required mode', () => {
  const v2 = createV2(mkdtempSync(path.join(tmpdir(), 'gate1-default-')))
  expect(v2.secondStep).toBe('required')
  expect(v2.freshWindowMs).toBe(FRESH_MS)
  expect(createV2(mkdtempSync(path.join(tmpdir(), 'gate1-wide-')), { freshWindowMs: 60 * 60_000 }).freshWindowMs).toBe(FRESH_MS)
  void b64u
  void createPrivateKey
})
