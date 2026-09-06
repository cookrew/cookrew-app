// THE SECOND-FACTOR LADDER, ON THE DESKTOP.
//
// The live bug: the owner's session ended, they typed the right password, and
// cookrew.dev answered 401 second_factor because the account has an
// authenticator. The card printed "One more step. Prove it is you." and
// offered no step — so the only Mac on the account had no relay line, no
// reach and no door, and no way back.
//
// These are main's half. A REAL http server stands in for the registry (no
// injected fetch) so the request line, the method and the JSON are all
// exercised; nothing here touches a real ~/.cookrew and no password or token
// value is ever asserted on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Accounts, loadAccount, writeAccount } from '../src/main/account-v2'
import { LadderPasswords, stepFrom } from '../src/main/account-ladder'
import { fakeAccount, tempBase } from './support/idv2'

const PASSWORD = 'the-new-passphrase'
const OLD_PASSWORD = 'correct horse battery staple'
const PENDING = '11111111-2222-4333-8444-555555555555'

/** One scripted answer, and what the server was asked to produce it. */
interface Reply {
  status: number
  body?: unknown
}

let server: Server
let origin = ''
let asked: { method: string; url: string; body: string }[] = []
/** path → the answers it gives, in order; the last one repeats. */
let script = new Map<string, Reply[]>()

const answer = (path: string, ...replies: Reply[]): void => void script.set(path, replies)

beforeEach(async () => {
  asked = []
  script = new Map()
  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      const url = request.url ?? ''
      asked.push({ method: request.method ?? '', url, body: raw })
      const queued = script.get(`${request.method} ${url}`) ?? []
      const reply = queued.length > 1 ? (queued.shift() as Reply) : queued[0]
      if (!reply) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not_found"}')
        return
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  for (const clean of cleanups.splice(0)) clean()
})

const cleanups: (() => void)[] = []

/** A Mac with an account whose session cookrew.dev has already refused. */
function signedOut(): string {
  const { base, clean } = tempBase()
  cleanups.push(clean)
  writeAccount(
    fakeAccount({
      registry: origin,
      session: { token: 'session-token', exp: Date.now() + 3_600_000, endedAt: Date.now() },
    }),
    base,
  )
  return base
}

const app = (base: string): Accounts => new Accounts({ base, origin })

const LIVE = { status: 201, body: { token: 'fresh-token', exp: Date.now() + 3_600_000 } }
const SECOND_FACTOR = {
  status: 401,
  body: {
    error: 'second_factor',
    message: 'One more step. Prove it is you.',
    next: ['totp', 'approve', 'recovery'],
    pending: PENDING,
    expiresAt: Date.now() + 600_000,
  },
}

/** Walk to the rung: password in, step out. */
async function atTheStep(base = signedOut()): Promise<{ base: string; it: Accounts }> {
  answer('POST /v2/sessions', SECOND_FACTOR)
  const it = app(base)
  const step = await it.resume(PASSWORD)
  expect(step).toMatchObject({ ok: false, reason: 'second_factor' })
  return { base, it }
}

describe('resume answers the ladder, not a dead end', () => {
  it('carries the pending id and the rungs the account can finish on', async () => {
    answer('POST /v2/sessions', SECOND_FACTOR)
    const out = await app(signedOut()).resume(PASSWORD)
    expect(out.ok).toBe(false)
    if (out.ok || out.reason !== 'second_factor') throw new Error('expected a step')
    expect(out.step.pending).toBe(PENDING)
    expect(out.step.next).toEqual(['totp', 'approve', 'recovery'])
    // The registry's own sentence is carried, not re-worded.
    expect(out.message).toBe('One more step. Prove it is you.')
  })

  it('drops a rung this app has never heard of rather than drawing it', async () => {
    // A registry newer than this build must not put a button on the card that
    // nothing behind it can climb.
    const step = stepFrom({ pending: PENDING, next: ['totp', 'sudo'], expiresAt: 1 })
    expect(step?.next).toEqual(['totp'])
    expect(stepFrom({ pending: PENDING, next: ['sudo'] })).toBeNull()
    expect(stepFrom({ next: ['totp'] })).toBeNull()
  })

  it('still finishes on the password alone when the account has no factors', async () => {
    answer('POST /v2/sessions', LIVE)
    const base = signedOut()
    const it = app(base)
    expect(await it.resume(PASSWORD)).toMatchObject({ ok: true })
    expect(it.sessionLive()).toBe(true)
    expect(loadAccount(base)?.session?.endedAt).toBeUndefined()
  })

  it('still blames the password when the password is what was wrong', async () => {
    answer('POST /v2/sessions', { status: 401, body: { error: 'bad_credentials' } })
    expect(await app(signedOut()).resume('not-it-at-all')).toMatchObject({
      ok: false,
      reason: 'session-expired',
    })
  })
})

describe('the typed rungs: six digits, or a rescue code', () => {
  it('sends the code to the pending and lands the session', async () => {
    const { base, it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/totp`, LIVE)
    expect(await it.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({ ok: true })
    expect(it.sessionLive()).toBe(true)
    const sent = asked[asked.length - 1]
    expect(sent.method).toBe('POST')
    expect(JSON.parse(sent.body)).toEqual({ code: '123456' })
    expect(loadAccount(base)?.session?.endedAt).toBeUndefined()
  })

  it('RE-DERIVES the unlock verifier from the password held across the ladder', async () => {
    // The half that made the bug unrecoverable, now on the far side of a
    // second factor: the password went in at the password step and the
    // session lands three requests later. The verifier still has to move.
    const { it } = await atTheStep()
    expect(it.verifyUnlock(PASSWORD)).toBe(false)
    answer(`POST /v2/sessions/${PENDING}/totp`, LIVE)
    await it.resumeWithCode(PENDING, 'totp', '123456')
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
    expect(it.verifyUnlock(OLD_PASSWORD)).toBe(false)
  })

  it('keeps the ladder open on a wrong code — there are five tries', async () => {
    const { it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/totp`, {
      status: 401,
      body: { error: 'bad_code', message: 'That is not the code showing right now.' },
    })
    const wrong = await it.resumeWithCode(PENDING, 'totp', '000000')
    expect(wrong).toMatchObject({ ok: false, reason: 'bad_code' })
    // And the SAME pending still works: the password was not thrown away.
    answer(`POST /v2/sessions/${PENDING}/totp`, LIVE)
    expect(await it.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({ ok: true })
  })

  it('names a rescue code refused as itself, not as a wrong password', async () => {
    const { it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/recovery`, {
      status: 401,
      body: { error: 'bad_recovery', message: 'That is not one of your recovery codes.' },
    })
    expect(await it.resumeWithCode(PENDING, 'recovery', 'AAAA-BBBB')).toMatchObject({
      ok: false,
      reason: 'bad_recovery',
    })
  })

  it('ENDS the ladder when the pending went cold, and forgets the password with it', async () => {
    const { it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/totp`, {
      status: 410,
      body: { error: 'expired', message: 'That sign-in took too long, so it was dropped.' },
    })
    expect(await it.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({
      ok: false,
      reason: 'expired',
    })
    // A second try does not even reach the socket: with no password for this
    // pending there is nothing that could re-derive the verifier.
    const before = asked.length
    expect(await it.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({
      ok: false,
      reason: 'expired',
    })
    expect(asked).toHaveLength(before)
  })

  it('refuses a rung for a pending it never opened', async () => {
    const it = app(signedOut())
    expect(await it.resumeWithCode(PENDING, 'totp', '123456')).toMatchObject({
      ok: false,
      reason: 'expired',
    })
    expect(asked).toHaveLength(0)
  })
})

describe('the approve rung: ask, then wait', () => {
  const ASKED = {
    status: 202,
    body: {
      approval: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expiresAt: Date.now() + 600_000,
      sentence: 'A device calling itself “MacBook Pro”, at 127.0.0.1, wants to sign in as @drej.',
    },
  }

  it('asks once and carries the registry’s own sentence back', async () => {
    const { it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/approve`, ASKED)
    const out = await it.resumeAsk(PENDING)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.value.sentence).toContain('wants to sign in as @drej')
  })

  it('polls until the other device says yes, then lands the session', async () => {
    const { it } = await atTheStep()
    answer(
      `GET /v2/sessions/${PENDING}`,
      { status: 202, body: { status: 'waiting' } },
      { status: 202, body: { status: 'waiting' } },
      LIVE,
    )
    expect(await it.resumeWait(PENDING, { everyMs: 5 })).toMatchObject({ ok: true })
    expect(it.sessionLive()).toBe(true)
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
    expect(asked.filter((a) => a.method === 'GET')).toHaveLength(3)
  })

  it('stops on a denial rather than polling a request that is answered', async () => {
    const { it } = await atTheStep()
    answer(`GET /v2/sessions/${PENDING}`, {
      status: 410,
      body: { error: 'denied', message: 'That sign-in was denied on your other device.' },
    })
    expect(await it.resumeWait(PENDING, { everyMs: 5 })).toMatchObject({
      ok: false,
      reason: 'denied',
    })
  })

  it('is BOUNDED — a card nobody came back to does not poll forever', async () => {
    const { it } = await atTheStep()
    answer(`GET /v2/sessions/${PENDING}`, { status: 202, body: { status: 'waiting' } })
    expect(await it.resumeWait(PENDING, { everyMs: 5, forMs: 40 })).toMatchObject({
      ok: false,
      reason: 'expired',
    })
    // A handful of polls, not a thousand.
    expect(asked.filter((a) => a.method === 'GET').length).toBeLessThan(20)
  })
})

describe('the password is held for the ladder and no longer', () => {
  it('is dropped the moment the ladder ends, whichever way it ended', async () => {
    const { it } = await atTheStep()
    answer(`POST /v2/sessions/${PENDING}/totp`, LIVE)
    await it.resumeWithCode(PENDING, 'totp', '123456')
    // Nothing left to climb with: the session is live and the pending is spent.
    expect(await it.resumeAsk(PENDING)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('expires on its own after the pending’s own ten minutes', () => {
    let clock = 1_000
    const held = new LadderPasswords(() => clock, 600_000)
    held.remember(PENDING, PASSWORD)
    expect(held.for(PENDING)).toBe(PASSWORD)
    clock += 599_000
    expect(held.for(PENDING)).toBe(PASSWORD)
    clock += 2_000
    expect(held.for(PENDING)).toBeNull()
    expect(held.size).toBe(0)
  })

  it('is bounded in number, so nothing can grow it without limit', () => {
    const held = new LadderPasswords()
    for (let n = 0; n < 40; n += 1) held.remember(`pending-${n}`, PASSWORD)
    expect(held.size).toBeLessThanOrEqual(8)
    // The newest survive; the oldest ladders are the ones nearest their expiry.
    expect(held.for('pending-39')).toBe(PASSWORD)
    expect(held.for('pending-0')).toBeNull()
  })
})
