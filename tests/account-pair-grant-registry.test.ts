import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { GRANT_TTL_MS } from '../registry/src/v2-tokens'
import { v2GrantClaimsFor, v2MachineGrantClaimsFor, v2WatchGrantClaimsFor } from '../src/main/v2-call-token'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { GRANT_PATHS } from '../src/shared/account-pair'
import { getAssertion, GET_FLAGS, GET_FLAGS_VERIFIED } from './support/webauthn'
import { grantWorld, httpWithBearer, PASSWORD, type GrantWorld } from './support/grant-world'

/**
 * THE PASS, AT cookrew.dev (owner 2026-11-09): one verification, every machine,
 * twelve hours, for one device key. Over the real router.
 */

let world: GrantWorld
let n = 0
beforeAll(async () => {
  world = await grantWorld()
})
afterAll(async () => world.close())
beforeEach(() => forgetGrantRests())

const fresh = async (options: { passwordless?: boolean } = {}) => {
  const username = `granted${++n}`
  await world.account(username, options)
  return { username, browser: await world.browser(username) }
}

describe('POST /v2/me/device-grant', () => {
  it('says how this account can prove itself', async () => {
    const { browser } = await fresh()
    const out = await browser.registry.post(GRANT_PATHS.options, {})
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ methods: { password: true, passkey: false }, needsPassword: false, passkey: null })
  })

  it('issues a twelve-hour pass for the asking device’s own key, after the password', async () => {
    const { username, browser } = await fresh()
    const before = Date.now()
    const out = await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })
    expect(out.status).toBe(201)
    const body = out.body as { grant: string; exp: number; deviceId: string }
    expect(body.deviceId).toBe(browser.device.id)
    const claims = v2GrantClaimsFor(body.grant, Date.now())
    expect(claims).toMatchObject({ username, dev: browser.device.id, jkt: jwkThumbprint(browser.device.jwk) })
    expect(body.exp - before).toBeGreaterThanOrEqual(GRANT_TTL_MS - 1000)
    expect(body.exp - before).toBeLessThanOrEqual(GRANT_TTL_MS + 1000)
  })

  it('a pass is not a session', async () => {
    const { browser } = await fresh()
    const grant = ((await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })).body as { grant: string }).grant
    expect((await httpWithBearer(world.origin, grant).get('/v2/me')).status).toBe(401)
  })

  it('three wrong passwords rest the account’s passes for a minute', async () => {
    const { browser } = await fresh()
    const answers = []
    for (const guess of ['wrong one', 'wrong two', 'wrong three']) answers.push(await browser.registry.post(GRANT_PATHS.grant, { password: guess }))
    expect(answers.map((a) => a.status)).toEqual([401, 401, 429])
    expect(answers[0].body).toMatchObject({ error: 'wrong', triesLeft: 2 })
    const right = await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })
    expect(right.status).toBe(429)
  })

  it('issues one for a passkey verified by a person, and refuses a mere tap', async () => {
    const { username, browser } = await fresh({ passwordless: true })
    const { pair, credentialId } = world.addPasskey(username)
    const ask = async (flags: number) => {
      const options = (await browser.registry.post(GRANT_PATHS.options, {})).body as { passkey: { challenge: string } }
      const made = getAssertion({ pair, credentialId, challenge: options.passkey.challenge, origin: world.origin, rpId: world.rpId, flags })
      return browser.registry.post(GRANT_PATHS.grant, { credential: { id: made.id, response: made.response } })
    }
    expect((await ask(GET_FLAGS)).status).toBe(401)
    expect((await ask(GET_FLAGS_VERIFIED)).status).toBe(201)
  })

  it('never mints a pass on a recent verification alone: a proof made now, every time', async () => {
    const { browser } = await fresh()
    // Signed in by passkey just now (grant-world), and still asked.
    expect((await browser.registry.post(GRANT_PATHS.grant, {})).status).toBe(401)
  })

  it('a pass names the sign-in, not the session: it survives a renewal and dies when the sign-in is ended after it', async () => {
    const { username, browser } = await fresh()
    const owner = await world.browser(username)
    const out = await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })
    const sid = v2GrantClaimsFor((out.body as { grant: string }).grant, Date.now())!.sid
    const before = world.v2.accounts.get(username)!.sessions.find((s) => s.sitting === sid)!
    // The device renews on its key: a new session, the same sign-in.
    const renewed = world.v2.accounts.startSession(username, before.dev, { signedInAt: before.signedInAt, sitting: sid })!
    world.v2.accounts.closeOtherSessionsForDevice(username, before.dev, renewed.jti)
    expect(world.v2.accounts.revokedIds()).not.toContain(sid)
    // The owner changes the password from another device: every other sitting ends.
    const ownerJti = world.v2.accounts.get(username)!.sessions.find((s) => s.dev === owner.device.id)!.jti
    expect((await world.v2.accounts.changePassword(username, PASSWORD, 'an entirely new password', ownerJti)).ok).toBe(true)
    expect(world.v2.accounts.revokedIds()).toContain(sid)
  })

  it('a provider-only account with no passkey is told to set a password first', async () => {
    const { browser } = await fresh({ passwordless: true })
    const options = await browser.registry.post(GRANT_PATHS.options, {})
    expect(options.body).toMatchObject({ needsPassword: true })
    const out = await browser.registry.post(GRANT_PATHS.grant, { password: 'anything at all' })
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'password_required' })
  })

  it('refuses while the account is locked down after "Not me"', async () => {
    const { username, browser } = await fresh()
    world.v2.factors.store.setMustChangePassword(username, true)
    expect((await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })).status).toBe(403)
  })

  it('needs a session: a stranger gets nothing', async () => {
    expect((await httpWithBearer(world.origin, 'nope').post(GRANT_PATHS.grant, { password: PASSWORD })).status).toBe(401)
  })

  it('a provider-only account sets a first password within five minutes of a verification, then enters with it', async () => {
    const { username, browser } = await fresh({ passwordless: true })
    // Five minutes have passed since the sign-in: asked to prove it again.
    const jti = world.v2.accounts.get(username)!.sessions.at(-1)!.jti
    world.v2.accounts.amend(username, (a) => ({ ...a, sessions: a.sessions.map((s) => (s.jti === jti ? { ...s, verifiedAt: Date.now() - 6 * 60_000 } : s)) }))
    const stale = await browser.registry.post('/v2/me/password', { next: 'a brand new long password' })
    expect(stale.status).toBe(403)
    world.v2.accounts.markVerified(username, jti, 'provider')
    const set = await browser.registry.post('/v2/me/password', { next: 'a brand new long password' })
    expect(set.status).toBe(204)
    expect(world.v2.accounts.get(username)?.passwordless).toBe(false)
    const options = await browser.registry.post(GRANT_PATHS.options, {})
    expect(options.body).toMatchObject({ methods: { password: true }, needsPassword: false })
    expect((await browser.registry.post(GRANT_PATHS.grant, { password: 'a brand new long password' })).status).toBe(201)
    // Set once: the next one is a change, which asks for the current password.
    expect((await browser.registry.post('/v2/me/password', { next: 'another long password here' })).status).toBe(401)
  })

  it('wrong tries rest only the device that made them: a stolen session cannot lock the owner’s phone out', async () => {
    const { username, browser } = await fresh()
    const thief = await world.browser(username)
    for (const guess of ['wrong one', 'wrong two', 'wrong three']) await thief.registry.post(GRANT_PATHS.grant, { password: guess })
    expect((await thief.registry.post(GRANT_PATHS.grant, { password: PASSWORD })).status).toBe(429)
    expect((await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })).status).toBe(201)
  })

  it('signing out publishes the sitting, so its pass stops opening machines', async () => {
    const { username, browser } = await fresh()
    const out = await browser.registry.post(GRANT_PATHS.grant, { password: PASSWORD })
    const sid = v2GrantClaimsFor((out.body as { grant: string }).grant, Date.now())!.sid
    world.v2.accounts.closeSession(username, sid)
    expect(world.v2.accounts.revokedIds()).toContain(sid)
  })

  it('an account holding a passkey sets a first password only after the passkey, not a provider alone', async () => {
    const { username, browser } = await fresh({ passwordless: true })
    world.addPasskey(username)
    const jti = world.v2.accounts.get(username)!.sessions.at(-1)!.jti
    world.v2.accounts.markVerified(username, jti, 'provider')
    expect((await browser.registry.post('/v2/me/password', { next: 'a brand new long password' })).status).toBe(403)
    world.v2.accounts.markVerified(username, jti, 'passkey')
    expect((await browser.registry.post('/v2/me/password', { next: 'a brand new long password' })).status).toBe(204)
  })

  it('a revoked device stays revoked however many times people sign out', async () => {
    const { username } = await fresh()
    const gone = await world.browser(username)
    world.v2.accounts.revokeDevice(username, gone.device.id)
    for (let i = 0; i < 250; i += 1) {
      const b = await world.browser(username)
      const jti = world.v2.accounts.get(username)!.sessions.at(-1)!.jti
      world.v2.accounts.closeSession(username, jti)
      expect(b.device.id).toBeTruthy()
    }
    expect(world.v2.accounts.revokedFor(username)).toContain(gone.device.id)
  })
})

describe('POST /v2/me/device-grant/watch (owner 2026-11-09: a watch pairs once)', () => {
  it('gives a watch its pass with no proof, for its own key, in a kind an older machine refuses', async () => {
    const { username } = await fresh()
    const watch = await world.browser(username, 'watch')
    const out = await watch.registry.post(GRANT_PATHS.watch, {})
    expect(out.status).toBe(201)
    const body = out.body as { grant: string; exp: number; deviceId: string }
    expect(body.deviceId).toBe(watch.device.id)
    expect(v2WatchGrantClaimsFor(body.grant, Date.now())).toMatchObject({ username, dev: watch.device.id, jkt: jwkThumbprint(watch.device.jwk), watch: true })
    // A machine that predates watch passes reads it as no pass at all.
    expect(v2GrantClaimsFor(body.grant, Date.now())).toBeNull()
  })

  it('a phone or a browser is not a watch: its pass still takes a proof made now', async () => {
    const { browser } = await fresh()
    const out = await browser.registry.post(GRANT_PATHS.watch, {})
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'not_watch' })
  })

  it('an account locked by Not me gives a watch nothing', async () => {
    const { username } = await fresh()
    const watch = await world.browser(username, 'watch')
    world.v2.factors.store.setMustChangePassword(username, true)
    expect((await watch.registry.post(GRANT_PATHS.watch, {})).status).toBe(403)
  })
})

describe('POST /v2/me/device-grant/machine (owner 2026-11-09: machines on the account trust each other)', () => {
  it('a machine proves itself ONCE (password or passkey, from that machine); after that it needs nothing (security review: kind is self-declared)', async () => {
    const { username } = await fresh()
    const desk = await world.browser(username, 'desktop')
    const bare = await desk.registry.post(GRANT_PATHS.machine, {})
    expect(bare.status).toBe(401)
    expect(bare.body).toMatchObject({ error: 'proof_required' })
    expect((await desk.registry.post(GRANT_PATHS.machine, { password: 'not it' })).status).toBe(401)
    expect((await desk.registry.post(GRANT_PATHS.machine, { password: PASSWORD })).status).toBe(201)
    // Trusted now: the next pass takes no proof, and another desktop of the account is still asked.
    expect((await desk.registry.post(GRANT_PATHS.machine, {})).status).toBe(201)
    const other = await world.browser(username, 'desktop')
    expect((await other.registry.post(GRANT_PATHS.machine, {})).status).toBe(401)
  })

  it('gives a trusted machine its pass with no proof, in a kind an older machine refuses', async () => {
    const { username } = await fresh()
    const desk = await world.browser(username, 'desktop')
    expect((await desk.registry.post(GRANT_PATHS.machine, { password: PASSWORD })).status).toBe(201)
    const out = await desk.registry.post(GRANT_PATHS.machine, {})
    expect(out.status).toBe(201)
    const grant = (out.body as { grant: string }).grant
    expect(v2MachineGrantClaimsFor(grant, Date.now())).toMatchObject({ username, dev: desk.device.id, machine: true })
    expect(v2GrantClaimsFor(grant, Date.now())).toBeNull()
    expect(v2WatchGrantClaimsFor(grant, Date.now())).toBeNull()
  })

  it('a phone, a browser or a watch is not a machine', async () => {
    const { username, browser } = await fresh()
    expect((await browser.registry.post(GRANT_PATHS.machine, {})).body).toMatchObject({ error: 'not_machine' })
    const watch = await world.browser(username, 'watch')
    expect((await watch.registry.post(GRANT_PATHS.machine, {})).status).toBe(403)
  })
})

describe('a machine’s trust ends with the password it was proved under (security review 2026-11-09)', () => {
  it('a password change leaves the machine the owner is on trusted, and asks every other one to prove itself again', async () => {
    const { username } = await fresh()
    const mine = await world.browser(username, 'desktop')
    const theirs = await world.browser(username, 'desktop')
    for (const desk of [mine, theirs]) expect((await desk.registry.post(GRANT_PATHS.machine, { password: PASSWORD })).status).toBe(201)
    const changed = await mine.registry.post('/v2/me/password', { current: PASSWORD, next: 'a brand new long password' })
    expect(changed.status).toBe(204)
    expect((await mine.registry.post(GRANT_PATHS.machine, {})).status).toBe(201)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === theirs.device.id)?.machine).toBeUndefined()
  })

  it('“Not me” takes it from every machine but the one that raised it', () => {
    const username = `untrust${++n}`
    return world.account(username).then(async () => {
      const mine = await world.browser(username, 'desktop')
      const theirs = await world.browser(username, 'desktop')
      for (const desk of [mine, theirs]) await desk.registry.post(GRANT_PATHS.machine, { password: PASSWORD })
      world.v2.accounts.untrustOtherMachines(username, mine.device.id)
      const devices = world.v2.accounts.get(username)?.devices ?? []
      expect(devices.find((d) => d.id === mine.device.id)?.machine).toBe(true)
      expect(devices.find((d) => d.id === theirs.device.id)?.machine).toBeUndefined()
    })
  })
})
