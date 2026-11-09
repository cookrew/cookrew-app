import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { GRANT_TTL_MS } from '../registry/src/v2-tokens'
import { v2GrantClaimsFor } from '../src/main/v2-call-token'
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

  it('takes a password or passkey verification made in the last five minutes, and nothing older or weaker', async () => {
    const { username, browser } = await fresh()
    // Signed in by passkey just now (grant-world): fresh.
    expect((await browser.registry.post(GRANT_PATHS.grant, {})).status).toBe(201)
    const jti = world.v2.accounts.get(username)!.sessions.at(-1)!.jti
    world.v2.accounts.markVerified(username, jti, 'provider')
    expect((await browser.registry.post(GRANT_PATHS.grant, {})).status).toBe(401)
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
})
