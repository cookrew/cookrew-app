import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
import { Accounts, loadAccount, writeAccount } from '../src/main/account-v2'

/**
 * THE LIVE DEFECT, END TO END, WITH NOTHING STUBBED.
 *
 * The owner's session ended (their password was changed on the web). The
 * desktop showed "Your session ended. Type your password once and this carries
 * on.", they typed it, and cookrew.dev answered 401 second_factor because the
 * account has an authenticator enrolled. The card printed "One more step. Prove
 * it is you." and offered no step — so the Mac sat there with no relay line, no
 * reach and a door reading offline.
 *
 * A REAL registry listens on a port and the app's own account module talks to
 * it over HTTP: claim, enrol the authenticator through the registry's own /me
 * routes, throw the session away, and then walk the whole way back in. If this
 * passes, that Mac can recover itself.
 */

const PASSWORD = 'correct horse battery staple'
const USERNAME = 'drej'

let dir = ''
let home = ''
let origin = ''
let server: Server

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'idv2-ladder-registry-'))
  home = mkdtempSync(path.join(tmpdir(), 'idv2-ladder-home-'))
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir),
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
  rmSync(home, { recursive: true, force: true })
})

const accounts = (): Accounts => new Accounts({ base: home, origin, deviceName: 'MacBook Pro' })

/** The digits an authenticator app would be showing, `shift` steps from now. */
const codeFor = (secret: string, shift = 0): string =>
  totpAt(base32Decode(secret) as Buffer, Date.now() + shift * TOTP_STEP_MS)

/**
 * Enrol an authenticator through the registry's real /v2/me/totp routes.
 *
 * CONFIRMED WITH THE PREVIOUS STEP'S CODE, not this one's. RFC 6238 says an
 * accepted code must not be accepted again, and the registry refuses any step
 * at or below the last one it spent (v2-factor-store.ts) — so confirming with
 * the code showing right now would burn the very code the sign-in below is
 * about to type, and confirming with the NEXT one would burn that too.
 */
async function enrolAuthenticator(app: Accounts): Promise<string> {
  const started = await app.call<{ secret: string; otpauth: string }>('/v2/me/totp/enrol', {
    method: 'POST',
    body: '{}',
  })
  expect(started.ok).toBe(true)
  if (!started.ok) throw new Error('enrolment refused')
  expect(started.value.otpauth).toContain(`otpauth://totp/cookrew.dev:${USERNAME}`)
  const confirmed = await app.call<void>('/v2/me/totp/confirm', {
    method: 'POST',
    body: JSON.stringify({ code: codeFor(started.value.secret, -1) }),
    parse: false,
  })
  expect(confirmed.ok).toBe(true)
  return started.value.secret
}

/**
 * cookrew.dev threw this Mac's session away.
 *
 * Written into the file rather than faked in memory, because that is what
 * `authed` does when it meets a 401 — and because the app under test has to be
 * a RESTARTED one for the recovery to mean anything.
 */
function throwTheSessionAway(): void {
  const stored = loadAccount(home)
  if (!stored?.session) throw new Error('no session to end')
  writeAccount({ ...stored, session: { ...stored.session, endedAt: Date.now() } }, home)
}

describe('a Mac whose session ended, with an authenticator on the account', () => {
  it('types the password, climbs the authenticator rung, and is live again', async () => {
    const first = accounts()
    expect((await first.claim({ username: USERNAME, password: PASSWORD })).ok).toBe(true)
    const secret = await enrolAuthenticator(first)

    throwTheSessionAway()
    // A RESTARTED app: the file is the only thing carried over, which is the
    // state the owner's Mac was actually in.
    const app = accounts()
    expect(app.sessionLive()).toBe(false)

    // THE PASSWORD STEP. Right password, and it is still not enough — this is
    // exactly where the card used to stop.
    const step = await app.resume(PASSWORD)
    expect(step.ok).toBe(false)
    if (step.ok || step.reason !== 'second_factor') throw new Error('expected a step')
    expect(step.step.next).toContain('totp')
    expect(step.step.pending).toMatch(/^[0-9a-f-]{36}$/)
    expect(app.sessionLive()).toBe(false)

    // THE RUNG. A wrong code first, because that is what a person does, and
    // the ladder has to survive it.
    const wrong = await app.resumeWithCode(step.step.pending, 'totp', '000000')
    expect(wrong).toMatchObject({ ok: false, reason: 'bad_code' })

    const done = await app.resumeWithCode(step.step.pending, 'totp', codeFor(secret, 1))
    expect(done.ok).toBe(true)
    expect(app.sessionLive()).toBe(true)
    // The session is on disk and usable: the profile is a real authenticated
    // read at the registry, which is what "the Mac is back" means.
    const profile = await app.profile()
    expect(profile.ok).toBe(true)
    if (profile.ok) expect(profile.value.username).toBe(USERNAME)
    // And the same device, still attached — one desktop, not two.
    if (profile.ok) expect(profile.value.devices).toHaveLength(1)
    // The offline unlock verifier moved with it, so the app can be locked and
    // unlocked on a plane with the password that just worked.
    expect(app.verifyUnlock(PASSWORD)).toBe(true)
  })

  it('finishes on a recovery code when the phone with the app is gone', async () => {
    const first = accounts()
    await first.claim({ username: USERNAME, password: PASSWORD })
    await enrolAuthenticator(first)
    const codes = await first.recoveryCodes()
    expect(codes.ok).toBe(true)
    if (!codes.ok) throw new Error('no codes')

    throwTheSessionAway()
    const app = accounts()
    const step = await app.resume(PASSWORD)
    if (step.ok || step.reason !== 'second_factor') throw new Error('expected a step')
    expect(step.step.next).toContain('recovery')

    const wrong = await app.resumeWithCode(step.step.pending, 'recovery', 'ZZZZ-ZZZZ')
    expect(wrong).toMatchObject({ ok: false, reason: 'bad_recovery' })
    const done = await app.resumeWithCode(step.step.pending, 'recovery', codes.value[0])
    expect(done.ok).toBe(true)
    expect(app.sessionLive()).toBe(true)
    // Each opens the account exactly once: the same code is spent now.
    throwTheSessionAway()
    const again = accounts()
    const second = await again.resume(PASSWORD)
    if (second.ok || second.reason !== 'second_factor') throw new Error('expected a step')
    expect(
      await again.resumeWithCode(second.step.pending, 'recovery', codes.value[0]),
    ).toMatchObject({ ok: false, reason: 'bad_recovery' })
  })

  it('asks another device, waits, and lands the session the nod opened', async () => {
    // The rung an owner with no authenticator and no codes still has: the
    // account's other device says yes, and this one collects its own session.
    const first = accounts()
    await first.claim({ username: USERNAME, password: PASSWORD })
    const held = loadAccount(home)?.session?.token ?? ''
    // A device the account has never seen, so the ladder applies with 'approve'
    // as the way through — the same shape as a Mac whose session ended on an
    // account that only has other devices to ask.
    const otherHome = mkdtempSync(path.join(tmpdir(), 'idv2-ladder-home2-'))
    try {
      // It claims nothing — it is the SAME ACCOUNT on a second Mac, so it gets
      // a copy of the file with a key of its own and no session, which is what
      // a desktop signing in for the first time actually holds.
      const stored = loadAccount(home)
      if (!stored) throw new Error('no account')
      const { mintDeviceKey, deviceIdFor } = await import('../src/main/account-v2')
      const keys = mintDeviceKey()
      writeAccount(
        {
          ...stored,
          name: 'Mac mini',
          deviceId: deviceIdFor(keys.publicKeyJwk),
          privateKeyJwk: keys.privateKeyJwk,
          publicKeyJwk: keys.publicKeyJwk,
          session: null,
        },
        otherHome,
      )
      const app = new Accounts({ base: otherHome, origin, deviceName: 'Mac mini' })
      const step = await app.resume(PASSWORD)
      if (step.ok || step.reason !== 'second_factor') throw new Error('expected a step')
      expect(step.step.next).toEqual(['approve'])

      const asked = await app.resumeAsk(step.step.pending)
      expect(asked.ok).toBe(true)
      if (!asked.ok) throw new Error('not asked')
      expect(asked.value.sentence).toContain(`sign in as @${USERNAME}`)

      // The waiting Mac starts polling; the first Mac answers a moment later,
      // which is the order these two things really happen in.
      const waiting = app.resumeWait(step.step.pending, { everyMs: 20 })
      const decided = await fetch(`${origin}/v2/me/approvals/${asked.value.approval}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${held}` },
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(decided.status).toBe(204)
      expect(await waiting).toMatchObject({ ok: true })
      expect(app.sessionLive()).toBe(true)
      expect(app.verifyUnlock(PASSWORD)).toBe(true)
    } finally {
      rmSync(otherHome, { recursive: true, force: true })
    }
  })
})
