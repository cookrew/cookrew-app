import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { PendingSignIns } from '../registry/src/v2-pending'
import { STEP_UP_ACTS, isStepUpAct } from '../src/shared/step-up'

/**
 * PROVE IT IS YOU, AGAIN.
 *
 * The session renews on the device key now, so the password is no longer a
 * monthly heartbeat — which means a stolen session would otherwise be a month
 * of quiet access to everything. The step-up list is the answer, and these
 * tests are about the two things that make it worth having: that the ladder is
 * the SAME ladder a sign-in climbs, and that what it buys is permission for
 * ONE act, once.
 */

const PASSWORD = 'correct horse battery staple'

const device = (name = 'MacBook Pro') => ({
  id: randomUUID(),
  kind: 'desktop' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

interface Up {
  origin: string
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-stepup-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
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
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

let minted = 0
async function claim(): Promise<{ username: string; token: string }> {
  const username = `stepper${++minted}`
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: device() })
  expect(res.status).toBe(201)
  return { username, token: (await bodyOf<{ session: { token: string } }>(res)).session.token }
}

const codeFor = (secret: string, shift = 0): string =>
  totpAt(base32Decode(secret) as Buffer, Date.now() + shift * TOTP_STEP_MS)

/** Give the account something stronger than its password. */
async function addTotp(token: string): Promise<string> {
  const res = await call('POST', '/v2/me/totp/enrol', {}, bearer(token))
  expect(res.status).toBe(201)
  const { secret } = await bodyOf<{ secret: string }>(res)
  expect((await call('POST', '/v2/me/totp/confirm', { code: codeFor(secret, -1) }, bearer(token))).status).toBe(204)
  return secret
}

/* ── the list itself ───────────────────────────────────────────────────────── */

describe('the step-up list', () => {
  it('names the seven acts the architecture note names, in its order', () => {
    expect(STEP_UP_ACTS).toEqual([
      'change-password',
      'remove-factor',
      'revoke-device',
      'mint-join-code',
      'take-over-door',
      'end-seat',
      'not-me'
    ])
  })

  it('can be asked about at runtime, which is why it is an array and not only a type', () => {
    expect(isStepUpAct('mint-join-code')).toBe(true)
    expect(isStepUpAct('read-the-canvas')).toBe(false)
    expect(isStepUpAct(undefined)).toBe(false)
  })
})

/* ── an authorisation is for one act, once ─────────────────────────────────── */

describe('what a climbed rung is worth', () => {
  const open = (pendings: PendingSignIns) =>
    pendings.open({
      username: 'drej',
      device: null,
      deviceName: 'drej',
      kind: 'account',
      address: '127.0.0.1',
      next: ['totp'],
      act: 'mint-join-code'
    })

  it('is worth nothing until a rung is actually climbed', () => {
    const pendings = new PendingSignIns()
    const pending = open(pendings)
    expect(pendings.spendAuthorised('drej', 'mint-join-code', pending.id)).toBe(false)
  })

  it('is spendable exactly once', () => {
    const pendings = new PendingSignIns()
    const pending = open(pendings)
    expect(pendings.authorise(pending.id)).toBe(true)
    expect(pendings.spendAuthorised('drej', 'mint-join-code', pending.id)).toBe(true)
    // Spending closes it, so a proof cannot be replayed into a second act.
    expect(pendings.spendAuthorised('drej', 'mint-join-code', pending.id)).toBe(false)
  })

  it('IS FOR THE ACT IT WAS OPENED FOR, and no other', () => {
    // Proving who you are to add a machine must not be, quietly, permission to
    // take somebody's device away.
    const pendings = new PendingSignIns()
    const pending = open(pendings)
    pendings.authorise(pending.id)
    expect(pendings.spendAuthorised('drej', 'revoke-device', pending.id)).toBe(false)
    expect(pendings.spendAuthorised('somebody-else', 'mint-join-code', pending.id)).toBe(false)
  })

  it('refuses to authorise a SIGN-IN pending — a session is not permission', () => {
    const pendings = new PendingSignIns()
    const signIn = pendings.open({
      username: 'drej',
      device: { id: 'x' },
      deviceName: 'Chrome',
      kind: 'browser',
      address: '127.0.0.1',
      next: ['totp']
    })
    expect(pendings.authorise(signIn.id)).toBe(false)
  })
})

/* ── the gate, over the wire ───────────────────────────────────────────────── */

describe('minting a join code on an account that holds a factor', () => {
  it('ASKS ON THE LADDER, not for the password — the password is the weaker of the two', async () => {
    const owner = await claim()
    await addTotp(owner.token)

    const asked = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
    expect(asked.status).toBe(401)
    const out = await bodyOf<{
      error: string
      message: string
      act: string
      next: string[]
      pending: string
      expiresAt: number
      match: string
    }>(asked)
    expect(out.error).toBe('step_up')
    expect(out.act).toBe('mint-join-code')
    expect(out.message).toContain('adding a machine')
    // The ladder's shape, so both clients climb it with the code they already
    // have — including the number, because the approve rung is on this ladder
    // too and nagging works just as well when the prize is a join code.
    expect(out.next).toContain('totp')
    expect(out.pending).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.match).toMatch(/^[1-9][0-9]$/)
    expect(out.expiresAt).toBeGreaterThan(Date.now())
  })

  it('a rung PROVES and mints nothing, and the retry gets the code', async () => {
    const owner = await claim()
    const secret = await addTotp(owner.token)
    const asked = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    const { pending } = await bodyOf<{ pending: string }>(asked)

    // 204, and no session: the caller is already signed in, so minting them a
    // second one would be a strange prize for proving who they are.
    const rung = await call('POST', `/v2/sessions/${pending}/totp`, { code: codeFor(secret) })
    expect(rung.status).toBe(204)
    expect(rung.headers.get('set-cookie')).toBeNull()

    const got = await call('POST', '/v2/me/join-codes', { stepUp: pending }, bearer(owner.token))
    expect(got.status).toBe(201)
    expect((await bodyOf<{ code: string }>(got)).code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })

  it('the proof is spent — a second mint asks again', async () => {
    const owner = await claim()
    const secret = await addTotp(owner.token)
    const { pending } = await bodyOf<{ pending: string }>(
      await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    )
    expect((await call('POST', `/v2/sessions/${pending}/totp`, { code: codeFor(secret) })).status).toBe(204)
    expect((await call('POST', '/v2/me/join-codes', { stepUp: pending }, bearer(owner.token))).status).toBe(201)

    const again = await call('POST', '/v2/me/join-codes', { stepUp: pending }, bearer(owner.token))
    expect(again.status).toBe(401)
    expect((await bodyOf<{ error: string }>(again)).error).toBe('step_up')
  })

  it('a wrong code on the rung leaves the act unauthorised', async () => {
    const owner = await claim()
    await addTotp(owner.token)
    const { pending } = await bodyOf<{ pending: string }>(
      await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    )
    expect((await call('POST', `/v2/sessions/${pending}/totp`, { code: '000000' })).status).toBe(401)
    expect((await call('POST', '/v2/me/join-codes', { stepUp: pending }, bearer(owner.token))).status).toBe(401)
  })
})

describe('minting on an account with no factor', () => {
  it('still asks for the password inline — the ladder would have no rung to offer', async () => {
    const owner = await claim()
    const bare = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    expect(bare.status).toBe(403)
    expect((await bodyOf<{ error: string }>(bare)).error).toBe('password_required')
    expect((await call('POST', '/v2/me/join-codes', { current: 'wrong' }, bearer(owner.token))).status).toBe(401)
    expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status).toBe(201)
  })
})
