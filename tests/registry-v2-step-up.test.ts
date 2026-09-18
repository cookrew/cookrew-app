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
import { STEP_UP_ACTS, STEP_UP_ENFORCEMENT, isStepUpAct } from '../src/shared/step-up'

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
  it('OFFERS THE LADDER when the caller brings nothing — and still takes a password', async () => {
    const owner = await claim()
    await addTotp(owner.token)

    const asked = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
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

    /**
     * AND THE PASSWORD IS STILL PROOF — this assertion used to require a 401.
     *
     * V3-16 took the password only from accounts with no factor: "asking for
     * the password would be asking for the weaker of the two". That is an
     * argument about preference. The threat here is a stolen session, and the
     * password is exactly what the holder of one does not have — while the
     * one case where that stops being true, somebody else knowing it, is the
     * not-me alarm, which closes this door above. Rung-only was also not
     * reachable: no client can climb a step-up, so it made the act impossible
     * for any account holding so much as a sheet of rescue codes. The full
     * reasoning, and the case it gives up, are in v2-step-up.ts.
     */
    expect(
      (await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status
    ).toBe(201)
    // A wrong one is a wrong password, not an invitation to climb instead.
    expect(
      (await call('POST', '/v2/me/join-codes', { current: 'not it' }, bearer(owner.token))).status
    ).toBe(401)
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
    //
    // THE EXACT KEY, not a pattern over the whole body: a shape like
    // XXXX-XXXX also describes two groups of a uuid's digits, so the needle
    // would have flaked against the pending id it is printed beside.
    expect(await bodyOf<{ code?: string }>(again)).not.toHaveProperty('code')
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

/* ── H3 · the alarm closes this door too ─────────────────────────────────── */

/**
 * "NOT ME" IS THE LOUDEST THING A PERSON CAN SAY ABOUT THIS ACCOUNT.
 *
 * It means: a stranger has my password. Every other sitting ends, every pending
 * sign-in is dropped, the queue is emptied, and the password is locked out
 * until it is changed. Sign-in honours it, the rung honours it, join-redeem
 * honours it, recovery honours it — and the gate built so that seven copies of
 * a boundary could not drift was the copy that drifted.
 *
 * It belongs INSIDE the gate rather than at each call site, for the reason the
 * gate exists: an act wired in tomorrow inherits the alarm without anyone
 * remembering to add it.
 */

/** Raise the alarm the way a person does: disown a real sign-in request. */
async function raiseAlarm(owner: { username: string; token: string }): Promise<void> {
  const signing = await call('POST', '/v2/sessions', {
    username: owner.username,
    password: PASSWORD,
    device: device('A stranger’s Mac')
  })
  expect(signing.status).toBe(401)
  const { pending } = await bodyOf<{ pending: string }>(signing)
  const ringing = await call('POST', `/v2/sessions/${pending}/approve`, {})
  expect(ringing.status).toBe(202)
  const { approval } = await bodyOf<{ approval: string }>(ringing)
  // The password rides along: "not me" is on the step-up list, so raising the
  // alarm is itself an act that asks who you are (H4).
  const alarm = await call(
    'POST',
    `/v2/me/approvals/${approval}`,
    { decision: 'not-me', current: PASSWORD },
    bearer(owner.token)
  )
  expect(alarm.status).toBe(204)
}

describe('H3 · the step-up gate and the not-me alarm', () => {
  it('REFUSES THE PASSWORD PATH once the alarm is raised', async () => {
    // The password is exactly what the owner said a stranger has. Taking it as
    // proof afterwards is taking the stranger's word for who they are.
    const owner = await claim()
    expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status).toBe(201)

    await raiseAlarm(owner)

    const after = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
    expect(after.status).toBe(403)
    expect((await bodyOf<{ error: string }>(after)).error).toBe('password_change_required')
  })

  it('REFUSES THE LADDER PATH too — the alarm is about the account, not one proof', async () => {
    // The alarm first, then the factor: raising it is itself a step-up act, and
    // a helper that had to climb a ladder to set up a test about the ladder
    // would be testing itself.
    const owner = await claim()
    await raiseAlarm(owner)
    await addTotp(owner.token)
    const after = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    expect(after.status).toBe(403)
    const said = await after.text()
    expect(JSON.parse(said).error).toBe('password_change_required')
    // And no pending was opened for a ladder nobody may climb.
    expect(said).not.toContain('pending')
  })

  it('does not strand the owner — changing the password opens it again', async () => {
    // The way out has to stay outside this gate, or the alarm would lock the
    // account out of the one act that clears it. POST /v2/me/password asks for
    // the current password on its own and is deliberately not behind step-up.
    const owner = await claim()
    await raiseAlarm(owner)
    expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status).toBe(403)

    const changed = await call(
      'POST',
      '/v2/me/password',
      { current: PASSWORD, next: 'a different long password' },
      bearer(owner.token)
    )
    expect(changed.status).toBe(204)
    expect(
      (await call('POST', '/v2/me/join-codes', { current: 'a different long password' }, bearer(owner.token))).status
    ).toBe(201)
  })

  it('and the redeem side of the same rule holds — its sibling, untested until now', async () => {
    // H8: v2-join.ts's alarm check was asserted in a commit message and
    // exercised by nothing. An untested pair is how one of them breaks, which
    // is exactly what happened to the mint side above.
    const owner = await claim()
    const { code } = await bodyOf<{ code: string }>(
      await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
    )
    await raiseAlarm(owner)
    const joining = await call('POST', '/v2/join', { code, device: device('Mac mini') })
    expect(joining.status).toBe(403)
    expect((await bodyOf<{ error: string }>(joining)).error).toBe('password_change_required')
  })
})

/* ── H4 · the list must not claim what the code does not give ────────────── */

/**
 * SEVEN ACTS WERE DECLARED AND ONE WAS GUARDED.
 *
 * `src/shared/step-up.ts` names the acts that ask again, and the commit that
 * added it says "the registry enforces it". It enforced one. The two a thief
 * most wants were bearer-only: revoking somebody else's device, and pressing
 * the alarm that signs every other device out and locks the password.
 *
 * A shared constant claiming a guarantee the code does not give is worse than
 * no constant, because it is the thing the next reader trusts instead of
 * reading the routes. So the acts are wired, and the ones that are enforced
 * some other way say which way — and this block drives every one of them over
 * HTTP, so the map cannot drift from the routes without going red.
 */
describe('H4 · every act the list names', () => {
  it('REVOKE-DEVICE is not a bearer-only act', async () => {
    const owner = await claim()
    const other = await secondDevice(owner)

    // A bearer alone used to be enough to detach somebody else's machine.
    const bare = await call('DELETE', `/v2/me/devices/${other.deviceId}`, undefined, bearer(owner.token))
    expect(bare.status).toBe(403)
    expect((await bodyOf<{ error: string }>(bare)).error).toBe('password_required')
    // The device is still on the account.
    const still = await bodyOf<{ devices: readonly { id: string }[] }>(
      await call('GET', '/v2/me', undefined, bearer(owner.token))
    )
    expect(still.devices.map((d) => d.id)).toContain(other.deviceId)

    // A wrong password is refused, and the right one goes through.
    expect(
      (await call('DELETE', `/v2/me/devices/${other.deviceId}`, { current: 'not it' }, bearer(owner.token))).status
    ).toBe(401)
    expect(
      (await call('DELETE', `/v2/me/devices/${other.deviceId}`, { current: PASSWORD }, bearer(owner.token))).status
    ).toBe(204)
  })

  it('NOT-ME is not a bearer-only act — the alarm is a thief’s denial of service', async () => {
    // Pressing it signs every other device out and locks the password until it
    // changes. Held by a stranger's session that is what it does to the owner.
    const owner = await claim()
    const signing = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: device('A stranger’s Mac')
    })
    const { pending } = await bodyOf<{ pending: string }>(signing)
    const { approval } = await bodyOf<{ approval: string }>(
      await call('POST', `/v2/sessions/${pending}/approve`, {})
    )

    const bare = await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me' }, bearer(owner.token))
    expect(bare.status).toBe(403)
    expect((await bodyOf<{ error: string }>(bare)).error).toBe('password_required')
    // Nothing happened: the password is not locked and the session still works.
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(200)
    expect(
      (await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status
    ).toBe(201)

    // With the password it is one more field, not one more screen.
    expect(
      (
        await call(
          'POST',
          `/v2/me/approvals/${approval}`,
          { decision: 'not-me', current: PASSWORD },
          bearer(owner.token)
        )
      ).status
    ).toBe(204)
  })

  it('APPROVE and DENY stay one tap — an alarm harder to raise than a mistake', async () => {
    // Only the alarm is on the list. Making the two ordinary answers ask for a
    // password would be asking for one on every sign-in the owner approves.
    const owner = await claim()
    const signing = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: device('Mac mini')
    })
    const ladder = await bodyOf<{ pending: string; match: string }>(signing)
    const { approval } = await bodyOf<{ approval: string }>(
      await call('POST', `/v2/sessions/${ladder.pending}/approve`, {})
    )
    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'deny' }, bearer(owner.token))).status
    ).toBe(204)
  })

  it('REMOVE-FACTOR honours the alarm — a stranger must not weaken what is left', async () => {
    // It asks for the password on its own route, which is a step-up in
    // substance. What it did not do was hear the alarm: with the password
    // disowned, a stranger could take the owner's authenticator off and leave
    // the password they hold as the only thing between them and the account.
    // Alarm first, factor second — for the same reason as the H3 ladder test:
    // pressing NOT ME is itself a step-up act now, so an account that already
    // held a factor would have to climb it to set this up.
    const owner = await claim()
    await raiseAlarm(owner)
    const secret = await addTotp(owner.token)
    expect(secret.length).toBeGreaterThan(0)
    const removing = await call('DELETE', '/v2/me/totp', { current: PASSWORD }, bearer(owner.token))
    expect(removing.status).toBe(403)
    expect((await bodyOf<{ error: string }>(removing)).error).toBe('password_change_required')
  })
})

/**
 * THE MAP AND THE ROUTES, HELD TOGETHER.
 *
 * `STEP_UP_ENFORCEMENT` is a promise about seven routes, and a promise in a
 * shared constant is the thing the next reader trusts instead of reading them.
 * So every act it calls `gate` or `password` is driven here with a bearer and
 * nothing else, and every one of them has to refuse.
 */
describe('H4 · the enforcement map is not a claim, it is a test', () => {
  it('covers every act, with no act enforced by hope', () => {
    expect(Object.keys(STEP_UP_ENFORCEMENT).sort()).toEqual([...STEP_UP_ACTS].sort())
    // Exactly one act has no registry route in this cut, and it is named.
    expect(STEP_UP_ACTS.filter((act) => STEP_UP_ENFORCEMENT[act] === 'none')).toEqual(['take-over-door'])
  })

  it('every gated and password-guarded act refuses a bearer on its own', async () => {
    const owner = await claim()
    const other = await secondDevice(owner)
    const signing = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: PASSWORD,
      device: device('Mac mini')
    })
    const { pending } = await bodyOf<{ pending: string }>(signing)
    const { approval } = await bodyOf<{ approval: string }>(
      await call('POST', `/v2/sessions/${pending}/approve`, {})
    )

    /** The route each act happens at, with nothing but the session on it. */
    const bareCall: Record<string, () => Promise<Response>> = {
      'change-password': () => call('POST', '/v2/me/password', {}, bearer(owner.token)),
      'remove-factor': () => call('DELETE', '/v2/me/totp', {}, bearer(owner.token)),
      'revoke-device': () => call('DELETE', `/v2/me/devices/${other.deviceId}`, undefined, bearer(owner.token)),
      'mint-join-code': () => call('POST', '/v2/me/join-codes', {}, bearer(owner.token)),
      'end-seat': () =>
        call('DELETE', `/v2/teams/@${owner.username}/alpha/seats/${randomUUID()}`, undefined, bearer(owner.token)),
      'not-me': () => call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me' }, bearer(owner.token))
    }

    for (const act of STEP_UP_ACTS) {
      if (STEP_UP_ENFORCEMENT[act] === 'none') continue
      const res = await bareCall[act]()
      // NEVER a success. Which refusal differs by act — a missing password is
      // 403, a seat at a team nobody serves is a 404 before the gate is even
      // reached — but a bearer alone must never be enough to do the thing.
      expect(res.status, `${act} answered ${res.status} to a bearer alone`).toBeGreaterThanOrEqual(400)
      expect(res.status, act).toBeLessThan(500)
    }
    // And the account is untouched: still two devices, no alarm raised.
    const after = await bodyOf<{ devices: readonly { id: string }[]; factors: { mustChangePassword: boolean } }>(
      await call('GET', '/v2/me', undefined, bearer(owner.token))
    )
    expect(after.devices).toHaveLength(2)
    expect(after.factors.mustChangePassword).toBe(false)
  })
})
