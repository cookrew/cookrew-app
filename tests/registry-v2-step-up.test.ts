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
async function claim(): Promise<{ username: string; token: string; deviceId: string }> {
  const username = `stepper${++minted}`
  const one = device()
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: one })
  expect(res.status).toBe(201)
  return {
    username,
    token: (await bodyOf<{ session: { token: string } }>(res)).session.token,
    deviceId: one.id
  }
}

/**
 * A SECOND MAC ON THE ACCOUNT — by join code, and BEFORE any factor exists.
 *
 * Order matters: once the account holds a factor, minting a code is itself a
 * step-up, and a helper that had to climb the ladder to set up a test about
 * the ladder would be testing itself.
 */
async function secondDevice(owner: { token: string }): Promise<{ token: string; deviceId: string }> {
  const minting = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
  expect(minting.status).toBe(201)
  const { code } = await bodyOf<{ code: string }>(minting)
  const two = device('Mac Studio')
  const joined = await call('POST', '/v2/join', { code, device: two })
  expect(joined.status).toBe(201)
  return { token: (await bodyOf<{ token: string }>(joined)).token, deviceId: two.id }
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
      match?: string
    }>(asked)
    expect(out.error).toBe('step_up')
    expect(out.act).toBe('mint-join-code')
    expect(out.message).toContain('adding a machine')
    // The ladder's shape, so both clients climb it with the code they already
    // have.
    expect(out.next).toContain('totp')
    expect(out.pending).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.expiresAt).toBeGreaterThan(Date.now())
    /**
     * AND NOT THE NUMBER — this assertion used to require it (C1).
     *
     * The reasoning it carried was a sign-in's: "the approve rung is on this
     * ladder too, and nagging works just as well when the prize is a join
     * code". Both halves were false here. This account has one device, so
     * there is nobody else to nag — and the caller being handed the digits is
     * the caller that would have typed them back. The rung is not offered and
     * the number does not travel; the two-device case is proven in the C1
     * block below, where both come back because a second screen exists.
     */
    expect(out.next).not.toContain('approve')
    expect(out.match).toBeUndefined()
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

/* ── C1 · the threshold must not be crossable by the session it stops ─────── */

/**
 * THE ATTACK, AS THE REVIEW RAN IT.
 *
 * The commit that built this gate says it in one line: "a stolen session is a
 * month of quiet access, so the password becomes a threshold". A threshold one
 * session can step over alone is not a threshold — it is a form.
 *
 * Three things had to be true at once for it to be crossable, and each of them
 * looked right on its own:
 *
 *   `factorsFor` offers `approve` whenever the account has ANY device, which is
 *     correct for a SIGN-IN, where the asking device is not attached yet and so
 *     cannot possibly answer;
 *   the 401 hands the asker the two digits, which is correct for a SIGN-IN,
 *     where the digits exist to be read off the asking screen and typed on
 *     another one;
 *   `answerApproval` never checks WHO answered, which is invisible for a
 *     SIGN-IN, because the only sessions that could answer belong to devices
 *     already on the account.
 *
 * For a step-up every one of those premises is inverted: the asker IS attached,
 * the asker holds a session, and the asker is handed the number. So the same
 * ladder that is sound at the front door is self-answering behind it.
 */
describe('C1 · crossing your own threshold', () => {
  it('ONE DEVICE CANNOT APPROVE ITS OWN STEP-UP — the whole attack, end to end', async () => {
    // Everything a thief has: one session bearer on an account that holds a
    // factor. No password, no second device, no access to any screen.
    const stolen = await claim()
    await addTotp(stolen.token)

    // 1 · ask for the thing the threshold protects.
    const asked = await call('POST', '/v2/me/join-codes', {}, bearer(stolen.token))
    expect(asked.status).toBe(401)
    const refusal = await bodyOf<{ error: string; next: string[]; pending: string; match?: string }>(asked)
    expect(refusal.error).toBe('step_up')

    // The rung a lone device could answer is NOT OFFERED. With one device on
    // the account, "ask my other device" has no other device to ask.
    expect(refusal.next).not.toContain('approve')
    // And the digits do not travel to a caller that could answer them. They
    // exist for the approve rung; no rung, no number.
    expect(refusal.match).toBeUndefined()

    // 2 · ask the account's own devices anyway — the rung is closed.
    const ringing = await call('POST', `/v2/sessions/${refusal.pending}/approve`, {})
    expect(ringing.status).toBe(400)

    // 3 · and even holding an approval id, answering with the asking session is
    // refused. Belt and braces on purpose: the two halves of this fix guard
    // each other, and a future ladder change must trip one of them.
    const approvals = await bodyOf<readonly { id: string }[]>(
      await call('GET', '/v2/me/approvals', undefined, bearer(stolen.token))
    )
    expect(approvals).toHaveLength(0)

    // 4 · nothing was authorised, so the act is still refused.
    expect((await call('GET', `/v2/sessions/${refusal.pending}`, undefined)).status).toBe(202)
    const again = await call('POST', '/v2/me/join-codes', { stepUp: refusal.pending }, bearer(stolen.token))
    expect(again.status).toBe(401)
    // No join code was minted. A code attaches a machine permanently, which is
    // the prize this whole ceremony exists to stand in front of.
    expect(await again.text()).not.toMatch(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)
  })

  it('TWO DEVICES: the rung comes back, and the asker still cannot answer it', async () => {
    // With a real second screen, "ask my other device" is a real factor again —
    // and it must be answerable only from the other one.
    const owner = await claim()
    const other = await secondDevice(owner)
    await addTotp(owner.token)

    const asked = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    expect(asked.status).toBe(401)
    const refusal = await bodyOf<{ next: string[]; pending: string; match: string }>(asked)
    expect(refusal.next).toContain('approve')
    // The number rides again, because there is now a second screen to type it on.
    expect(refusal.match).toMatch(/^[1-9][0-9]$/)

    const ringing = await call('POST', `/v2/sessions/${refusal.pending}/approve`, {})
    expect(ringing.status).toBe(202)
    const { approval } = await bodyOf<{ approval: string }>(ringing)

    // THE ASKING SESSION, with the right number, is refused.
    const itself = await call(
      'POST',
      `/v2/me/approvals/${approval}`,
      { decision: 'approve', match: refusal.match },
      bearer(owner.token)
    )
    expect(itself.status).toBe(403)
    // And it is not counted as a wrong number — the owner's three tries are
    // not spent by a client that answered from the wrong place.
    expect(await itself.text()).not.toContain('triesLeft')

    // THE OTHER DEVICE, same number, is taken.
    const elsewhere = await call(
      'POST',
      `/v2/me/approvals/${approval}`,
      { decision: 'approve', match: refusal.match },
      bearer(other.token)
    )
    expect(elsewhere.status).toBe(204)
    expect((await call('GET', `/v2/sessions/${refusal.pending}`, undefined)).status).toBe(204)
    expect(
      (await call('POST', '/v2/me/join-codes', { stepUp: refusal.pending }, bearer(owner.token))).status
    ).toBe(201)
  })

  it('leaves the SIGN-IN ladder exactly as it was — the asker there is not attached', async () => {
    // The ceremony at the front door was never broken: a device that has not
    // been attached holds no session, so it can neither reach the approvals
    // route nor be the session that answers. Pinned so a fix aimed at step-up
    // cannot quietly narrow the ladder a new Mac has to climb.
    const owner = await claim()
    await addTotp(owner.token)
    const stranger = device('Mac mini')
    const signing = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: stranger
    })
    expect(signing.status).toBe(401)
    const ladder = await bodyOf<{ next: string[]; pending: string; match: string }>(signing)
    expect(ladder.next).toContain('approve')
    expect(ladder.match).toMatch(/^[1-9][0-9]$/)
    // And the account's own device answers it, as it always could.
    const ringing = await call('POST', `/v2/sessions/${ladder.pending}/approve`, {})
    expect(ringing.status).toBe(202)
    const { approval } = await bodyOf<{ approval: string }>(ringing)
    expect(
      (
        await call(
          'POST',
          `/v2/me/approvals/${approval}`,
          { decision: 'approve', match: ladder.match },
          bearer(owner.token)
        )
      ).status
    ).toBe(204)
  })
})
