import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getAssertion, p256 as passkeyPair } from './support/webauthn'
import { browserDevice, Client, openWeb, walk, webPasswordless, type Device, type Opened } from './support/auth-site-harness'
import { addAuthenticator, bootClockedSite, codeFor, type ClockedSite } from './support/stepup-site'
import { SESSION_COOKIE } from '../registry/src/v2-http'

/**
 * EVERY SENSITIVE ACT ON /me, FOR AN ACCOUNT WITH NO PASSWORD (me-stepup, 11-09).
 *
 * The owner signs in with a provider and an authenticator. Five minutes after
 * that sign-in, "Set a password", "Delete account", "Add an authenticator" and
 * "Recovery codes" all ask for a proof /me could not make: the page has no
 * password to ask for and cannot make a provider trip. Now /me opens a
 * `step-up` request for the ONE act, the person proves it on auth.cookrew.dev
 * (passkey, else the linked provider, else an authenticator or recovery code),
 * and the proof counts only when the browser that asked spends the code with
 * its verifier and the very session that opened it.
 */

const FIVE_MINUTES = 5 * 60_000
const LATER = FIVE_MINUTES + 60_000
const NEXT = 'a long new account password'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let site: ClockedSite
beforeEach(async () => {
  site = await bootClockedSite()
})
afterEach(() => site.close())

/** The owner, as on 11-09: a provider account with an authenticator, signed in a while ago. */
async function owner(): Promise<{ browser: Client; device: Device; secret: string }> {
  const { browser, device } = await webPasswordless(site, 'anvztor')
  const secret = await addAuthenticator(site, browser)
  site.advance(LATER)
  return { browser, device, secret }
}

const stepUpFor = (site_: ClockedSite, browser: Client, device: Device, act: string): Promise<Opened> =>
  openWeb(site_, browser, device, { intent: 'step-up', act })

async function claim(browser: Client, opened: Opened) {
  const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
  expect(claimed.status, claimed.text).toBe(200)
  return claimed
}

/** The page's provider trip: start, consent, back, continue. */
async function providerTrip(browser: Client, opened: Opened, provider = 'github') {
  const started = await browser.page('POST', `/v2/oauth/${provider}/start`, opened.request, {})
  expect(started.status, started.text).toBe(201)
  const back = await walk(site, String(started.body.authorizeUrl))
  expect(back).toBe(`${site.A}/?request=${encodeURIComponent(opened.request)}&continue=1`)
  return browser.page('POST', '/auth/api/continue', opened.request, {})
}

/** Follow the page's handoff back to cookrew.dev, as the browser does. */
async function land(browser: Client, handoff: unknown, headers: Record<string, string> = {}) {
  const url = new URL(String((handoff as { url: string }).url))
  return browser.call(site.P, 'GET', `${url.pathname}${url.search}`, undefined, headers)
}

/** The act-bound proof id the landing put in the fragment. */
const stepUpOf = (location: unknown): string => {
  const hash = String(location).split('#')[1] ?? ''
  return new URLSearchParams(hash).get('stepup') ?? ''
}

const fresh = async (browser: Client, act: string): Promise<boolean> => {
  const out = await browser.call(site.P, 'GET', `/v2/me/step-up/${act}`)
  expect(out.status, out.text).toBe(200)
  return out.body.fresh === true
}

describe('setting a first password, five minutes after signing in', () => {
  it('goes through the linked provider on the page and comes back to set it', async () => {
    const { browser, device } = await owner()
    // The wall the owner hit: a sentence and nothing to press.
    const refused = await browser.product('POST', '/v2/me/password', { next: NEXT })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe('step_up')
    expect(await fresh(browser, 'change-password')).toBe(false)

    const opened = await stepUpFor(site, browser, device, 'change-password')
    expect(String(opened.body.authorizeUrl)).toBe(`${site.A}/?request=${encodeURIComponent(opened.request)}`)
    const claimed = await claim(browser, opened)
    expect(claimed.body).toMatchObject({
      intent: 'step-up',
      username: 'anvztor',
      step: { act: 'change-password', passkey: false, providers: ['github'], codes: ['totp', 'recovery'] }
    })
    expect(String((claimed.body.step as { sentence: string }).sentence)).toMatch(/password/)

    const continued = await providerTrip(browser, opened)
    expect(continued.status, continued.text).toBe(200)
    expect(continued.body.status).toBe('authorized')
    // The page holds a code for the browser that asked, and nothing else.
    expect(continued.text).not.toMatch(/stepUp|pending|token/)
    // Nothing counts before the asking browser spends it.
    expect(await fresh(browser, 'change-password')).toBe(false)

    const landed = await land(browser, continued.body.handoff)
    expect(landed.status, landed.text).toBe(303)
    expect(String(landed.headers.location)).toMatch(/^\/me\?stepped=change-password#stepup=/)
    const stepUp = stepUpOf(landed.headers.location)
    expect(stepUp).toMatch(UUID)
    expect(await fresh(browser, 'change-password')).toBe(true)
    expect(site.logged).toContain('step-up: proven act=change-password by=provider client=web')

    const set = await browser.product('POST', '/v2/me/password', { next: NEXT, stepUp })
    expect(set.status, set.text).toBe(204)
    expect((await browser.call(site.P, 'GET', '/v2/me')).body.hasPassword).toBe(true)
  })

  it('or with the authenticator, as a rung climbed on the page', async () => {
    const { browser, device, secret } = await owner()
    const opened = await stepUpFor(site, browser, device, 'change-password')
    await claim(browser, opened)
    const ladder = await browser.page('POST', '/auth/api/step-up', opened.request, {})
    expect(ladder.status, ladder.text).toBe(200)
    expect(ladder.body.next).toEqual(['totp', 'recovery'])
    const pending = String(ladder.body.pending)
    const wrong = await browser.page('POST', `/v2/sessions/${pending}/totp`, opened.request, { code: '000000' })
    expect(wrong.status).toBe(401)
    const climbed = await browser.page('POST', `/v2/sessions/${pending}/totp`, opened.request, { code: codeFor(site, secret) })
    expect(climbed.status, climbed.text).toBe(200)
    expect(climbed.body.status).toBe('authorized')
    // Climbed on the page, but the sitting is not proven until it spends the code.
    expect(await fresh(browser, 'change-password')).toBe(false)
    const landed = await land(browser, climbed.body.handoff)
    expect(landed.status).toBe(303)
    expect(site.logged).toContain('step-up: proven act=change-password by=totp client=web')
    const set = await browser.product('POST', '/v2/me/password', { next: NEXT, stepUp: stepUpOf(landed.headers.location) })
    expect(set.status, set.text).toBe(204)
  })

  it('an account with a passkey proves it with the passkey and nothing weaker', async () => {
    const { browser, device } = await owner()
    // A passkey on the account, written straight to the store: the ceremony is another suite's.
    const pair = passkeyPair()
    const credentialId = randomBytes(16)
    const added = site.v2.factors.store.addPasskey('anvztor', {
      credentialId: credentialId.toString('base64url'),
      jwk: pair.publicJwk,
      signCount: 0,
      name: 'Touch ID'
    })
    expect(added.ok).toBe(true)

    const opened = await stepUpFor(site, browser, device, 'change-password')
    const claimed = await claim(browser, opened)
    expect(claimed.body.step).toMatchObject({ passkey: true, providers: [], codes: [] })
    const provider = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    expect(provider.status).toBe(400)
    const ladder = await browser.page('POST', '/auth/api/step-up', opened.request, {})
    expect(ladder.body.next).toEqual(['passkey'])
    const pending = String(ladder.body.pending)
    const totp = await browser.page('POST', `/v2/sessions/${pending}/totp`, opened.request, { code: '123456' })
    expect(totp.status).toBe(400)
    const options = await browser.page('GET', `/v2/sessions/${pending}/passkey/options`, opened.request)
    expect(options.status, options.text).toBe(200)
    const credential = getAssertion({ pair, credentialId, challenge: String(options.body.challenge), origin: site.A, rpId: 'localhost', signCount: 1 })
    const climbed = await browser.page('POST', `/v2/sessions/${pending}/passkey`, opened.request, { credential })
    expect(climbed.status, climbed.text).toBe(200)
    const landed = await land(browser, climbed.body.handoff)
    expect(landed.status).toBe(303)
    const set = await browser.product('POST', '/v2/me/password', { next: NEXT, stepUp: stepUpOf(landed.headers.location) })
    expect(set.status, set.text).toBe(204)
  })
})

describe('the proof belongs to the browser and session that asked', () => {
  it('another browser holding the way back spends nothing, and the code is burned', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const continued = await providerTrip(browser, opened)
    const stranger = await land(new Client(site, 'stranger'), continued.body.handoff)
    expect(stranger.status).toBe(400)
    const own = await land(browser, continued.body.handoff)
    expect(own.status).toBe(400)
    expect(await fresh(browser, 'delete-account')).toBe(false)
  })

  it('a navigation another site started does not spend it, and the browser’s own way back still does', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const continued = await providerTrip(browser, opened)
    const forced = await land(browser, continued.body.handoff, { 'sec-fetch-site': 'cross-site' })
    expect(forced.status).toBe(400)
    expect(forced.text).toContain('another site')
    expect(await fresh(browser, 'delete-account')).toBe(false)
    const own = await land(browser, continued.body.handoff, { 'sec-fetch-site': 'same-site' })
    expect(own.status).toBe(303)
  })

  it('a session that ended before the way back proves nothing', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'add-factor')
    await claim(browser, opened)
    const continued = await providerTrip(browser, opened)
    // The opener signs out on another tab; the same browser signs in again.
    await browser.product('POST', '/v2/sessions/current')
    const landed = await land(browser, continued.body.handoff)
    expect(landed.status).toBe(400)
  })

  it('another session of the same account, in the browser that asked, spends nothing', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const continued = await providerTrip(browser, opened)
    // A second sitting on the same device: the cookie is swapped, the verifier is not.
    const second = site.v2.accounts.startSession('anvztor', device.payload.id)
    expect(second).not.toBeNull()
    const token = site.v2.tokens.mintSession('anvztor', device.payload.id, second!.jti).token
    browser.jar.set(`localhost:${site.port}|${SESSION_COOKIE}`, token)
    const landed = await land(browser, continued.body.handoff)
    expect(landed.status).toBe(400)
    expect(landed.text).toContain('Only the browser and session that asked')
    expect(site.logged).toContain('step-up: refused why=not_the_opener at=spend client=web')
  })

  it('an account that gained a passkey while away needs the passkey for its first password', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'change-password')
    await claim(browser, opened)
    const continued = await providerTrip(browser, opened)
    const pair = passkeyPair()
    site.v2.factors.store.addPasskey('anvztor', { credentialId: randomBytes(16).toString('base64url'), jwk: pair.publicJwk, signCount: 0, name: 'Touch ID' })
    const landed = await land(browser, continued.body.handoff)
    expect(landed.status).toBe(400)
    expect(landed.text).toContain('passkey')
    expect(await fresh(browser, 'change-password')).toBe(false)
  })

  it('the act-bound proof outlives the five minutes it opened, for its own act only', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const landed = await land(browser, (await providerTrip(browser, opened)).body.handoff)
    site.advance(FIVE_MINUTES + 30_000)
    expect(await fresh(browser, 'delete-account')).toBe(false)
    expect([401, 403]).toContain((await browser.product('DELETE', '/v2/me', { confirm: 'anvztor' })).status)
    const gone = await browser.product('DELETE', '/v2/me', { confirm: 'anvztor', stepUp: stepUpOf(landed.headers.location) })
    expect(gone.status, gone.text).toBe(204)
  })

  it('a proof for one act is not a proof for another', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'add-factor')
    await claim(browser, opened)
    const landed = await land(browser, (await providerTrip(browser, opened)).body.handoff)
    const stepUp = stepUpOf(landed.headers.location)
    // Minting a join code is not a five-minute act: only its own proof opens it.
    const join = await browser.product('POST', '/v2/me/join-codes', { stepUp })
    expect([401, 403]).toContain(join.status)
    const codes = await browser.product('POST', '/v2/me/recovery-codes', { stepUp })
    expect(codes.status, codes.text).toBe(201)
  })

  it('a provider identity that is not this account’s proves nothing', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    site.fake.github = { id: 999_999, login: 'someone-else', emails: [{ email: 'else@example.com', primary: true, verified: true }] }
    const continued = await providerTrip(browser, opened)
    expect(continued.status).toBe(403)
    expect(continued.body.error).toBe('wrong_identity')
    expect(String(continued.body.message)).toMatch(/GitHub/)
  })
})

describe('the acts that used to dead-end, start to finish', () => {
  it('deleting the account', async () => {
    const { browser, device } = await owner()
    const refused = await browser.product('DELETE', '/v2/me', { confirm: 'anvztor' })
    expect([401, 403]).toContain(refused.status)
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const landed = await land(browser, (await providerTrip(browser, opened)).body.handoff)
    expect(String(landed.headers.location)).toMatch(/^\/me\?stepped=delete-account#stepup=/)
    const gone = await browser.product('DELETE', '/v2/me', { confirm: 'anvztor', stepUp: stepUpOf(landed.headers.location) })
    expect(gone.status, gone.text).toBe(204)
  })

  it('adding a machine with a join code', async () => {
    const { browser, device, secret } = await owner()
    const refused = await browser.product('POST', '/v2/me/join-codes', {})
    expect([401, 403]).toContain(refused.status)
    const opened = await stepUpFor(site, browser, device, 'mint-join-code')
    await claim(browser, opened)
    const ladder = await browser.page('POST', '/auth/api/step-up', opened.request, {})
    const climbed = await browser.page('POST', `/v2/sessions/${String(ladder.body.pending)}/totp`, opened.request, { code: codeFor(site, secret) })
    const landed = await land(browser, climbed.body.handoff)
    const minted = await browser.product('POST', '/v2/me/join-codes', { stepUp: stepUpOf(landed.headers.location) })
    expect(minted.status, minted.text).toBe(201)
  })

  it('showing recovery codes rides the five minutes the proof opened', async () => {
    const { browser, device } = await owner()
    expect((await browser.product('POST', '/v2/me/recovery-codes', {})).status).not.toBe(201)
    const opened = await stepUpFor(site, browser, device, 'add-factor')
    await claim(browser, opened)
    await land(browser, (await providerTrip(browser, opened)).body.handoff)
    expect((await browser.product('POST', '/v2/me/recovery-codes', {})).status).toBe(201)
    // The authenticator is already on, so its enrolment says so — past the gate.
    expect((await browser.product('POST', '/v2/me/totp/enrol', {})).body.error).not.toBe('step_up')
    expect((await browser.product('POST', '/v2/me/recovery-codes', {})).status).toBe(201)
    site.advance(LATER)
    expect((await browser.product('POST', '/v2/me/recovery-codes', {})).status).not.toBe(201)
  })
})

describe('guessing a code on the page costs what a sign-in costs', () => {
  it('a request opens at most three ladders, and a sitting five a minute', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const statuses: number[] = []
    for (let at = 0; at < 4; at += 1) statuses.push((await browser.page('POST', '/auth/api/step-up', opened.request, {})).status)
    expect(statuses).toEqual([200, 200, 200, 429])
    // Fresh requests from the same sitting run into the per-sitting budget.
    const more: number[] = []
    for (let at = 0; at < 3; at += 1) {
      const again = await stepUpFor(site, browser, device, 'delete-account')
      await claim(browser, again)
      more.push((await browser.page('POST', '/auth/api/step-up', again.request, {})).status)
    }
    expect(more).toEqual([200, 200, 429])
  })
})

describe('after "not me"', () => {
  it('a provider proof for the password mints its pending but opens no five minutes', async () => {
    const { browser, device } = await owner()
    site.v2.factors.store.setMustChangePassword('anvztor', true)
    const opened = await stepUpFor(site, browser, device, 'change-password')
    await claim(browser, opened)
    const landed = await land(browser, (await providerTrip(browser, opened)).body.handoff)
    expect(landed.status).toBe(303)
    expect(await fresh(browser, 'change-password')).toBe(false)
    const set = await browser.product('POST', '/v2/me/password', { next: NEXT, stepUp: stepUpOf(landed.headers.location) })
    expect(set.status, set.text).toBe(204)
  })
})

describe('opening a step-up request', () => {
  it('needs the web session, on its own device, for an act /me performs', async () => {
    const { browser, device } = await owner()
    const anon = await new Client(site, 'anon').product('POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act: 'delete-account', device: device.payload })
    expect(anon.status).toBe(401)
    const other = await browser.product('POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act: 'delete-account', device: browserDevice('Other').payload })
    expect(other.status).toBe(403)
    expect(other.body.error).toBe('not_this_device')
    for (const act of [undefined, 'take-over-door', 'nonsense']) {
      const bad = await browser.product('POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act, device: device.payload })
      expect(bad.status, String(act)).toBe(400)
    }
    const desktop = await browser.product('POST', '/v2/auth/requests', {
      client: 'desktop',
      intent: 'step-up',
      act: 'delete-account',
      device: device.payload,
      challenge: 'a'.repeat(43),
      state: 'b'.repeat(16),
      back: { scheme: true }
    })
    expect(desktop.status).toBe(400)
  })

  it('reaches no sign-in on the page, only the ladder rungs and the provider', async () => {
    const { browser, device } = await owner()
    const opened = await stepUpFor(site, browser, device, 'delete-account')
    await claim(browser, opened)
    const signIn = await browser.page('POST', '/v2/sessions', opened.request, { username: 'anvztor', password: 'x' })
    expect(signIn.status).toBe(404)
    const account = await browser.page('POST', '/v2/accounts', opened.request, { username: 'x', password: 'y' })
    expect(account.status).toBe(404)
  })

  it('after "not me" refuses every act but setting the password', async () => {
    const { browser, device } = await owner()
    site.v2.factors.store.setMustChangePassword('anvztor', true)
    const del = await browser.product('POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act: 'delete-account', device: device.payload })
    expect(del.status).toBe(403)
    expect(del.body.error).toBe('password_change_required')
    const set = await browser.product('POST', '/v2/auth/requests', { client: 'web', intent: 'step-up', act: 'change-password', device: device.payload })
    expect(set.status, set.text).toBe(201)
  })

  it('the freshness question answers only for the caller’s own sitting', async () => {
    const anon = await new Client(site, 'anon').call(site.P, 'GET', '/v2/me/step-up/delete-account')
    expect(anon.status).toBe(401)
    const { browser } = await webPasswordless(site, 'mira')
    expect(await fresh(browser, 'delete-account')).toBe(true)
    expect((await browser.call(site.P, 'GET', '/v2/me/step-up/nonsense')).status).toBe(404)
    // Never fresh for an act that always asks.
    expect(await fresh(browser, 'mint-join-code')).toBe(false)
  })
})
