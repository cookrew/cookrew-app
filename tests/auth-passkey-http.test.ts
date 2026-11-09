import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getAssertion, GET_FLAGS_VERIFIED, makeCredential, p256 as passkeyPair, type Pair } from './support/webauthn'
import {
  bearer,
  bootAuthSite,
  browserDevice,
  Client,
  codeOf,
  desktopDevice,
  openDesktop,
  openWeb,
  passwordAccount,
  passwordlessAccount,
  walk,
  webPasswordless,
  PASSWORD,
  type AuthSite,
  type Opened
} from './support/auth-site-harness'

/**
 * ADDING A PASSKEY HAPPENS ON AUTH.COOKREW.DEV.
 *
 * The owner's account has no password (it was made with a provider), so every
 * "add a way back in" asks for a fresh provider round trip first — and neither
 * /me nor the desktop could make one, so "Add a passkey" could only ever be
 * refused. The page can: the client that is signed in opens a `passkey`
 * request, the page proves it is the owner with the provider (one use, act
 * `add-factor`), runs navigator.credentials.create with rpId = the product's
 * host, and the passkey is written only when that same signed-in client spends
 * the code that comes back.
 */

let site: AuthSite
beforeEach(async () => {
  site = await bootAuthSite({ freshWindowMs: 0 })
})
afterEach(() => site.close())

/** The page's half of the ceremony: options, the authenticator, the attestation. */
async function makePasskey(browser: Client, opened: Opened, pair: Pair = passkeyPair(), credentialId = randomBytes(16)) {
  const options = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
  expect(options.status, options.text).toBe(200)
  const credential = makeCredential({ pair, credentialId, challenge: String(options.body.challenge), origin: site.A, rpId: 'localhost' })
  const made = await browser.page('POST', '/auth/api/passkey', opened.request, { name: 'Touch ID on this Mac', credential })
  return { options, made, pair, credentialId }
}

/** The page's provider step-up: start, consent, back, continue. */
async function stepUp(browser: Client, opened: Opened, provider = 'github') {
  const started = await browser.page('POST', `/v2/oauth/${provider}/start`, opened.request, {})
  expect(started.status, started.text).toBe(201)
  const back = await walk(site, String(started.body.authorizeUrl))
  expect(back).toBe(`${site.A}/?request=${encodeURIComponent(opened.request)}&continue=1`)
  return browser.page('POST', '/auth/api/continue', opened.request, {})
}

/** Sign in on the auth origin with a passkey: the proof the passkey is real. */
async function signInWithPasskey(pair: Pair, credentialId: Buffer) {
  const app = new Client(site, 'second-app')
  const opened = await openDesktop(site, app, desktopDevice('Second Mac'))
  const browser = new Client(site, 'sign-in-browser')
  await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
  const asked = await browser.page('GET', '/v2/sessions/passkey/options', opened.request)
  expect(asked.body.rpId).toBe('localhost')
  const assertion = getAssertion({ pair, credentialId, challenge: String(asked.body.challenge), origin: site.A, rpId: 'localhost', signCount: 1, flags: GET_FLAGS_VERIFIED })
  return browser.page('POST', '/v2/sessions/passkey', opened.request, { credential: assertion })
}

const passkeysOf = async (token: string) =>
  ((await new Client(site).call(site.P, 'GET', '/v2/me/factors', undefined, bearer(token))).body.passkeys as { name: string }[]) ?? []

describe('a passwordless account adds a passkey from the desktop', () => {
  it('proves it with the provider on the page, makes the passkey there, and the app writes it', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body).toMatchObject({ intent: 'passkey', username: 'anvztor', enrol: { needs: 'provider', providers: ['github'] } })

    // No ceremony before the proof, and the refusal says what to do.
    const early = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    expect(early.status).toBe(403)
    expect(early.body).toMatchObject({ error: 'step_up', providers: ['github'] })
    expect(String(early.body.message)).toMatch(/GitHub/)

    const continued = await stepUp(browser, opened)
    expect(continued.status, continued.text).toBe(200)
    expect(continued.body).toMatchObject({ status: 'ready', enrol: { needs: 'ready' } })
    // The proof never reaches the page: it is held on the request.
    expect(continued.text).not.toMatch(/stepUp|pending/)

    const { options, made, pair, credentialId } = await makePasskey(browser, opened)
    expect(options.body.rp).toEqual({ id: 'localhost', name: 'Cookrew' })
    expect((options.body.user as { name: string }).name).toBe('anvztor')
    expect(made.status, made.text).toBe(200)
    expect(made.body.status).toBe('authorized')
    // Finishing the page writes nothing: the opener does, with its session.
    expect(await passkeysOf(owner.token)).toEqual([])
    const spent = await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier }, bearer(owner.token))
    expect(spent.status, spent.text).toBe(201)
    expect(spent.body).toMatchObject({ status: 'passkey', passkey: { name: 'Touch ID on this Mac' } })
    expect((await passkeysOf(owner.token)).map((p) => p.name)).toEqual(['Touch ID on this Mac'])

    // The same passkey signs in on the auth origin: one rpId for both hosts.
    const signedIn = await signInWithPasskey(pair, credentialId)
    expect(signedIn.status, signedIn.text).toBe(200)
    expect(signedIn.body.status).toBe('authorized')
  })

  it('the proof is spent by the passkey it allowed: a second ceremony on the request is refused', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await stepUp(browser, opened)
    const first = await makePasskey(browser, opened)
    expect(first.made.status).toBe(200)
    const again = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    expect(again.status).toBe(410)
  })

  it('a ceremony that fails keeps the proof, so the person can try again without another trip', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await stepUp(browser, opened)
    const options = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    // Made for another origin: not this page's ceremony.
    const credential = makeCredential({ pair: passkeyPair(), credentialId: randomBytes(16), challenge: String(options.body.challenge), origin: 'https://evil.example', rpId: 'localhost' })
    const refused = await browser.page('POST', '/auth/api/passkey', opened.request, { name: 'x', credential })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('passkey_refused')
    expect(String(refused.body.message)).toMatch(/Try again/)
    const retry = await makePasskey(browser, opened)
    expect(retry.made.status).toBe(200)
  })

  it('a ceremony the browser refused is logged by the error’s name and nothing else', async () => {
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect((await browser.page('POST', '/auth/api/passkey', opened.request, { failed: 'NotAllowedError' })).status).toBe(204)
    expect((await browser.page('POST', '/auth/api/passkey', opened.request, { failed: '<script>' })).status).toBe(204)
    expect(site.logged).toContain('passkey enrolment: browser refused why=NotAllowedError client=desktop')
    expect(site.logged).toContain('passkey enrolment: browser refused why=unknown client=desktop')
    // Another browser holding the link is not this page, and logs nothing.
    const before = site.logged.length
    expect((await new Client(site, 'thief').page('POST', '/auth/api/passkey', opened.request, { failed: 'NotAllowedError' })).status).toBe(410)
    expect(site.logged.length).toBe(before)
  })

  it('a provider identity that is not this account’s proves nothing, and says which to use', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    site.fake.github = { id: 999, login: 'someone-else', emails: [{ email: 'else@example.com', primary: true, verified: true }] }
    const continued = await stepUp(browser, opened)
    expect(continued.status).toBe(403)
    expect(continued.body.error).toBe('wrong_identity')
    expect(String(continued.body.message)).toMatch(/GitHub/)
    expect((await browser.page('POST', '/auth/api/passkey/options', opened.request, {})).status).toBe(403)
    expect(site.logged).toContain('passkey enrolment: step-up refused why=wrong_identity client=desktop')
  })

  it('a provider the account never linked is refused before the trip', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const started = await browser.page('POST', '/v2/oauth/google/start', opened.request, {})
    expect(started.status).toBe(400)
    expect(String(started.body.message)).toMatch(/GitHub/)
  })

  it('a code spent without the opener’s session writes nothing', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await stepUp(browser, opened)
    const { made } = await makePasskey(browser, opened)
    const stolen = await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier })
    expect(stolen.status).toBe(401)
    expect(await passkeysOf(owner.token)).toEqual([])
    expect(site.logged).toContain('passkey enrolment: refused why=not_the_opener at=spend client=desktop')
  })

  it('the sign-in ladder is not reachable from a passkey request', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect((await browser.page('POST', '/v2/sessions', opened.request, { username: 'anvztor', password: 'x' })).status).toBe(404)
    expect((await browser.page('GET', '/v2/sessions/passkey/options', opened.request)).status).toBe(404)
  })

  it('logs every step of an enrolment and names no person, request or key', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    site.logged.length = 0
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    await stepUp(browser, opened)
    const { made } = await makePasskey(browser, opened)
    await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier }, bearer(owner.token))
    expect(site.logged).toEqual([
      'auth request opened: client=desktop intent=passkey',
      'passkey enrolment: refused why=step_up at=options client=desktop',
      'passkey enrolment: step-up proven provider=github client=desktop',
      'passkey enrolment: made client=desktop',
      'auth request finished: client=desktop intent=passkey status=201',
      'passkey enrolment: added client=desktop'
    ])
    expect(site.logged.join('\n')).not.toMatch(/anvztor|[A-Za-z0-9_-]{43}/)
  })
})

describe('refused before a browser makes anything', () => {
  it('an account at its passkey limit hears so at options, not after Touch ID', async () => {
    const owner = await passwordAccount(site, 'drej')
    for (let n = 0; n < 20; n += 1) {
      const added = site.v2.factors.store.addPasskey('drej', { credentialId: `cred-${n}`, jwk: { kty: 'EC' }, name: `key ${n}`, signCount: 0 })
      expect(added.ok).toBe(true)
    }
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const options = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    expect(options.status).toBe(409)
    expect(options.body.error).toBe('passkey_limit')
  })

  it('a session that ended meanwhile stops the trip and the ceremony with what to do', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect((await app.call(site.P, 'DELETE', '/v2/sessions/current', undefined, bearer(owner.token))).status).toBeLessThan(300)
    const started = await browser.page('POST', '/v2/oauth/github/start', opened.request, {})
    expect(started.status).toBe(401)
    expect(String(started.body.message)).toMatch(/Sign in again/)
    const options = await browser.page('POST', '/auth/api/passkey/options', opened.request, {})
    expect(options.status).toBe(401)
    expect(options.body.error).toBe('session_over')
  })
})

describe('a password account adds a passkey from the desktop', () => {
  it('needs no provider trip — the same threshold as /v2/me — and is written by the app', async () => {
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site, 'app')
    const opened = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body).toMatchObject({ intent: 'passkey', username: 'drej', enrol: { needs: 'ready', providers: [] } })
    const { made } = await makePasskey(browser, opened)
    expect(made.status, made.text).toBe(200)
    const spent = await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(made.body.handoff).code, verifier: opened.verifier }, bearer(owner.token))
    expect(spent.status).toBe(201)
    expect((await passkeysOf(owner.token)).length).toBe(1)
  })

  it('is refused under the not-me alarm, with what to do', async () => {
    const owner = await passwordAccount(site, 'drej')
    site.v2.factors.store.setMustChangePassword('drej', true)
    const app = new Client(site, 'app')
    const { challenge, state } = { challenge: 'a'.repeat(43), state: 'b'.repeat(16) }
    const opened = await app.call(site.P, 'POST', '/v2/auth/requests', {
      client: 'desktop', intent: 'passkey', device: owner.device.payload, challenge, state, back: { scheme: true }
    }, bearer(owner.token))
    expect(opened.status).toBe(403)
    expect(opened.body.error).toBe('password_change_required')
    expect(String(opened.body.message)).toMatch(/change it/)
  })
})

describe('opening a passkey request', () => {
  it('needs a session, on the device it belongs to, from the app or the web', async () => {
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site, 'app')
    const body = { client: 'desktop', intent: 'passkey', challenge: 'a'.repeat(43), state: 'b'.repeat(16), back: { scheme: true } }
    const anon = await app.call(site.P, 'POST', '/v2/auth/requests', { ...body, device: owner.device.payload })
    expect(anon.status).toBe(401)
    const other = await app.call(site.P, 'POST', '/v2/auth/requests', { ...body, device: desktopDevice().payload }, bearer(owner.token))
    expect(other.status).toBe(403)
    expect(other.body.error).toBe('not_this_device')
    expect(String(other.body.message)).toMatch(/signed in/)
    const terminal = await app.call(site.P, 'POST', '/v2/auth/requests', { client: 'cli', intent: 'passkey', device: owner.device.payload, challenge: 'a'.repeat(43) }, bearer(owner.token))
    expect(terminal.status).toBe(400)
  })

  it('is a 404 with the auth origin off, so cookrew.dev falls back to its own button', async () => {
    await site.close()
    site = await bootAuthSite({ auth: false, freshWindowMs: 0 })
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site, 'app')
    const off = await app.call(site.P, 'POST', '/v2/auth/requests', { client: 'desktop', intent: 'passkey', device: owner.device.payload }, bearer(owner.token))
    expect(off.status).toBe(404)
  })
})

describe('a passwordless account adds a passkey from cookrew.dev', () => {
  it('goes to the page with its cookie session and lands back on /me with the passkey written', async () => {
    const { browser, device } = await webPasswordless(site, 'anvztor')
    const opened = await openWeb(site, browser, device, { intent: 'passkey' })
    const claimed = await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    expect(claimed.body).toMatchObject({ intent: 'passkey', returnHost: `localhost:${site.port}`, enrol: { needs: 'provider' } })
    await stepUp(browser, opened)
    const { made, pair, credentialId } = await makePasskey(browser, opened)
    const handoff = made.body.handoff as { kind: string; url: string }
    expect(handoff.kind).toBe('web')
    const url = new URL(handoff.url)
    // Another browser holding the link is refused, and that burns the code.
    const stranger = await new Client(site, 'stranger').call(site.P, 'GET', `${url.pathname}${url.search}`)
    expect(stranger.status).toBe(400)
    expect((await browser.call(site.P, 'GET', '/v2/me/factors')).body.passkeys).toEqual([])
    void pair
    void credentialId
  })

  it('the browser that started it writes the passkey and lands on /me saying so', async () => {
    const { browser, device } = await webPasswordless(site, 'anvztor')
    const opened = await openWeb(site, browser, device, { intent: 'passkey' })
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await stepUp(browser, opened)
    const { made, pair, credentialId } = await makePasskey(browser, opened)
    const url = new URL(String((made.body.handoff as { url: string }).url))
    const landed = await browser.call(site.P, 'GET', `${url.pathname}${url.search}`)
    expect(landed.status, landed.text).toBe(303)
    expect(landed.headers.location).toBe('/me?passkey=added#security')
    const factors = await browser.call(site.P, 'GET', '/v2/me/factors')
    expect((factors.body.passkeys as { name: string }[]).map((p) => p.name)).toEqual(['Touch ID on this Mac'])
    expect(site.logged).toContain('passkey enrolment: added client=web')
    const signedIn = await signInWithPasskey(pair, credentialId)
    expect(signedIn.body.status).toBe('authorized')
  })

  it('a link from another site carrying the code writes nothing, and keeps the code unspent', async () => {
    const { browser, device } = await webPasswordless(site, 'anvztor')
    const opened = await openWeb(site, browser, device, { intent: 'passkey' })
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    await stepUp(browser, opened)
    const { made } = await makePasskey(browser, opened)
    const url = new URL(String((made.body.handoff as { url: string }).url))
    const forced = await browser.call(site.P, 'GET', `${url.pathname}${url.search}`, undefined, { 'sec-fetch-site': 'cross-site' })
    expect(forced.status).toBe(400)
    expect(forced.text).toContain('another site')
    expect((await browser.call(site.P, 'GET', '/v2/me/factors')).body.passkeys).toEqual([])
    expect(site.logged).toContain('passkey enrolment: refused why=cross_site at=complete client=web')
    // Unspent: the browser's own same-site way back still lands it.
    const own = await browser.call(site.P, 'GET', `${url.pathname}${url.search}`, undefined, { 'sec-fetch-site': 'same-site' })
    expect(own.status).toBe(303)
    expect(((await browser.call(site.P, 'GET', '/v2/me/factors')).body.passkeys as unknown[]).length).toBe(1)
  })

  it('a passkey already on the account is refused at the page with a sentence', async () => {
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site, 'app')
    const pair = passkeyPair()
    const credentialId = randomBytes(16)
    const first = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: first.request })
    const one = await makePasskey(browser, first, pair, credentialId)
    await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(one.made.body.handoff).code, verifier: first.verifier }, bearer(owner.token))
    const second = await openDesktop(site, app, owner.device, { intent: 'passkey' }, bearer(owner.token))
    const browser2 = new Client(site, 'browser2')
    await browser2.page('POST', '/auth/api/claim', null, { request: second.request })
    const two = await makePasskey(browser2, second, pair, credentialId)
    expect(two.made.status).toBe(409)
    expect(two.made.body.error).toBe('passkey_known')
    expect(String(two.made.body.message)).toMatch(/already/)
  })
})

describe('the old /me route', () => {
  it('still asks a passwordless account for the proof it cannot bring, and the refusal is logged', async () => {
    const owner = await passwordlessAccount(site, 'anvztor')
    site.logged.length = 0
    const options = await new Client(site).call(site.P, 'POST', '/v2/me/passkeys/options', {}, bearer(owner.token))
    expect([401, 403]).toContain(options.status)
    expect(site.logged).toEqual([`passkey enrolment: refused why=${String(options.body.error)} at=me-options`])
  })

  it('a password account adds one there as before', async () => {
    const owner = await passwordAccount(site, 'drej')
    const app = new Client(site)
    const options = await app.call(site.P, 'POST', '/v2/me/passkeys/options', { current: PASSWORD }, bearer(owner.token))
    expect(options.status).toBe(200)
    const credential = makeCredential({ pair: passkeyPair(), credentialId: randomBytes(16), challenge: String(options.body.challenge), origin: site.P, rpId: 'localhost' })
    const added = await app.call(site.P, 'POST', '/v2/me/passkeys', { name: 'Touch ID', credential }, bearer(owner.token))
    expect(added.status).toBe(201)
    expect(site.logged).toContain('passkey enrolment: added at=me')
    void PASSWORD
    void browserDevice
  })
})
