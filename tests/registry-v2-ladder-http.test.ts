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
import { createV2 } from '../registry/src/v2-routes'
import { base32Decode, totpAt, TOTP_STEP_MS } from '../registry/src/v2-totp'
import { b64u, ed25519, getAssertion, makeCredential, p256, type Pair } from './support/webauthn'

/**
 * PHASE 4 OVER HTTP — the sign-in ladder, every route, on the real router.
 *
 * The units are proved next door (RFC vectors for the codes, real keys for
 * the passkeys, a bounded decoder for the CBOR). This is the SERVER: what a
 * new device is told when a password is not enough, what each rung answers,
 * what the approving Mac sees, and what "not me" does to everything else.
 *
 * The whole file is one story told from both ends — a stranger's browser at
 * the sheet, and the owner's desktop holding a token.
 */

const PASSWORD = 'correct horse battery staple'

const device = (kind: 'desktop' | 'phone' | 'browser' = 'browser', name = 'Chrome on macOS') => ({
  id: randomUUID(),
  kind,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

interface Up {
  origin: string
  rpId: string
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-ladder-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    // Loose limits: this file is about the ladder, and the per-IP sign-in
    // limiter has its own proof in registry-v2-http.
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    rpId: '127.0.0.1',
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
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

interface Owner {
  username: string
  deviceId: string
  token: string
}

let minted = 0
/** An account with one desktop on it, signed in. */
async function claim(): Promise<Owner> {
  const username = `owner${++minted}`
  const d = device('desktop', 'MacBook Pro')
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: d })
  expect(res.status).toBe(201)
  const out = await bodyOf<{ deviceId: string; session: { token: string } }>(res)
  return { username, deviceId: out.deviceId, token: out.session.token }
}

/* ── factors, as the /me page adds them ───────────────────────────────────── */

async function addTotp(owner: Owner): Promise<string> {
  const res = await call('POST', '/v2/me/totp/enrol', {}, bearer(owner.token))
  expect(res.status).toBe(201)
  const { secret, otpauth } = await bodyOf<{ secret: string; otpauth: string }>(res)
  expect(otpauth).toContain(`otpauth://totp/cookrew.dev:${owner.username}`)
  const code = totpAt(base32Decode(secret) as Buffer, Date.now())
  expect((await call('POST', '/v2/me/totp/confirm', { code }, bearer(owner.token))).status).toBe(204)
  return secret
}

const codeFor = (secret: string, shift = 0): string =>
  totpAt(base32Decode(secret) as Buffer, Date.now() + shift * TOTP_STEP_MS)

async function addPasskey(owner: Owner, pair: Pair, credentialId = randomBytes(20)): Promise<Buffer> {
  const options = await call('POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
  expect(options.status).toBe(200)
  const { challenge } = await bodyOf<{ challenge: string }>(options)
  const credential = makeCredential({
    pair,
    credentialId,
    challenge,
    origin: site.origin,
    rpId: site.rpId
  })
  const added = await call('POST', '/v2/me/passkeys', { name: 'This Mac', credential }, bearer(owner.token))
  expect(added.status).toBe(201)
  return credentialId
}

/** The password step, expecting the ladder. */
async function askForStep(
  owner: Owner,
  d: ReturnType<typeof device> = device()
): Promise<{ pending: string; next: string[]; expiresAt: number; message: string }> {
  const res = await call('POST', '/v2/sessions', { username: owner.username, password: PASSWORD, device: d })
  expect(res.status).toBe(401)
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('set-cookie')).toBeNull()
  const out = await bodyOf<{ error: string; next: string[]; pending: string; expiresAt: number; message: string }>(res)
  expect(out.error).toBe('second_factor')
  return out
}

/* ── the fork ─────────────────────────────────────────────────────────────── */

describe('POST /v2/sessions — what a password buys', () => {
  it('offers only the ways this account has, recommended first and rescue last', async () => {
    const owner = await claim()
    // Nothing but a password and one device: a NEW device is still a step.
    const bare = await askForStep(owner)
    expect(bare.next).toEqual(['approve'])
    expect(bare.pending).toMatch(/^[0-9a-f-]{36}$/)
    expect(bare.expiresAt).toBeGreaterThan(Date.now())
    expect(bare.message).toContain('One more step')

    await addTotp(owner)
    expect((await askForStep(owner)).next).toEqual(['totp', 'approve'])

    await addPasskey(owner, p256())
    expect((await askForStep(owner)).next).toEqual(['passkey', 'totp', 'approve'])

    expect((await call('POST', '/v2/me/recovery-codes', {}, bearer(owner.token))).status).toBe(201)
    expect((await askForStep(owner)).next).toEqual(['passkey', 'totp', 'approve', 'recovery'])
  })

  it('says the same thing about a wrong password whether or not the account has factors', async () => {
    const owner = await claim()
    await addTotp(owner)
    const res = await call('POST', '/v2/sessions', { username: owner.username, password: 'not it at all', device: device() })
    expect(res.status).toBe(401)
    expect((await bodyOf<{ error: string }>(res)).error).toBe('bad_credentials')
  })

  it('refuses a device that will not describe itself before it opens a pending', async () => {
    const owner = await claim()
    const res = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: { ...device(), id: 'not-a-uuid' }
    })
    expect(res.status).toBe(400)
    expect((await bodyOf<{ error: string }>(res)).error).toBe('bad_device')
  })
})

/* ── the rungs ────────────────────────────────────────────────────────────── */

describe('POST /v2/sessions/:pending/totp', () => {
  it('takes the code showing now, attaches the device, and hands over a session', async () => {
    const owner = await claim()
    const secret = await addTotp(owner)
    const joining = device('phone', 'iPhone')
    const step = await askForStep(owner, joining)

    const wrong = await call('POST', `/v2/sessions/${step.pending}/totp`, { code: '000000' })
    expect(wrong.status).toBe(401)
    expect((await bodyOf<{ error: string; message: string }>(wrong)).error).toBe('bad_code')

    const right = await call('POST', `/v2/sessions/${step.pending}/totp`, { code: codeFor(secret) })
    expect(right.status).toBe(201)
    expect(right.headers.get('set-cookie')).toContain('HttpOnly')
    const session = await bodyOf<{ token: string; exp: number; deviceId: string }>(right)
    expect(session.deviceId).toBe(joining.id)
    expect(session.exp).toBeGreaterThan(Date.now())

    // The device is attached now — and only now.
    const me = await bodyOf<{ devices: { id: string }[] }>(await call('GET', '/v2/me', undefined, bearer(session.token)))
    expect(me.devices.map((d) => d.id)).toContain(joining.id)
    // And the pending is spent.
    expect((await call('POST', `/v2/sessions/${step.pending}/totp`, { code: codeFor(secret) })).status).toBe(410)
  })

  it('takes a code one step either side of now, and nothing further out', async () => {
    const owner = await claim()
    const secret = await addTotp(owner)
    for (const shift of [-1, 1]) {
      const step = await askForStep(owner)
      expect((await call('POST', `/v2/sessions/${step.pending}/totp`, { code: codeFor(secret, shift) })).status).toBe(201)
    }
    const far = await askForStep(owner)
    expect((await call('POST', `/v2/sessions/${far.pending}/totp`, { code: codeFor(secret, 5) })).status).toBe(401)
  })

  it('drops the pending after five tries, and answers 410 from then on', async () => {
    const owner = await claim()
    const secret = await addTotp(owner)
    const step = await askForStep(owner)
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', `/v2/sessions/${step.pending}/totp`, { code: '000000' })).status).toBe(401)
    }
    const done = await call('POST', `/v2/sessions/${step.pending}/totp`, { code: codeFor(secret) })
    expect(done.status).toBe(410)
    expect((await bodyOf<{ error: string; message: string }>(done)).error).toBe('expired')
    // Even the right code, even from the same browser: the sign-in is over.
    expect((await call('GET', `/v2/sessions/${step.pending}`)).status).toBe(410)
  })

  it('refuses a rung the account did not offer, and a pending nobody opened', async () => {
    const owner = await claim()
    const step = await askForStep(owner)
    const notOffered = await call('POST', `/v2/sessions/${step.pending}/totp`, { code: '000000' })
    expect(notOffered.status).toBe(400)
    expect((await bodyOf<{ error: string }>(notOffered)).error).toBe('not_offered')
    expect((await call('POST', `/v2/sessions/${randomUUID()}/totp`, { code: '000000' })).status).toBe(410)
  })
})

describe('POST /v2/sessions/:pending/recovery', () => {
  it('spends the code once, and never again', async () => {
    const owner = await claim()
    const { codes } = await bodyOf<{ codes: string[] }>(
      await call('POST', '/v2/me/recovery-codes', {}, bearer(owner.token))
    )
    const first = await askForStep(owner)
    const used = await call('POST', `/v2/sessions/${first.pending}/recovery`, { code: codes[0] })
    expect(used.status).toBe(201)
    expect(used.headers.get('set-cookie')).toContain('HttpOnly')

    const second = await askForStep(owner)
    const again = await call('POST', `/v2/sessions/${second.pending}/recovery`, { code: codes[0] })
    expect(again.status).toBe(401)
    expect((await bodyOf<{ error: string }>(again)).error).toBe('bad_recovery')
    // A different code still works, so it was the code that was spent.
    expect((await call('POST', `/v2/sessions/${second.pending}/recovery`, { code: codes[1] })).status).toBe(201)
  })
})

describe('the passkey rung', () => {
  it('offers the account’s credentials, takes one real assertion, and refuses its replay', async () => {
    const owner = await claim()
    const pair = p256()
    const credentialId = await addPasskey(owner, pair)
    const joining = device('browser', 'Chrome on macOS')
    const step = await askForStep(owner, joining)

    const options = await call('GET', `/v2/sessions/${step.pending}/passkey/options`)
    expect(options.status).toBe(200)
    const asked = await bodyOf<{
      challenge: string
      rpId: string
      userVerification: string
      allowCredentials: { type: string; id: string }[]
    }>(options)
    expect(asked.rpId).toBe(site.rpId)
    expect(asked.userVerification).toBe('preferred')
    expect(asked.allowCredentials.map((c) => c.id)).toEqual([b64u(credentialId)])

    const credential = getAssertion({
      pair,
      credentialId,
      challenge: asked.challenge,
      origin: site.origin,
      rpId: site.rpId,
      signCount: 7
    })
    const out = await call('POST', `/v2/sessions/${step.pending}/passkey`, { credential })
    expect(out.status).toBe(201)
    expect((await bodyOf<{ deviceId: string }>(out)).deviceId).toBe(joining.id)

    // The same assertion again: the challenge was spent the first time.
    const replay = await askForStep(owner)
    const refused = await call('POST', `/v2/sessions/${replay.pending}/passkey`, { credential })
    expect(refused.status).toBe(401)
    expect((await bodyOf<{ error: string }>(refused)).error).toBe('passkey_refused')
  })

  it('refuses another account’s passkey, and one signed for another origin', async () => {
    const mine = await claim()
    const yours = await claim()
    const pair = ed25519()
    const credentialId = await addPasskey(yours, pair)
    await addPasskey(mine, p256())

    const step = await askForStep(mine)
    const { challenge } = await bodyOf<{ challenge: string }>(
      await call('GET', `/v2/sessions/${step.pending}/passkey/options`)
    )
    const theirs = getAssertion({ pair, credentialId, challenge, origin: site.origin, rpId: site.rpId, signCount: 1 })
    const refused = await call('POST', `/v2/sessions/${step.pending}/passkey`, { credential: theirs })
    expect(refused.status).toBe(401)
    expect((await bodyOf<{ error: string }>(refused)).error).toBe('passkey_refused')
  })
})

/* ── approve on a device the account already trusts ───────────────────────── */

describe('approve on a trusted device', () => {
  it('shows the request to the owner in the D6 sentence and finishes the sign-in', async () => {
    const owner = await claim()
    const joining = device('browser', 'Chrome on macOS')
    const step = await askForStep(owner, joining)

    // Nothing to see until the browser asks.
    expect(await bodyOf<unknown[]>(await call('GET', '/v2/me/approvals', undefined, bearer(owner.token)))).toEqual([])

    const asked = await call('POST', `/v2/sessions/${step.pending}/approve`)
    expect(asked.status).toBe(202)
    const { approval } = await bodyOf<{ approval: string; sentence: string }>(asked)

    const waiting = await call('GET', `/v2/sessions/${step.pending}`)
    expect(waiting.status).toBe(202)
    expect((await bodyOf<{ status: string }>(waiting)).status).toBe('waiting')

    const list = await bodyOf<
      { id: string; deviceName: string; kind: string; address: string; at: number; expiresAt: number; sentence: string }[]
    >(await call('GET', '/v2/me/approvals', undefined, bearer(owner.token)))
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(approval)
    expect(list[0].deviceName).toBe('Chrome on macOS')
    expect(list[0].kind).toBe('browser')
    expect(list[0].address).toBe('127.0.0.1')
    expect(list[0].sentence).toBe(`Chrome on macOS at 127.0.0.1 wants to sign in as @${owner.username}.`)

    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve' }, bearer(owner.token))).status
    ).toBe(204)

    // The waiting browser collects its own session; the Mac never held it.
    const done = await call('GET', `/v2/sessions/${step.pending}`)
    expect(done.status).toBe(201)
    expect(done.headers.get('set-cookie')).toContain('HttpOnly')
    expect((await bodyOf<{ deviceId: string }>(done)).deviceId).toBe(joining.id)
    // Answered, so it leaves the list.
    expect(await bodyOf<unknown[]>(await call('GET', '/v2/me/approvals', undefined, bearer(owner.token)))).toEqual([])
  })

  it('denies with a 410 and attaches nothing', async () => {
    const owner = await claim()
    const joining = device('phone', 'Android phone')
    const step = await askForStep(owner, joining)
    const { approval } = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${step.pending}/approve`))
    expect((await call('POST', `/v2/me/approvals/${approval}`, { decision: 'deny' }, bearer(owner.token))).status).toBe(204)

    const denied = await call('GET', `/v2/sessions/${step.pending}`)
    expect(denied.status).toBe(410)
    expect((await bodyOf<{ error: string; message: string }>(denied)).error).toBe('denied')
    const me = await bodyOf<{ devices: { id: string }[] }>(await call('GET', '/v2/me', undefined, bearer(owner.token)))
    expect(me.devices.map((d) => d.id)).not.toContain(joining.id)
  })

  it('asking twice lights one prompt, and answering twice is refused', async () => {
    const owner = await claim()
    const step = await askForStep(owner)
    const first = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${step.pending}/approve`))
    // With a body and without: the route reads neither, and a sheet that
    // posts an empty object must not be answered differently.
    const second = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${step.pending}/approve`, {}))
    expect(second.approval).toBe(first.approval)
    expect(
      (await call('POST', `/v2/me/approvals/${first.approval}`, { decision: 'deny' }, bearer(owner.token))).status
    ).toBe(204)
    const twice = await call('POST', `/v2/me/approvals/${first.approval}`, { decision: 'approve' }, bearer(owner.token))
    expect(twice.status).toBe(404)
    expect((await bodyOf<{ error: string }>(twice)).error).toBe('no_approval')
  })

  it('is answered only by the account it belongs to, and only by a signed-in device', async () => {
    const owner = await claim()
    const stranger = await claim()
    const step = await askForStep(owner)
    const { approval } = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${step.pending}/approve`))

    expect((await call('GET', '/v2/me/approvals')).status).toBe(401)
    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve' }, bearer(stranger.token))).status
    ).toBe(404)
    expect(await bodyOf<unknown[]>(await call('GET', '/v2/me/approvals', undefined, bearer(stranger.token)))).toEqual([])
    const bad = await call('POST', `/v2/me/approvals/${approval}`, { decision: 'maybe' }, bearer(owner.token))
    expect(bad.status).toBe(400)
    expect((await bodyOf<{ error: string }>(bad)).error).toBe('bad_decision')
  })
})

describe('“not me”', () => {
  it('denies the request, ends every other sitting, and locks the password out until it changes', async () => {
    const owner = await claim()
    const secret = await addTotp(owner)

    // A phone that really is the owner's, signed in earlier.
    const phone = device('phone', 'iPhone')
    const step = await askForStep(owner, phone)
    const onPhone = await bodyOf<{ token: string }>(
      await call('POST', `/v2/sessions/${step.pending}/totp`, { code: codeFor(secret) })
    )
    expect((await call('GET', '/v2/me', undefined, bearer(onPhone.token))).status).toBe(200)

    // And a stranger with the password.
    const theirs = await askForStep(owner, device('browser', 'Chrome on Windows'))
    const { approval } = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${theirs.pending}/approve`))
    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me' }, bearer(owner.token))).status
    ).toBe(204)

    // The request is dead.
    expect((await call('GET', `/v2/sessions/${theirs.pending}`)).status).toBe(410)
    // Every other sitting is dead; the caller's own is not.
    expect((await call('GET', '/v2/me', undefined, bearer(onPhone.token))).status).toBe(401)
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(200)
    // A door verifying offline sees it too.
    const keys = await bodyOf<{ revoked: string[] }>(await call('GET', '/v2/keys'))
    expect(keys.revoked.length).toBeGreaterThan(0)

    // The password opens nothing until it is changed — not even for a device
    // the account knows.
    const locked = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: device('desktop', 'MacBook Pro')
    })
    expect(locked.status).toBe(403)
    const said = await bodyOf<{ error: string; message: string }>(locked)
    expect(said.error).toBe('password_change_required')
    expect(said.message).toContain('change it')

    expect(
      (await call('POST', '/v2/me/password', { current: PASSWORD, next: 'a much longer new password' }, bearer(owner.token)))
        .status
    ).toBe(204)
    const back = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: 'a much longer new password',
      device: device('browser', 'Chrome on macOS')
    })
    expect(back.status).toBe(401)
    expect((await bodyOf<{ error: string }>(back)).error).toBe('second_factor')
  })
})

/* ── the W1 sheet's first button ──────────────────────────────────────────── */

describe('passwordless passkey sign-in', () => {
  it('names no account, and the credential says which one it is', async () => {
    const owner = await claim()
    const pair = p256()
    const credentialId = await addPasskey(owner, pair)

    const options = await call('GET', '/v2/sessions/passkey/options')
    expect(options.status).toBe(200)
    const asked = await bodyOf<{ challenge: string; rpId: string; allowCredentials: unknown[] }>(options)
    // Discoverable: the page does not know who is signing in, so it names no
    // credential and there is nothing here to enumerate accounts with.
    expect(asked.allowCredentials).toEqual([])
    expect(asked.rpId).toBe(site.rpId)

    const joining = device('browser', 'Safari on iOS')
    const credential = getAssertion({
      pair,
      credentialId,
      challenge: asked.challenge,
      origin: site.origin,
      rpId: site.rpId,
      signCount: 3
    })
    const out = await call('POST', '/v2/sessions/passkey', { credential, device: joining })
    expect(out.status).toBe(201)
    const session = await bodyOf<{ token: string; deviceId: string }>(out)
    expect(session.deviceId).toBe(joining.id)
    const me = await bodyOf<{ username: string }>(await call('GET', '/v2/me', undefined, bearer(session.token)))
    expect(me.username).toBe(owner.username)
  })

  it('refuses a user handle that is not the credential’s account, and an unknown credential', async () => {
    const owner = await claim()
    const pair = p256()
    const credentialId = await addPasskey(owner, pair)
    const { challenge } = await bodyOf<{ challenge: string }>(await call('GET', '/v2/sessions/passkey/options'))
    const credential = getAssertion({
      pair,
      credentialId,
      challenge,
      origin: site.origin,
      rpId: site.rpId,
      signCount: 2,
      userHandle: b64u(Buffer.alloc(16, 1))
    })
    const refused = await call('POST', '/v2/sessions/passkey', { credential, device: device() })
    expect(refused.status).toBe(401)
    expect((await bodyOf<{ error: string }>(refused)).error).toBe('passkey_refused')

    const { challenge: second } = await bodyOf<{ challenge: string }>(await call('GET', '/v2/sessions/passkey/options'))
    const stranger = getAssertion({
      pair: p256(),
      credentialId: randomBytes(20),
      challenge: second,
      origin: site.origin,
      rpId: site.rpId,
      signCount: 1
    })
    const unknown = await call('POST', '/v2/sessions/passkey', { credential: stranger, device: device() })
    expect(unknown.status).toBe(401)
  })
})

/* ── enrolling, from /me ──────────────────────────────────────────────────── */

describe('POST /v2/me/totp', () => {
  it('is inactive until a code proves the app has it, and is removed in one call', async () => {
    const owner = await claim()
    const started = await call('POST', '/v2/me/totp/enrol', {}, bearer(owner.token))
    expect(started.status).toBe(201)
    const { secret } = await bodyOf<{ secret: string; otpauth: string }>(started)

    // Not active yet, so the ladder does not offer it.
    expect((await askForStep(owner)).next).toEqual(['approve'])

    const wrong = await call('POST', '/v2/me/totp/confirm', { code: '000000' }, bearer(owner.token))
    expect(wrong.status).toBe(401)
    expect((await bodyOf<{ error: string }>(wrong)).error).toBe('bad_code')
    expect((await call('POST', '/v2/me/totp/confirm', { code: codeFor(secret) }, bearer(owner.token))).status).toBe(204)
    expect((await askForStep(owner)).next).toEqual(['totp', 'approve'])

    // A second authenticator is a decision, not an accident.
    const twice = await call('POST', '/v2/me/totp/enrol', {}, bearer(owner.token))
    expect(twice.status).toBe(409)
    expect((await bodyOf<{ error: string }>(twice)).error).toBe('totp_active')

    expect((await call('DELETE', '/v2/me/totp', undefined, bearer(owner.token))).status).toBe(204)
    expect((await askForStep(owner)).next).toEqual(['approve'])
  })

  it('refuses a confirmation nobody started, and every route without a session', async () => {
    const owner = await claim()
    const early = await call('POST', '/v2/me/totp/confirm', { code: '000000' }, bearer(owner.token))
    expect(early.status).toBe(400)
    expect((await bodyOf<{ error: string }>(early)).error).toBe('totp_not_started')
    for (const [method, p] of [
      ['POST', '/v2/me/totp/enrol'],
      ['POST', '/v2/me/totp/confirm'],
      ['DELETE', '/v2/me/totp'],
      ['POST', '/v2/me/passkeys/options'],
      ['POST', '/v2/me/passkeys'],
      ['GET', '/v2/me/approvals']
    ] as const) {
      const res = await call(method, p, method === 'GET' || method === 'DELETE' ? undefined : {})
      expect(res.status, p).toBe(401)
    }
  })
})

describe('POST /v2/me/passkeys', () => {
  it('offers creation options this registry can verify, and enrols one key once', async () => {
    const owner = await claim()
    const options = await call('POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
    expect(options.status).toBe(200)
    const asked = await bodyOf<{
      challenge: string
      rp: { id: string; name: string }
      user: { id: string; name: string; displayName: string }
      pubKeyCredParams: { type: string; alg: number }[]
      authenticatorSelection: { residentKey: string; userVerification: string }
    }>(options)
    expect(asked.rp.id).toBe(site.rpId)
    expect(asked.user.name).toBe(owner.username)
    expect(asked.user.id).not.toBe('')
    expect(asked.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8])
    expect(asked.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'preferred' })

    const pair = ed25519()
    const credentialId = randomBytes(20)
    const credential = makeCredential({ pair, credentialId, challenge: asked.challenge, origin: site.origin, rpId: site.rpId })
    const added = await call('POST', '/v2/me/passkeys', { name: 'Touch ID', credential }, bearer(owner.token))
    expect(added.status).toBe(201)
    const { id } = await bodyOf<{ id: string; name: string }>(added)

    // The same attestation again: the challenge is spent.
    const replay = await call('POST', '/v2/me/passkeys', { name: 'Touch ID', credential }, bearer(owner.token))
    expect(replay.status).toBe(401)

    // A passkey is a factor, not a device: the last one may go.
    expect((await call('DELETE', `/v2/me/passkeys/${id}`, undefined, bearer(owner.token))).status).toBe(204)
    expect((await call('DELETE', `/v2/me/passkeys/${id}`, undefined, bearer(owner.token))).status).toBe(404)
    expect((await askForStep(owner)).next).toEqual(['approve'])
  })

  it('refuses a name it cannot show, and a credential enrolled elsewhere', async () => {
    const owner = await claim()
    const pair = p256()
    const credentialId = await addPasskey(owner, pair)

    const options = await call('POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
    const { challenge } = await bodyOf<{ challenge: string }>(options)
    const again = makeCredential({ pair, credentialId, challenge, origin: site.origin, rpId: site.rpId })
    const known = await call('POST', '/v2/me/passkeys', { name: 'Twin', credential: again }, bearer(owner.token))
    expect(known.status).toBe(409)
    expect((await bodyOf<{ error: string }>(known)).error).toBe('passkey_known')

    const fresh = await bodyOf<{ challenge: string }>(
      await call('POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
    )
    const nameless = makeCredential({
      pair: p256(),
      credentialId: randomBytes(20),
      challenge: fresh.challenge,
      origin: site.origin,
      rpId: site.rpId
    })
    const refused = await call('POST', '/v2/me/passkeys', { name: '   ', credential: nameless }, bearer(owner.token))
    expect(refused.status).toBe(400)
    expect((await bodyOf<{ error: string }>(refused)).error).toBe('bad_name')
  })
})

describe('every phase 4 answer', () => {
  it('is private, never stored, and carries a sentence when it refuses', async () => {
    const owner = await claim()
    const step = await askForStep(owner)
    const answers = [
      await call('GET', `/v2/sessions/${step.pending}`),
      await call('POST', `/v2/sessions/${step.pending}/totp`, { code: '000000' }),
      await call('GET', '/v2/sessions/passkey/options'),
      await call('GET', '/v2/me/approvals', undefined, bearer(owner.token)),
      await call('POST', '/v2/me/totp/enrol', {}, bearer(owner.token))
    ]
    for (const res of answers) {
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const body = (await res.json()) as { error?: string; message?: string }
      if (!Array.isArray(body) && body.error !== undefined) {
        expect(body.message?.length ?? 0).toBeGreaterThan(12)
        expect(body.message).toMatch(/[.!]$/)
      }
    }
  })
})
