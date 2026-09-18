// JOIN BY A CODE (v3, D8 · D12) — the app half, end to end.
//
// The rule underneath every assertion is the security model's third line: a
// password alone never attaches a device. A machine joins with a code minted
// where trust already is, types nothing else, and meets the password for the
// first time at its own first lock — at which point cookrew.dev, not this
// Mac, is the thing that says whether it is right.
//
// Three parts. A scripted socket walks every way the wire can answer, because
// THE FILE IS WRITTEN ONLY ON 201 and the other rows are what prove it. The
// REAL registry then walks e2e steps 2 and 3: a code minted on Mac A, spent
// on Mac B, and B's first lock writing the verifier it did not have. Last,
// the deep link — parsed, and delivered to the card that spends it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { Accounts, DEFAULT_LOCK_AFTER_MS, loadAccount, writeAccount } from '../src/main/account-v2'
import { accountHandlers, type AccountIpcDeps } from '../src/main/account-ipc'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { IdleLock } from '../src/main/lock'
import { parseDeepLink } from '../src/main/deep-link'
import { normaliseJoinCode } from '../src/shared/join-code'
import { joinRefusalSentence, ACCOUNT_COPY, lockNote } from '../src/renderer/src/account/account-store'
import { onJoinRequest, requestJoin } from '../src/renderer/src/account/open-request'
import { fakeAccount, tempBase } from './support/idv2'

const PASSWORD = 'correct horse battery staple'
const CODE = '7KQ4-M2XB'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

const accountFile = (base: string): string => path.join(base, 'account.json')

/** A Mac with nothing on it. */
function emptyMac(): string {
  const { base, clean } = tempBase()
  cleanups.push(clean)
  return base
}

/* ── the file is written only on 201 ───────────────────────────────────── */

describe('join against a scripted registry', () => {
  let asked: { url: string; body: string }[] = []

  /** An app whose socket answers exactly once, with whatever this row says. */
  const app = (base: string, reply: { status: number; body?: unknown }): Accounts => {
    asked = []
    return new Accounts({
      base,
      origin: 'https://registry.test',
      deviceName: 'Mac mini',
      fetch: async (input, init) => {
        asked.push({ url: input, body: String(init?.body ?? '') })
        return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
  }

  const LANDED = {
    status: 201,
    body: { token: 'a-session', exp: Date.now() + 3_600_000, deviceId: 'dev-b', username: 'drej' },
  }

  it('spends the code, files the account, and writes NO unlock verifier', async () => {
    const base = emptyMac()
    const it_ = app(base, LANDED)
    expect(await it_.join({ code: CODE })).toMatchObject({ ok: true })

    expect(asked).toHaveLength(1)
    expect(asked[0].url).toBe('https://registry.test/v2/join')
    const sent = JSON.parse(asked[0].body) as { code: string; device: Record<string, unknown> }
    expect(sent.code).toBe(CODE)
    // The device is offered whole — a key minted HERE, and its id derived
    // from that key, so the registry files something only this Mac can sign.
    expect(sent.device).toMatchObject({ kind: 'desktop', name: 'Mac mini' })
    expect(typeof sent.device.id).toBe('string')
    expect(sent.device.jwk).toBeDefined()
    // AND THE PASSWORD IS NOT ON THE WIRE, because there is none to send.
    expect(asked[0].body).not.toContain('password')

    const file = loadAccount(base)
    expect(file?.username).toBe('drej')
    expect(file?.deviceId).toBe('dev-b')
    // THE POINT OF THE WHOLE CEREMONY: no verifier, so nothing about the
    // password was guessed at on a machine that has never seen it.
    expect(file?.unlock).toBeNull()
    expect(it_.passwordPending()).toBe(true)
    expect(it_.verifyUnlock(PASSWORD)).toBe(false)
    expect(it_.sessionLive()).toBe(true)
  })

  it('writes nothing on any other answer, and says which refusal it was', async () => {
    const rows: { reply: { status: number; body?: unknown }; reason: string }[] = [
      { reply: { status: 401, body: { error: 'bad_credentials' } }, reason: 'bad_credentials' },
      { reply: { status: 429, body: { error: 'rate_limited' } }, reason: 'rate_limited' },
      { reply: { status: 400, body: { error: 'bad_device' } }, reason: 'bad_device' },
      {
        reply: { status: 403, body: { error: 'password_change_required' } },
        reason: 'password_change_required',
      },
      { reply: { status: 500, body: {} }, reason: 'unknown' },
      // A 201 that carries no session is not a join: there would be nothing
      // to be signed in WITH, and a file written for it would be an account
      // that cannot talk to the registry it claims to belong to.
      { reply: { status: 201, body: { deviceId: 'dev-b' } }, reason: 'unknown' },
    ]
    for (const row of rows) {
      const base = emptyMac()
      const out = await app(base, row.reply).join({ code: CODE })
      expect(out, JSON.stringify(row.reply)).toMatchObject({ ok: false, reason: row.reason })
      expect(existsSync(accountFile(base)), JSON.stringify(row.reply)).toBe(false)
    }
  })

  it('a registry that never answers is offline, and nothing is written', async () => {
    const base = emptyMac()
    const dead = new Accounts({ base, origin: 'http://127.0.0.1:1' })
    expect(await dead.join({ code: CODE })).toEqual({ ok: false, reason: 'offline' })
    expect(existsSync(accountFile(base))).toBe(false)
  })

  it('refuses on a Mac that is already somebody, without spending the code', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    writeAccount(fakeAccount({ registry: 'https://registry.test' }), base)
    const out = await app(base, LANDED).join({ code: CODE })
    expect(out).toMatchObject({ ok: false, reason: 'taken' })
    expect(asked).toHaveLength(0)
  })

  it('an empty code never reaches the wire', async () => {
    const out = await app(emptyMac(), LANDED).join({ code: '   ' })
    expect(out).toMatchObject({ ok: false, reason: 'bad_credentials' })
    expect(asked).toHaveLength(0)
  })
})

/* ── a spent code answers the sentence, not a status ───────────────────── */

describe('a code that is gone says what to do next', () => {
  it('names the next step, and never a number', () => {
    const said = joinRefusalSentence('bad_credentials')
    expect(said).toBe(ACCOUNT_COPY.JOIN_CODE_SPENT)
    expect(said).toContain('ADD A MAC')
    expect(said).not.toMatch(/40[0-9]|error|invalid/i)
    // The shared sentence for this reason is about a SESSION — a thing a Mac
    // joining for the first time has never had. That is the whole reason this
    // route reads the refusal for itself.
    expect(said).not.toBe(ACCOUNT_COPY.SESSION_ENDED)
  })

  it('leaves every other refusal to the house', () => {
    expect(joinRefusalSentence('rate_limited')).toContain('slow down')
    expect(joinRefusalSentence('offline')).toBe(ACCOUNT_COPY.REGISTRY_DOWN)
    expect(joinRefusalSentence('unknown', 'A sentence from cookrew.dev.')).toBe(
      'A sentence from cookrew.dev.',
    )
  })
})

/* ── the deep link, and the card it opens ──────────────────────────────── */

describe('cookrew://join#<code>', () => {
  it('is parsed into the code, forgiving the case and the dash', () => {
    expect(parseDeepLink('cookrew://join#7KQ4-M2XB')).toEqual({ verb: 'join', code: CODE })
    expect(parseDeepLink('cookrew://join#7kq4m2xb')).toEqual({ verb: 'join', code: CODE })
    expect(normaliseJoinCode(' 7kq4 m2xb ')).toBe(CODE)
  })

  it('refuses anything that is not exactly that shape', () => {
    for (const raw of [
      'cookrew://join', // no code at all
      'cookrew://join#', // an empty fragment
      'cookrew://join#NOTACODE!', // not the alphabet
      'cookrew://join#7KQ4-M2X', // seven characters
      'cookrew://join#7KQ4-M2XB-7KQ4', // twelve
      'cookrew://join#0OO1-IIll', // the characters that are two characters
      'cookrew://join/extra#7KQ4M2XB', // a path this verb does not have
      'cookrew://join?x=1#7KQ4M2XB', // a query this verb does not have
      'https://cookrew.dev/join#7KQ4M2XB', // the site's page is not the link
    ]) {
      expect(parseDeepLink(raw), raw).toBeNull()
    }
  })

  it('leaves the other verbs refusing a fragment, as they always did', () => {
    // A fragment is the part of a URL a server never sees, which is why the
    // code lives there — and why nothing else may carry one.
    expect(parseDeepLink('cookrew://import/@drej/alpha#7KQ4M2XB')).toBeNull()
    expect(parseDeepLink('cookrew://serve/@drej/alpha#anything')).toBeNull()
  })

  it('reaches the account surface through the seam, not through a second subscriber', () => {
    // The bridge holds ONE deep-link subscriber (App). The surface listens
    // here instead, or the import links would stop arriving.
    const seen: string[] = []
    const off = onJoinRequest((code) => seen.push(code))
    expect(requestJoin(CODE)).toBe(true)
    off()
    expect(requestJoin('AAAA-BBBB')).toBe(false)
    expect(seen).toEqual([CODE])
  })
})

/* ── the first lock of a code-joined Mac, against the real registry ─────── */

describe('joining and first-unlocking against the real registry', () => {
  let server: Server
  let origin = ''
  let dir = ''

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'v3-join-registry-'))
    server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      // Loose on the limiters this file is not about: every call here comes
      // from 127.0.0.1, so one shared address would spend its own budget.
      v2: createV2(dir, {
        limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, joinPerMinute: 1000 },
      }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(dir, { recursive: true, force: true })
  })

  const mac = (name: string): { base: string; accounts: Accounts } => {
    const base = emptyMac()
    return { base, accounts: new Accounts({ base, origin, deviceName: name }) }
  }

  /** The app's own wiring: the lock checks the account's verifier, as index.ts does. */
  const deps = (accounts: Accounts, lock: IdleLock): AccountIpcDeps => ({
    accounts,
    lock,
    requests: new Requests({ accounts, notify: () => undefined }),
    factors: new Factors({ accounts, registry: origin }),
    envUsername: null,
    workspaces: () => [],
    saveCodes: () => Promise.resolve({ ok: false, reason: 'no_window' }),
  })

  it('e2e steps 2 and 3: B joins by A’s code, has no verifier, then unlocks offline', async () => {
    // STEP 2, the minting side: a Mac that is signed in, under step-up.
    const a = mac('MacBook Pro · drej-mbp')
    expect(await a.accounts.claim({ username: 'drej', password: PASSWORD })).toMatchObject({
      ok: true,
    })
    const wrongPassword = await a.accounts.mintJoinCode('not the one')
    expect(wrongPassword).toMatchObject({ ok: false })
    const minted = await a.accounts.mintJoinCode(PASSWORD)
    expect(minted.ok).toBe(true)
    if (!minted.ok) return
    // What the sheet draws: the code a person reads out, and the link a phone
    // scans. The link carries the code in its FRAGMENT, so the site that
    // serves /join never receives it.
    expect(normaliseJoinCode(minted.value.code)).toBe(minted.value.code)
    expect(minted.value.url).toBe(`${origin}/join#${minted.value.code}`)
    expect(minted.value.expiresAt).toBeGreaterThan(Date.now())

    // STEP 3, the joining side: nothing typed on B but the code.
    const b = mac('Mac mini · studio')
    expect(await b.accounts.join({ code: minted.value.code })).toMatchObject({ ok: true })
    expect(loadAccount(b.base)?.username).toBe('drej')
    expect(loadAccount(b.base)?.unlock).toBeNull()
    expect(b.accounts.passwordPending()).toBe(true)

    // Both Macs are on the account, and each is its own device.
    const me = await b.accounts.call<{ devices: { name: string }[] }>('/v2/me', { method: 'GET' })
    expect(me.ok).toBe(true)
    if (!me.ok) return
    const names = me.value.devices.map((d) => d.name)
    expect(names).toHaveLength(2)
    expect(names).toContain('MacBook Pro · drej-mbp')
    expect(names).toContain('Mac mini · studio')

    // THE CODE IS DEAD. A second machine cannot walk in behind the first.
    const c = mac('Third Mac')
    const second = await c.accounts.join({ code: minted.value.code })
    expect(second).toMatchObject({ ok: false, reason: 'bad_credentials' })
    expect(joinRefusalSentence('bad_credentials')).toBe(ACCOUNT_COPY.JOIN_CODE_SPENT)
    expect(existsSync(accountFile(c.base))).toBe(false)

    // ── THE FIRST IDLE LOCK on B: the one lock that needs cookrew.dev ──
    const lock = new IdleLock({
      lockAfterMs: DEFAULT_LOCK_AFTER_MS,
      verify: (password) => b.accounts.verifyUnlock(password),
    })
    lock.lock()
    const handlers = accountHandlers(deps(b.accounts, lock))
    const unlock = handlers['account:unlock'] as (p: string) => Promise<Record<string, unknown>>

    // The lock says so, in its own words, before anything is typed.
    expect(lockNote(null, undefined, b.accounts.passwordPending()).line).toBe(
      ACCOUNT_COPY.LOCK_FIRST_PASSWORD,
    )

    // A wrong password is refused BY THE REGISTRY and reported as a wrong
    // password, counted by the local lock exactly as on any other Mac.
    expect(await unlock('not the one')).toMatchObject({ ok: false, reason: 'wrong', triesLeft: 4 })
    expect(lock.locked).toBe(true)
    expect(loadAccount(b.base)?.unlock).toBeNull()

    // The right one opens it, and WRITES THE VERIFIER on the way through.
    expect(await unlock(PASSWORD)).toMatchObject({ ok: true, sessionRenewed: true })
    expect(lock.locked).toBe(false)
    expect(loadAccount(b.base)?.unlock).not.toBeNull()
    expect(b.accounts.passwordPending()).toBe(false)

    // FROM NOW ON IT IS OFFLINE. Nothing below touches the socket: the
    // registry is still up, but the verifier is what answers.
    lock.lock()
    expect(await unlock('not the one')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(b.accounts.verifyUnlock(PASSWORD)).toBe(true)
    expect(await unlock(PASSWORD)).toMatchObject({ ok: true })
    expect(lock.locked).toBe(false)
  }, 60_000)

  it('a first unlock that cookrew.dev cannot answer is not the owner getting it wrong', async () => {
    const a = mac('MacBook Pro · drej-mbp')
    await a.accounts.claim({ username: 'drej', password: PASSWORD })
    const minted = await a.accounts.mintJoinCode(PASSWORD)
    if (!minted.ok) throw new Error('no code')

    const b = mac('Mac mini · studio')
    expect(await b.accounts.join({ code: minted.value.code })).toMatchObject({ ok: true })

    // The same Mac, pointed at a socket nobody is listening on — a plane, a
    // hotel captive portal, a registry that is down.
    const offlineB = new Accounts({ base: b.base, origin: 'http://127.0.0.1:1' })
    const lock = new IdleLock({
      lockAfterMs: DEFAULT_LOCK_AFTER_MS,
      verify: (password) => offlineB.verifyUnlock(password),
    })
    lock.lock()
    const handlers = accountHandlers(deps(offlineB, lock))
    const unlock = handlers['account:unlock'] as (p: string) => Promise<Record<string, unknown>>

    const answer = await unlock(PASSWORD)
    // Not "Not it. 4 tries left", which would send them to change what they
    // are typing. The registry's own reason, and the lock stays shut.
    expect(answer).toMatchObject({ ok: false, reason: 'unproven', refusal: 'offline' })
    expect(lock.locked).toBe(true)
    expect(loadAccount(b.base)?.unlock).toBeNull()
    expect(
      lockNote(answer as { ok: false; reason: 'unproven'; refusal: 'offline' }).line,
    ).toBe(ACCOUNT_COPY.REGISTRY_DOWN)
  }, 60_000)
})
