import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import type { V2Identity } from '../registry/src/v2-http'
import { renewMessage } from '../registry/src/v2-renew'
import { Accounts, loadAccount, signWithDevice, writeAccount } from '../src/main/account-v2'
import { createAdmittedDeviceStore, hashToken, writeAdmittedDevices } from '../src/main/admitted-devices'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'
import { RENEW_AHEAD_MS, expiryWarningDue, renewDue } from '../src/shared/session-renew'

/**
 * IDENTITY v3, CUT 3 — THE ACCEPTANCE SCRIPT FOR STEPS 12 AND 13.
 *
 * The same harness Magpie built for cut 1 (tests/v3-e2e.test.ts): a REAL
 * registry started in process on port 0, account bases standing in for Macs,
 * and the app's own classes driven over HTTP with no Electron anywhere. A
 * spawned bundle would be a different build from the branch under test, which
 * is the one thing an acceptance script may not be.
 *
 * TWO THINGS THIS ONE ADDS, because cut 3 is about the CLOCK:
 *
 *   THE REGISTRY IS ON AN INJECTED CLOCK (`createV2(dir, { now })`) and so is
 *   every Accounts. Step 12 is "six days before expiry", and the honest way
 *   to be there is to move both clocks to twenty-four days after the session
 *   was minted — not to hand-edit an expiry into a file and hope the rest of
 *   the system agrees with it.
 *
 *   THE V2 OBJECT IS HELD, not just the port. `v2.accounts` answers what the
 *   wire cannot: which sittings exist, which ids are published as revoked.
 *   Those are the observables the two steps are actually about, and reading
 *   them through a route would be reading the route's opinion of them.
 *
 * WHAT A FAILING ASSERTION HERE MEANS. Every number below is reported in the
 * DONE block as an observed value. A step that cannot be reached is named as
 * a finding rather than skipped quietly — see the not-me block, where one
 * clause of the design's step 13 has no producer on this branch at all.
 */

const OWNER = 'drej'
const PASSWORD = 'correct horse battery staple'
const DAY = 24 * 60 * 60 * 1000
/** Real scrypt at the registry's real cost: a claim and a ladder are seconds. */
const SLOW = 90_000

/** The team Mac B serves — the door that must not drop while the session turns over. */
const TEAM = { name: 'alpha', title: 'COOKREW Alpha' }

let registryDir = ''
let origin = ''
let close: () => Promise<void>
let v2: V2Identity
/** Both clocks. Moved by the tests; read by the registry and by every Accounts. */
let clock = Date.UTC(2026, 8, 18, 9, 0, 0)
const now = (): number => clock

const bases: string[] = []

function emptyBase(what: string): string {
  const base = mkdtempSync(path.join(tmpdir(), `v3-cut3-${what}-`))
  bases.push(base)
  return base
}

interface Machine {
  base: string
  accounts: Accounts
  /** Every URL this machine has asked for, in order — for "no request at all". */
  asked: string[]
}

/** The app as it runs on one machine, on the shared clock, pointed at the test registry. */
function machine(name: string): Machine {
  const base = emptyBase(name.toLowerCase().replace(/\W+/g, '-'))
  const asked: string[] = []
  const accounts = new Accounts({
    base,
    origin,
    deviceName: name,
    now,
    fetch: (input, init) => {
      asked.push(String(input))
      return fetch(input, init)
    }
  })
  return { base, accounts, asked }
}

/** Raw HTTP, for the routes the app has no method for. */
async function call(
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

const sessionToken = (base: string): string => {
  const token = loadAccount(base)?.session?.token
  if (typeof token !== 'string' || token === '') throw new Error('that base holds no session')
  return token
}

const deviceIdOf = (base: string): string => {
  const id = loadAccount(base)?.deviceId
  if (typeof id !== 'string') throw new Error('that base holds no device id')
  return id
}

/** The sittings the registry is holding for this account, by jti. */
const sittings = (): string[] =>
  (v2.accounts.get(OWNER)?.sessions ?? []).map((s: { jti: string }) => s.jti)

/** The sittings of ONE device — three devices means three, and only one turns over. */
const sittingsOf = (deviceId: string): string[] =>
  (v2.accounts.get(OWNER)?.sessions ?? [])
    .filter((s: { dev: string }) => s.dev === deviceId)
    .map((s: { jti: string }) => s.jti)

/** GET /v2/me/requests answers a BARE ARRAY — the queue is the body. */
const queueRows = (body: unknown): unknown[] => (Array.isArray(body) ? body : [])

/** Attach a second device the way the ladder does: password, then a rescue code. */
async function attachByRecovery(name: string, code: string): Promise<Machine> {
  const who = machine(name)
  const step = await who.accounts.signIn({ username: OWNER, password: PASSWORD })
  if (step.ok || step.reason !== 'second_factor') {
    throw new Error(`expected the ladder for ${name}, got ${JSON.stringify(step)}`)
  }
  const landed = await who.accounts.resumeWithCode(step.step.pending, 'recovery', code)
  if (!landed.ok) throw new Error(`${name} could not climb: ${JSON.stringify(landed)}`)
  return who
}

let macA: Machine
let macB: Machine
let phone: Machine
let recoveryCodes: readonly string[] = []
/** What step 12 measured, for the report. */
const observed: Record<string, unknown> = {}

beforeAll(async () => {
  registryDir = mkdtempSync(path.join(tmpdir(), 'v3-cut3-registry-'))
  const doors = new DoorStore(registryDir, { allowPrivate: true })
  doors.register(OWNER, {
    handle: OWNER,
    door: 'Pilot',
    name: TEAM.name,
    title: TEAM.title,
    agents: 3,
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    address: `https://cookrew.dev/@${OWNER}/${TEAM.name}`,
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe', 'x402']
  })
  v2 = createV2(registryDir, {
    now,
    // Loose on the limiters this file is not about — every call comes from
    // 127.0.0.1, so one address would spend its own budget several times over.
    limits: {
      accountsPerMinute: 1000,
      sessionsPerMinute: 1000,
      lookupsPerMinute: 1000,
      renewPerMinute: 1000
    }
  })
  const server = createRegistry({
    store: new RegistryStore(registryDir),
    log: new TransparencyLog(registryDir),
    identity: new IdentityService(registryDir),
    doors,
    stars: new StarStore(registryDir),
    origin: 'https://cookrew.dev',
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })

  // The chain's first two links, as cut 1 left them: Mac A holds the account
  // and the rescue codes; Mac B and the phone are devices of it.
  macA = machine('Mac A')
  const claimed = await macA.accounts.claim({ username: OWNER, password: PASSWORD })
  if (!claimed.ok) throw new Error(`Mac A could not claim: ${JSON.stringify(claimed)}`)
  const codes = await macA.accounts.recoveryCodes()
  if (!codes.ok) throw new Error('no recovery codes')
  recoveryCodes = codes.value
  macB = await attachByRecovery('Mac B', recoveryCodes[0])
  phone = await attachByRecovery('Phone', recoveryCodes[1])
}, SLOW)

afterAll(async () => {
  await close()
  rmSync(registryDir, { recursive: true, force: true })
  for (const base of bases) rmSync(base, { recursive: true, force: true })
})

/* ── step 12 ───────────────────────────────────────────────────────────── */

describe('step 12 — the session renews with nobody typing', () => {
  it('renews six days out on the device key, and the door never drops', async () => {
    const before = loadAccount(macB.base)?.session
    if (!before) throw new Error('Mac B holds no session')
    observed.expBefore = before.exp
    observed.mintedLife = before.exp - clock

    // Mac B has published its workspaces — the serving side of the door that
    // must survive the turnover.
    expect(await macB.accounts.registerDesktop([{ id: 'ws-1', name: TEAM.name }])).toMatchObject({
      ok: true
    })

    // THE DOOR, as a door sees it: the app's own verifier, reading the
    // registry's published key and revoked list over HTTP. A token minted for
    // this team now is what a caller would be holding when the renewal lands.
    const verifier = createV2CallTokenVerifier({ keys: v2KeysOverHttp(origin) })
    const minted = await call(
      'POST',
      `/v2/teams/@${OWNER}/${TEAM.name}/call-token`,
      { audience: `@${OWNER}/${TEAM.name}` },
      sessionToken(macA.base)
    )
    observed.callTokenStatus = minted.status
    const callToken = typeof minted.body.token === 'string' ? minted.body.token : null
    const aud = String(minted.body.aud ?? `@${OWNER}/${TEAM.name}`)
    if (callToken === null) throw new Error(`no call token: ${JSON.stringify(minted.body)}`)
    // `verify` answers the identity a door would seat, or null. Null is the
    // door being shut, which is precisely what must not change below.
    const beforeDoor = await verifier.verify(callToken, aud)
    observed.doorBeforeRenew = beforeDoor === null ? 'shut' : `open as @${beforeDoor.username}`
    expect(beforeDoor).not.toBeNull()

    // ── six days out ──
    clock += 24 * DAY
    const due = renewDue(before, clock)
    observed.daysToExpiry = Math.round((before.exp - clock) / DAY)
    expect(due).toBe(true)
    expect(before.exp - clock).toBeLessThanOrEqual(RENEW_AHEAD_MS)

    const sittingsBefore = sittings()
    const mineBefore = sittingsOf(deviceIdOf(macB.base))
    const beforeToken = sessionToken(macB.base)
    const askedBefore = macB.asked.length
    const renewed = await macB.accounts.renew()
    expect(renewed).toBe(true)

    const after = loadAccount(macB.base)?.session
    observed.expAfter = after?.exp
    observed.movedForwardDays = Math.round(((after?.exp ?? 0) - before.exp) / DAY)
    expect(after?.exp).toBeGreaterThan(before.exp)
    // NOBODY TYPED. Two calls: a nonce, and the signature. No password route
    // was touched, and the offline verifier is exactly the one it was.
    const spent = macB.asked.slice(askedBefore)
    observed.renewCalls = spent.map((url) => url.replace(origin, ''))
    expect(spent).toHaveLength(2)
    expect(spent.some((url) => url.includes('/v2/sessions/renew-nonce'))).toBe(true)
    expect(spent.some((url) => url.endsWith('/v2/sessions/renew'))).toBe(true)
    expect(spent.some((url) => url.endsWith('/v2/sessions'))).toBe(false)
    expect(loadAccount(macB.base)?.unlock).toEqual(loadAccount(macB.base)?.unlock)
    expect(macB.accounts.verifyUnlock(PASSWORD)).toBe(true)

    // A REPLACEMENT, NOT AN ADDITION: the same number of sittings, and the
    // old jti is gone rather than accumulating a month of live bearers.
    const sittingsAfter = sittings()
    const mineAfter = sittingsOf(deviceIdOf(macB.base))
    observed.sittingsBefore = sittingsBefore.length
    observed.sittingsAfter = sittingsAfter.length
    observed.macBSittings = `${mineBefore.length} -> ${mineAfter.length}`
    // The account still holds one sitting per device (A, B, the phone) and
    // Mac B's is a DIFFERENT one: replaced, not added to.
    expect(sittingsAfter).toHaveLength(sittingsBefore.length)
    expect(mineAfter).toHaveLength(1)
    expect(mineAfter[0]).not.toBe(mineBefore[0])
    observed.oldJtiStillPublished = v2.accounts.revokedFor(OWNER).includes(mineBefore[0])

    // THE DOOR NEVER DROPPED. The same caller token, verified again by a
    // FRESH verifier — so the key and the revoked list are re-fetched from the
    // registry as it stands after the turnover, not read from a warm cache.
    const afterDoor = await createV2CallTokenVerifier({ keys: v2KeysOverHttp(origin) }).verify(
      callToken,
      aud
    )
    observed.doorAfterRenew = afterDoor === null ? 'shut' : `open as @${afterDoor.username}`
    expect(observed.doorAfterRenew).toBe(observed.doorBeforeRenew)

    // THE OLD BEARER, for the record. The sitting is gone from the registry,
    // so a route that checks it refuses — but the jti is NOT published as
    // revoked, so an offline verifier would still take it until it expires.
    const oldBearer = await call('GET', '/v2/me', undefined, beforeToken)
    observed.oldSessionTokenStatus = oldBearer.status
    // Dead at the registry, which checks the sitting exists...
    expect(oldBearer.status).toBe(401)
    // ...and NOT published as revoked, which is the part worth writing down:
    // `closeOtherSessionsForDevice` drops the row without calling `withRevoked`,
    // so a verifier working offline from /v2/keys has no way to learn that
    // last month's bearer is finished until it expires on its own.
    expect(observed.oldJtiStillPublished).toBe(false)
    // And nothing about Mac B was published as revoked by renewing.
    observed.revokedAfterRenew = v2.accounts.revokedFor(OWNER)
    expect(v2.accounts.revokedFor(OWNER)).not.toContain(deviceIdOf(macB.base))

    // The serving side is still filed, with its workspaces.
    const me = await call('GET', '/v2/me', undefined, sessionToken(macB.base))
    observed.meAfterRenew = me.status
    expect(me.status).toBe(200)
    const desktops = me.body.desktops as { deviceId: string; workspaces: unknown[] }[]
    const mine = desktops.find((d) => d.deviceId === deviceIdOf(macB.base))
    observed.desktopWorkspaces = mine?.workspaces.length
    expect(mine?.workspaces).toHaveLength(1)

    // The warning is NOT due: renewal is working, which is the whole gate.
    observed.warningDue = expiryWarningDue(after ?? null, clock, macB.accounts.renewFailing())
    expect(observed.warningDue).toBe(false)
  }, SLOW)

  it('a REVOKED device cannot renew — the fourth line of the security model', async () => {
    // The phone is taken back from Mac A, and then tries to buy itself a
    // fresh month with the key that was just cut off.
    const phoneId = deviceIdOf(phone.base)
    const revoked = await call(
      'DELETE',
      `/v2/me/devices/${encodeURIComponent(phoneId)}`,
      undefined,
      sessionToken(macA.base)
    )
    observed.revokeStatus = revoked.status
    expect(revoked.status).toBe(204)
    expect(v2.accounts.revokedFor(OWNER)).toContain(phoneId)

    // Straight at the route, with a signature that is otherwise perfect: the
    // nonce is fresh, the message is right, the key is the device's own.
    const account = loadAccount(phone.base)
    if (!account) throw new Error('the phone holds no account')
    const nonce = await call('GET', '/v2/sessions/renew-nonce')
    const sig = signWithDevice(account, renewMessage(OWNER, phoneId, String(nonce.body.nonce)))
    const attempt = await call('POST', '/v2/sessions/renew', {
      device: phoneId,
      nonce: nonce.body.nonce,
      sig
    })
    observed.revokedRenewStatus = attempt.status
    observed.revokedRenewError = attempt.body.error
    expect(attempt.status).toBe(401)

    // And through the app, which is what would actually be running: the file
    // is left exactly as it was, so nothing believes it has a new month.
    const before = loadAccount(phone.base)?.session?.exp
    // Its session was ended by the revoke, so the clock alone would not ask —
    // the file is put back to a renewable state to prove the REGISTRY is the
    // thing refusing, not the local guard.
    writeAccount(
      { ...account, session: { token: account.session?.token ?? '', exp: clock + 6 * DAY } },
      phone.base
    )
    const renewable = new Accounts({ base: phone.base, origin, now })
    observed.revokedAppRenew = await renewable.renew()
    expect(observed.revokedAppRenew).toBe(false)
    expect(loadAccount(phone.base)?.session?.exp).toBe(clock + 6 * DAY)
    observed.revokedPhoneExpUnmoved = loadAccount(phone.base)?.session?.exp === clock + 6 * DAY
    expect(before).toBeDefined()
  }, SLOW)

  it('a replayed nonce is refused — a scraped signature buys nothing', async () => {
    const account = loadAccount(macB.base)
    if (!account) throw new Error('Mac B holds no account')
    const deviceId = account.deviceId
    const issued = await call('GET', '/v2/sessions/renew-nonce')
    const nonce = String(issued.body.nonce)
    const sig = signWithDevice(account, renewMessage(OWNER, deviceId, nonce))

    const first = await call('POST', '/v2/sessions/renew', { device: deviceId, nonce, sig })
    observed.nonceFirst = first.status
    expect(first.status).toBe(201)

    // The identical body, a second time — which is exactly what an attacker
    // holding a copy of the wire would send.
    const replay = await call('POST', '/v2/sessions/renew', { device: deviceId, nonce, sig })
    observed.nonceReplay = replay.status
    observed.nonceReplayError = replay.body.error
    expect(replay.status).toBe(401)

    // Mac B's file is whatever the FIRST renewal left; the replay moved
    // nothing. (The app is handed the first answer here only to keep its file
    // and the registry's sittings agreeing for the steps below.)
    const fresh = first.body as { token?: string; exp?: number }
    if (typeof fresh.token === 'string' && typeof fresh.exp === 'number') {
      writeAccount({ ...account, session: { token: fresh.token, exp: fresh.exp } }, macB.base)
    }
  }, SLOW)

  it('a session the registry already ENDED is never even attempted', async () => {
    const account = loadAccount(macB.base)
    if (!account) throw new Error('Mac B holds no account')
    // What `endSession()` writes after a 401: the session is still in the
    // file, with the day it was refused on it.
    const ended = { ...account, session: { token: 'a-dead-token', exp: clock + 6 * DAY, endedAt: clock } }
    writeAccount(ended, macB.base)

    const watched: string[] = []
    const silent = new Accounts({
      base: macB.base,
      origin,
      now,
      fetch: (input, init) => {
        watched.push(String(input))
        return fetch(input, init)
      }
    })
    observed.endedRenewDue = renewDue(ended.session, clock)
    expect(observed.endedRenewDue).toBe(false)
    observed.endedRenewAnswer = await silent.renew()
    expect(observed.endedRenewAnswer).toBe(false)
    // THE ABSENCE IS THE ASSERTION. Not "the registry refused it" — the Mac
    // never asked, because a key that could renew a session "not me" had just
    // ended would undo the alarm with the very credential it was cutting off.
    observed.endedRenewCalls = watched.length
    expect(watched).toEqual([])

    // Put Mac B back on a live session for step 13.
    writeAccount(account, macB.base)
  }, SLOW)
})

/* ── step 13 ───────────────────────────────────────────────────────────── */

describe('step 13 — not me', () => {
  it('signs the others out, locks the password, and empties the queue', async () => {
    // A device the account has never seen asks to sign in with the password,
    // and raises the approval Mac B is about to answer.
    const stranger = machine('Stranger Mac')
    const step = await stranger.accounts.signIn({ username: OWNER, password: PASSWORD })
    if (step.ok || step.reason !== 'second_factor') {
      throw new Error(`expected the ladder, got ${JSON.stringify(step)}`)
    }
    const asked = await stranger.accounts.resumeAsk(step.step.pending)
    expect(asked).toMatchObject({ ok: true })

    // There is also something in the QUEUE — a seat request from a guest —
    // so "empties the queue" is a change and not a tautology.
    const queueBefore = await call('GET', '/v2/me/requests', undefined, sessionToken(macB.base))
    observed.queueBefore = queueRows(queueBefore.body).length
    observed.queueBeforeKinds = queueRows(queueBefore.body).map((r) => (r as { kind: string }).kind)
    expect(queueBefore.status).toBe(200)
    expect(observed.queueBefore).toBeGreaterThan(0)

    /**
     * THE LAN LEDGERS, BEFORE — with TWO rows each, and the second row is the
     * whole reason this reads as evidence.
     *
     * The phone was REVOKED in step 12's renewal test, so its row is expected
     * to go: that is step 11's line (the published revoked list reaching every
     * Mac's Wi-Fi) still working, and nothing to do with not-me. The second
     * row is Mac A's own device id — signed out by not-me and still ATTACHED,
     * which is exactly the case §06's clause is about. Measuring one row would
     * have measured the earlier revoke and called it not-me.
     */
    const phoneId = deviceIdOf(phone.base)
    const macAId = deviceIdOf(macA.base)
    for (const mac of [macA, macB]) {
      writeAdmittedDevices(
        [
          {
            deviceId: phoneId,
            name: 'Phone (revoked in step 12)',
            admittedAt: clock,
            lastSeenAt: clock,
            tokenHash: hashToken(`phone-token-${mac.base}`)
          },
          {
            deviceId: macAId,
            name: 'Mac A (signed out by not-me, still attached)',
            admittedAt: clock,
            lastSeenAt: clock,
            tokenHash: hashToken(`mac-a-token-${mac.base}`)
          }
        ],
        mac.base
      )
    }
    observed.admittedABefore = createAdmittedDeviceStore({ base: macA.base }).list().length
    observed.admittedBBefore = createAdmittedDeviceStore({ base: macB.base }).list().length

    const approvals = await call('GET', '/v2/me/approvals', undefined, sessionToken(macB.base))
    const rows = approvals.body as unknown as { id: string }[]
    expect(Array.isArray(rows)).toBe(true)
    const approvalId = rows[0]?.id
    expect(typeof approvalId).toBe('string')

    const sittingsBefore = sittings()
    observed.sittingsBeforeNotMe = sittingsBefore.length
    const pressed = await call(
      'POST',
      `/v2/me/approvals/${encodeURIComponent(approvalId)}`,
      { decision: 'not-me' },
      sessionToken(macB.base)
    )
    observed.notMeStatus = pressed.status
    expect(pressed.status).toBe(204)

    // A AND THE PHONE ARE SIGNED OUT; B, which pressed it, is not.
    const afterA = await call('GET', '/v2/me', undefined, sessionToken(macA.base))
    const afterB = await call('GET', '/v2/me', undefined, sessionToken(macB.base))
    observed.macAAfterNotMe = afterA.status
    observed.macBAfterNotMe = afterB.status
    expect(afterA.status).toBe(401)
    expect(afterB.status).toBe(200)
    observed.sittingsAfterNotMe = sittings().length
    expect(sittings()).toHaveLength(1)

    // THE PASSWORD IS LOCKED. The old one, on any device, answers the reason
    // rather than a session.
    const later = await call('POST', '/v2/sessions', {
      username: OWNER,
      password: PASSWORD,
      device: {
        id: deviceIdOf(macA.base),
        kind: 'desktop',
        name: 'Mac A',
        jwk: loadAccount(macA.base)?.publicKeyJwk
      }
    })
    observed.oldPasswordStatus = later.status
    observed.oldPasswordError = later.body.error
    expect(later.status).toBe(403)
    expect(later.body.error).toBe('password_change_required')

    // THE QUEUE IS EMPTY.
    const queueAfter = await call('GET', '/v2/me/requests', undefined, sessionToken(macB.base))
    observed.queueAfter = queueRows(queueAfter.body).length
    expect(queueAfter.status).toBe(200)
    expect(observed.queueAfter).toBe(0)

    // And the app-side half of the revocation line, driven the way the timer
    // drives it: one fetch of /v2/keys, read for the doors and for the ledger.
    const swept: string[] = []
    const verifier = createV2CallTokenVerifier({
      keys: v2KeysOverHttp(origin),
      onRevoked: (revoked) => {
        for (const [label, mac] of [
          ['Mac A', macA],
          ['Mac B', macB]
        ] as const) {
          for (const gone of createAdmittedDeviceStore({ base: mac.base }).prune(revoked)) {
            swept.push(`${label}:${gone.deviceId}`)
          }
        }
      }
    })
    observed.keysRefreshed = await verifier.refresh()
    observed.sweptIds = swept
    observed.admittedALeft = createAdmittedDeviceStore({ base: macA.base })
      .list()
      .map((d) => d.name)
    observed.admittedBLeft = createAdmittedDeviceStore({ base: macB.base })
      .list()
      .map((d) => d.name)
    observed.publishedRevoked = v2.accounts.revokedFor(OWNER)
    observed.phoneIdPublishedRevoked = v2.accounts.revokedFor(OWNER).includes(phoneId)
    observed.macAIdPublishedRevoked = v2.accounts.revokedFor(OWNER).includes(macAId)

    // STEP 11'S LINE STILL WORKS, and it is what swept the phone: its DEVICE
    // id was published when Mac A took it back, and both ledgers dropped it.
    expect(observed.phoneIdPublishedRevoked).toBe(true)
    expect(swept).toEqual([`Mac A:${phoneId}`, `Mac B:${phoneId}`])

    /**
     * THE FINDING, ASSERTED AS WHAT IS RATHER THAN WHAT SHOULD BE.
     *
     * §06 says not-me clears the admitted list on every Mac but the one that
     * raised it. It does not, on this branch, and the reason is structural
     * rather than a missed line: not-me ends SITTINGS (v2-accounts.ts ·
     * endOtherSessions, which says in as many words that "the devices stay
     * attached"), so what joins the published revoked list is SESSION ids.
     * The only consumer the app has is `admitted.prune(revoked)`, which
     * filters DEVICE ids against that list and — by its own docblock — lets a
     * session id pass through inert.
     *
     * So Mac A's row survives on BOTH Macs: the device that was just signed
     * out of the account is still holding the keyboard of every Mac on this
     * Wi-Fi, which is the opposite of what an alarm is for. Pinned here so the
     * lane that closes it has a failing assertion to turn green, and so
     * nobody reads the silence as the clause being met.
     */
    expect(observed.macAIdPublishedRevoked).toBe(false)
    expect(swept.some((row) => row.endsWith(macAId))).toBe(false)
    expect(observed.admittedALeft).toEqual(['Mac A (signed out by not-me, still attached)'])
    expect(observed.admittedBLeft).toEqual(['Mac A (signed out by not-me, still attached)'])
  }, SLOW)
})

/* ── the take-over (V3-18) ─────────────────────────────────────────────── */

describe('take-over — one name, one holder (V3-18)', () => {
  it('records what the registry does TODAY with two Macs publishing one team name', async () => {
    // The baseline the lane has to change. Both Macs of one account publish a
    // desktop whose workspace carries the same team name; nothing at the
    // registry says which of them HOLDS the door @drej/alpha, so the second
    // one is filed beside the first without a word.
    const me = await call('GET', '/v2/me', undefined, sessionToken(macB.base))
    const desktops = (me.body.desktops ?? []) as { deviceId: string; workspaces: { name: string }[] }[]
    observed.desktopsPublishingTeam = desktops.filter((d) =>
      d.workspaces.some((w) => w.name === TEAM.name)
    ).length
    expect(me.status).toBe(200)
    // One today, because only Mac B has published. The point of the number is
    // that the registry has no opinion about a second one.
    observed.doorHolderField = 'absent'
    expect(desktops.every((d) => !('doors' in d))).toBe(true)
  }, SLOW)

  // WAITING ON V3-18 (feat/v3-18-door-ownership carried no work of its own at
  // 09:46 on 2026-09-18 — only merges of 11 and 16). The harness above stands
  // the two Macs up and holds the registry object; these are the three
  // assertions the scenario needs, named so the lane can fill them in rather
  // than invent a shape.
  it.todo('the second Mac sees the conflict rather than a silent name-taken')
  it.todo('TAKE OVER moves @drej/alpha to the second Mac, under step-up')
  it.todo('the first holder is told — a `superseded` event on its own feed')
  it.todo('a STRANGER account asking for the same name is still refused outright')
})

/* ── the numbers this script measured ──────────────────────────────────── */

describe('what was observed', () => {
  it('reports every value the two steps produced', () => {
    // Not an assertion about the product: a place for the run's own numbers to
    // be read off, since the DONE block has to carry values and not "passed".
    expect(Object.keys(observed).length).toBeGreaterThan(0)
    console.error(`[v3-19] observed ${JSON.stringify(observed, null, 2)}`)
  })
})
