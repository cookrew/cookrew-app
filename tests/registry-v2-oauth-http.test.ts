import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { fakeOAuth, loopbackOnly, pkce, returnOf, walkBrowser, type FakeOAuth } from './support/fake-oauth'

/**
 * THIRD-PARTY SIGN-IN OVER HTTP — the real router, a fake provider on loopback.
 *
 * Each case is a design rule from the owner's brief or a trap the design doc
 * names: OAuth replaces the password step and nothing after it.
 */

const PASSWORD = 'correct horse battery staple'
const device = (name = 'MacBook Pro', kind: 'desktop' | 'browser' = 'desktop') => ({
  id: randomUUID(),
  kind,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

let dir: string
let server: Server
let origin: string
let fake: FakeOAuth
let v2: V2Identity

async function boot(configured = true): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-oauth-'))
  fake = await fakeOAuth()
  v2 = createV2(dir, { secondStep: 'legacy', freshWindowMs: 0, 
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000 },
    ...(configured ? { oauth: fake.config() } : {})
  })
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = loopbackOnly(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
}

async function halt(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
}

const call = async (
  method: string,
  url: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${origin}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }
}

interface Trip {
  verifier: string
  handoff: string
  state: string
}

/** Start a flow and walk the browser to the handoff. */
async function trip(provider: string, extra: Record<string, unknown> = {}, token?: string): Promise<Trip> {
  const { verifier, challenge, state } = pkce()
  const started = await call('POST', `/v2/oauth/${provider}/start`, { state, challenge, back: { scheme: true, port: 53111 }, ...extra }, token)
  expect(started.status).toBe(201)
  const walked = await walkBrowser(String(started.body.authorizeUrl))
  const back = returnOf(walked.page)
  expect(back.state).toBe(state)
  return { verifier, handoff: back.handoff ?? '', state }
}

const redeem = (t: Trip, dev: unknown, token?: string) =>
  call('POST', '/v2/oauth/redeem', { handoff: t.handoff, verifier: t.verifier, device: dev }, token)

/** A brand-new passwordless account. Answers its token. */
async function claimByProvider(provider: string, username: string, dev = device()): Promise<{ token: string; dev: typeof dev }> {
  const t = await trip(provider)
  const asked = await redeem(t, dev)
  expect(asked.body.status).toBe('new')
  const made = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username, device: dev })
  expect(made.status).toBe(201)
  return { token: String(made.body.token), dev }
}

/** A password account with one device. */
async function claimByPassword(username: string): Promise<{ token: string; dev: ReturnType<typeof device> }> {
  const dev = device()
  const made = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: dev })
  expect(made.status).toBe(201)
  return { token: String((made.body.session as { token: string }).token), dev }
}

/** Link from a signed-in password account. */
async function link(token: string, provider = 'github'): Promise<void> {
  const t = await trip(provider, { intent: 'link', current: PASSWORD }, token)
  const linked = await redeem(t, undefined, token)
  expect(linked.status).toBe(200)
  expect(linked.body.status).toBe('linked')
}

describe('with no client id and secret', () => {
  beforeEach(() => boot(false))
  afterEach(halt)

  it('offers no providers and every route answers off, and password sign-in is untouched', async () => {
    const listed = await call('GET', '/v2/oauth/providers')
    expect(listed.status).toBe(200)
    expect(listed.body.providers).toEqual([])
    const { state, challenge } = pkce()
    const started = await call('POST', '/v2/oauth/github/start', { state, challenge, back: { scheme: true } })
    expect(started.status).toBe(404)
    await claimByPassword('alice')
  })
})

describe('configured', () => {
  beforeEach(() => boot(true))
  afterEach(halt)

  it('lists both providers and never the secret', async () => {
    const listed = await call('GET', '/v2/oauth/providers')
    expect(listed.body.providers).toEqual([
      { id: 'github', label: 'GitHub', device: true },
      { id: 'google', label: 'Google', device: false }
    ])
    expect(JSON.stringify(listed.body)).not.toContain('secret')
  })

  it('asks for minimal scopes, with PKCE and state, on the registry callback', async () => {
    const { state, challenge } = pkce()
    await call('POST', '/v2/oauth/github/start', { state, challenge, back: { scheme: true } }).then(async (s) =>
      walkBrowser(String(s.body.authorizeUrl))
    )
    const asked = fake.authorized[0]
    expect(asked.get('scope')).toBe('read:user user:email')
    expect(asked.get('code_challenge_method')).toBe('S256')
    expect(asked.get('code_challenge')).not.toBe(challenge)
    expect(asked.get('state')).not.toBe(state)
    expect(new URL(asked.get('redirect_uri') ?? '').pathname).toBe('/v2/oauth/github/callback')
    const s = pkce()
    await call('POST', '/v2/oauth/google/start', { state: s.state, challenge: s.challenge, back: { scheme: true } }).then(
      async (r) => walkBrowser(String(r.body.authorizeUrl))
    )
    expect(fake.authorized[1].get('scope')).toBe('openid email')
  })

  it('refuses a return target that is not the scheme or a loopback port', async () => {
    const { state, challenge } = pkce()
    for (const back of [{}, { port: 80 }, { port: 'x' }, { scheme: false }, { url: 'https://evil.example' }]) {
      const refused = await call('POST', '/v2/oauth/github/start', { state, challenge, back })
      expect(refused.status).toBe(400)
    }
  })

  it('a new identity creates nothing until a handle is chosen, and the provider name only prefills it', async () => {
    const dev = device()
    const t = await trip('github')
    const asked = await redeem(t, dev)
    expect(asked.status).toBe(200)
    expect(asked.body).toMatchObject({ status: 'new', suggest: 'octo-cat', free: true, provider: 'github' })
    expect(v2.accounts.has('octo-cat')).toBe(false)
    const made = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username: 'mine', device: dev })
    expect(made.status).toBe(201)
    expect(made.body.username).toBe('mine')
    expect(v2.accounts.has('octo-cat')).toBe(false)
  })

  it('a clash asks again on the same ticket, and a legacy-free reserved name is refused', async () => {
    await claimByPassword('octo-cat')
    const dev = device()
    const asked = await redeem(await trip('github'), dev)
    expect(asked.body).toMatchObject({ suggest: 'octo-cat', free: false })
    const clash = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username: 'octo-cat', device: dev })
    expect(clash.status).toBe(409)
    const reserved = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username: 'acct-x', device: dev })
    expect(reserved.status).toBe(400)
    const done = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username: 'octo-two', device: dev })
    expect(done.status).toBe(201)
    const spent = await call('POST', '/v2/oauth/claim', { ticket: asked.body.ticket, username: 'octo-three', device: device() })
    expect(spent.status).toBe(410)
  })

  it('never auto-merges by email and never reveals that the email is taken', async () => {
    const { token } = await claimByPassword('alice')
    v2.links.setEmail('alice', { address: 'octo@example.com', via: 'google', verifiedAt: 1 })
    const asked = await redeem(await trip('github'), device())
    expect(asked.body.status).toBe('new')
    expect(JSON.stringify(asked.body)).not.toContain('alice')
    const me = await call('GET', '/v2/me', undefined, token)
    expect(me.body.links).toEqual([])
  })

  it('keeps only a verified email, and skips the noreply address', async () => {
    fake.github = {
      id: 9,
      login: 'unverified',
      emails: [
        { email: 'real@example.com', primary: true, verified: false },
        { email: '9+unverified@users.noreply.github.com', primary: false, verified: true }
      ]
    }
    const { token } = await claimByProvider('github', 'unverified')
    const me = await call('GET', '/v2/me', undefined, token)
    expect(me.body.email).toBeNull()
    expect(me.body.hasPassword).toBe(false)
    fake.github = { id: 10, login: 'ok', emails: [{ email: 'ok@example.com', primary: true, verified: true }] }
    const second = await claimByProvider('github', 'okay')
    const mine = await call('GET', '/v2/me', undefined, second.token)
    expect(mine.body.email).toMatchObject({ address: 'ok@example.com', via: 'github' })
    expect(mine.body.links).toMatchObject([{ provider: 'github', login: 'ok', paused: false }])
    const stranger = await call('GET', '/v2/accounts/okay')
    expect(JSON.stringify(stranger.body)).not.toContain('ok@example.com')
    expect(JSON.stringify(stranger.body)).not.toContain('github')
  })

  it('Google: an unverified email is dropped, and a wrong audience, issuer or nonce is refused', async () => {
    fake.google = { sub: '7', email: 'g@example.com', email_verified: false }
    const { token } = await claimByProvider('google', 'gina')
    expect((await call('GET', '/v2/me', undefined, token)).body.email).toBeNull()
    for (const claims of [{ aud: 'someone-else' }, { iss: 'https://evil.example' }, { nonce: 'stale' }, { exp: 1 }]) {
      fake.googleClaims = claims
      const { state, challenge } = pkce()
      const started = await call('POST', '/v2/oauth/google/start', { state, challenge, back: { scheme: true } })
      const walked = await walkBrowser(String(started.body.authorizeUrl))
      expect(returnOf(walked.page).error).toBe('provider')
    }
  })

  it('a known device on a no-factor account lands a session, with the username', async () => {
    const { dev } = await claimByProvider('github', 'octo')
    const again = await redeem(await trip('github'), dev)
    expect(again.status).toBe(201)
    expect(again.body).toMatchObject({ username: 'octo', deviceId: dev.id })
  })

  it('A NEW DEVICE STILL CLIMBS THE LADDER, and the approved rung attaches through the same path', async () => {
    const { token } = await claimByProvider('github', 'octo')
    const stranger = device('Second Mac')
    const answered = await redeem(await trip('github'), stranger)
    expect(answered.status).toBe(401)
    expect(answered.body.error).toBe('second_factor')
    expect(answered.body.next).toEqual(['approve'])
    expect(v2.accounts.get('octo')?.devices.some((d) => d.id === stranger.id)).toBe(false)
    const pending = String(answered.body.pending)
    const asked = await call('POST', `/v2/sessions/${pending}/approve`, {})
    const decided = await call('POST', `/v2/me/approvals/${String(asked.body.approval)}`, { decision: 'approve', match: answered.body.match }, token)
    expect(decided.status).toBe(204)
    const landed = await call('GET', `/v2/sessions/${pending}`)
    expect(landed.status).toBe(201)
    expect(landed.body.username).toBe('octo')
    expect(v2.accounts.get('octo')?.devices.some((d) => d.id === stranger.id)).toBe(true)
  })

  it('a password account stays on the password path; linking is manual and step-up gated', async () => {
    const { token, dev } = await claimByPassword('alice')
    const { state, challenge } = pkce()
    const bare = await call('POST', '/v2/oauth/github/start', { intent: 'link', state, challenge, back: { scheme: true } }, token)
    expect(bare.status).toBe(403)
    const wrong = await call('POST', '/v2/oauth/github/start', { intent: 'link', state, challenge, back: { scheme: true }, current: 'nope nope nope' }, token)
    expect(wrong.status).toBe(401)
    const anon = await call('POST', '/v2/oauth/github/start', { intent: 'link', state, challenge, back: { scheme: true }, current: PASSWORD })
    expect(anon.status).toBe(401)
    await link(token)
    const me = await call('GET', '/v2/me', undefined, token)
    expect(me.body.hasPassword).toBe(true)
    expect(me.body.email).toMatchObject({ address: 'octo@example.com', via: 'github' })
    const byProvider = await redeem(await trip('github'), dev)
    expect(byProvider.status).toBe(201)
    expect(byProvider.body.username).toBe('alice')
    const password = await call('POST', '/v2/sessions', { username: 'alice', password: PASSWORD, device: dev })
    expect(password.status).toBe(201)
  })

  it('a link flow must be finished by the session that began it', async () => {
    const first = await claimByPassword('alice')
    const other = await claimByPassword('bob')
    const t = await trip('github', { intent: 'link', current: PASSWORD }, first.token)
    expect((await redeem(t, undefined)).status).toBe(401)
    const t2 = await trip('github', { intent: 'link', current: PASSWORD }, first.token)
    expect((await redeem(t2, undefined, other.token)).status).toBe(403)
    expect(v2.links.ownerOf('github', '583231')).toBeNull()
  })

  it('one identity, one account', async () => {
    const first = await claimByPassword('alice')
    const other = await claimByPassword('bob')
    await link(first.token)
    const t = await trip('github', { intent: 'link', current: PASSWORD }, other.token)
    const refused = await redeem(t, undefined, other.token)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('link_taken')
    expect(JSON.stringify(refused.body)).not.toContain('alice')
  })

  it('every device is told about a link', async () => {
    const { token } = await claimByPassword('alice')
    await link(token)
    const events = await call('GET', '/v2/me/events?since=0', undefined, token)
    expect(JSON.stringify(events.body)).toContain('linked')
  })

  it('handoffs are single use and bound to the verifier', async () => {
    const t = await trip('github')
    const stolen = await call('POST', '/v2/oauth/redeem', { handoff: t.handoff, verifier: pkce().verifier, device: device() })
    expect(stolen.status).toBe(401)
    const afterTheft = await redeem(t, device())
    expect(afterTheft.status).toBe(401)
    const t2 = await trip('github')
    expect((await redeem(t2, device())).status).toBe(200)
    expect((await redeem(t2, device())).status).toBe(401)
  })

  it('state is single use and a forged callback reaches no provider', async () => {
    const { state, challenge } = pkce()
    const started = await call('POST', '/v2/oauth/github/start', { state, challenge, back: { scheme: true } })
    const consent = await fetch(String(started.body.authorizeUrl), { redirect: 'manual' })
    const callback = consent.headers.get('location') ?? ''
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(200)
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(400)
    const forged = await fetch(`${origin}/v2/oauth/github/callback?code=x&state=${'a'.repeat(43)}`, { redirect: 'manual' })
    expect(forged.status).toBe(400)
  })

  it('the return page is uncached, referrer-free and script-free, and offers the loopback fallback', async () => {
    const { state, challenge } = pkce()
    const started = await call('POST', '/v2/oauth/github/start', { state, challenge, back: { scheme: true, port: 53111 } })
    const walked = await walkBrowser(String(started.body.authorizeUrl))
    expect(walked.headers.get('cache-control')).toContain('no-store')
    expect(walked.headers.get('referrer-policy')).toBe('no-referrer')
    expect(walked.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(walked.page).toContain('cookrew://oauth#')
    expect(walked.page).toContain('http://127.0.0.1:53111/oauth/return?')
    expect(walked.page).not.toContain('<script')
  })

  it('a denied consent goes back as an error, with no handoff', async () => {
    fake.denyNext()
    const { state, challenge } = pkce()
    const started = await call('POST', '/v2/oauth/github/start', { state, challenge, back: { scheme: true } })
    const walked = await walkBrowser(String(started.body.authorizeUrl))
    expect(returnOf(walked.page)).toMatchObject({ handoff: null, error: 'denied', state })
  })

  it('stores no provider token and no secret', async () => {
    await claimByProvider('github', 'octo')
    const file = readFileSync(path.join(dir, 'accounts-v2.json'), 'utf8')
    expect(file).not.toContain('gh-secret')
    expect(file).not.toContain('access_token')
    expect(file).toContain('583231')
  })

  it('a passwordless account refuses every password, at the same door', async () => {
    const { dev } = await claimByProvider('github', 'octo')
    const answer = await call('POST', '/v2/sessions', { username: 'octo', password: PASSWORD, device: dev })
    expect(answer.status).toBe(401)
    expect(answer.body.error).toBe('bad_credentials')
  })

  it('RECOVERY CODES STILL WORK when the provider account is lost', async () => {
    const { token } = await claimByProvider('github', 'octo')
    const proved = await redeem(await trip('github', { intent: 'step-up', act: 'add-factor' }, token), undefined, token)
    const minted = await call('POST', '/v2/me/recovery-codes', { stepUp: proved.body.stepUp }, token)
    const codes = minted.body.codes as string[]
    const stranger = device('After the loss')
    const rescued = await call('POST', '/v2/recovery', { username: 'octo', code: codes[0], device: stranger })
    expect(rescued.status).toBe(201)
    expect(v2.accounts.get('octo')?.devices.some((d) => d.id === stranger.id)).toBe(true)
  })

  describe('step-up on a passwordless account', () => {
    it('a provider round trip proves one act, once', async () => {
      const { token } = await claimByProvider('github', 'octo')
      const refused = await call('POST', '/v2/me/join-codes', {}, token)
      expect(refused.status).toBe(403)
      expect(refused.body).toMatchObject({ error: 'provider_required', providers: ['github'] })
      const t = await trip('github', { intent: 'step-up', act: 'mint-join-code' }, token)
      const proved = await redeem(t, undefined, token)
      expect(proved.status).toBe(200)
      const stepUp = proved.body.stepUp
      expect(typeof stepUp).toBe('string')
      const minted = await call('POST', '/v2/me/join-codes', { stepUp }, token)
      expect(minted.status).toBe(201)
      const replay = await call('POST', '/v2/me/join-codes', { stepUp }, token)
      expect(replay.status).toBe(403)
    })

    it('the proof must come from a linked identity, and is for one act', async () => {
      const { token, dev } = await claimByProvider('github', 'octo')
      fake.github = { id: 2, login: 'other', emails: [] }
      const t = await trip('github', { intent: 'step-up', act: 'revoke-device' }, token)
      const refused = await redeem(t, undefined, token)
      expect(refused.status).toBe(403)
      expect(refused.body.error).toBe('wrong_identity')
      fake.github = { id: 583231, login: 'Octo-Cat', emails: [] }
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'mint-join-code' }, token), undefined, token)
      const wrongAct = await call('DELETE', `/v2/me/devices/${dev.id}`, { stepUp: proved.body.stepUp }, token)
      expect(wrongAct.status).toBe(403)
    })

    it('a factor can be removed with a proof, since there is no password to send', async () => {
      const { token } = await claimByProvider('github', 'octo')
      const added = await redeem(await trip('github', { intent: 'step-up', act: 'add-factor' }, token), undefined, token)
      const begun = await call('POST', '/v2/me/totp/enrol', { stepUp: added.body.stepUp }, token)
      expect(begun.status).toBe(201)
      const bare = await call('DELETE', '/v2/me/totp', {}, token)
      expect(bare.status).toBe(403)
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'remove-factor' }, token), undefined, token)
      const removed = await call('DELETE', '/v2/me/totp', { stepUp: proved.body.stepUp }, token)
      expect(removed.status).toBe(204)
    })
  })

  describe('"not me"', () => {
    async function strangerAsks(): Promise<{ owner: string; approval: string; pending: string }> {
      const { token } = await claimByProvider('github', 'octo')
      const answered = await redeem(await trip('github'), device('Stranger'))
      const pending = String(answered.body.pending)
      const asked = await call('POST', `/v2/sessions/${pending}/approve`, {})
      return { owner: token, approval: String(asked.body.approval), pending }
    }

    it('on a provider sign-in pauses that link and never takes the password lock', async () => {
      const { owner, approval } = await strangerAsks()
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'not-me' }, owner), undefined, owner)
      const alarm = await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me', stepUp: proved.body.stepUp }, owner)
      expect(alarm.status).toBe(204)
      expect(v2.factors.store.mustChangePassword('octo')).toBe(false)
      const paused = await redeem(await trip('github'), device('Stranger again'))
      expect(paused.status).toBe(403)
      expect(paused.body.error).toBe('link_paused')
      const me = await call('GET', '/v2/me', undefined, owner)
      expect(me.body.links).toMatchObject([{ provider: 'github', paused: true }])
    })

    it('a paused link is cleared by linking it again from a signed-in session', async () => {
      const { owner, approval } = await strangerAsks()
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'not-me' }, owner), undefined, owner)
      await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me', stepUp: proved.body.stepUp }, owner)
      const again = await redeem(await trip('github', { intent: 'step-up', act: 'link-provider' }, owner), undefined, owner)
      const t = await trip('github', { intent: 'link', stepUp: again.body.stepUp }, owner)
      expect((await redeem(t, undefined, owner)).body.status).toBe('linked')
      const me = await call('GET', '/v2/me', undefined, owner)
      expect(me.body.links).toMatchObject([{ provider: 'github', paused: false }])
    })

    it('a password sign-in on a linked account still locks the password, as today', async () => {
      const { token } = await claimByPassword('alice')
      await link(token)
      const opened = await call('POST', '/v2/sessions', { username: 'alice', password: PASSWORD, device: device('Stranger') })
      const asked = await call('POST', `/v2/sessions/${String(opened.body.pending)}/approve`, {})
      const alarm = await call('POST', `/v2/me/approvals/${String(asked.body.approval)}`, { decision: 'not-me', current: PASSWORD }, token)
      expect(alarm.status).toBe(204)
      expect(v2.factors.store.mustChangePassword('alice')).toBe(true)
      expect(v2.links.ownerOf('github', '583231')).toBe('alice')
      const byProvider = await redeem(await trip('github'), device('Elsewhere'))
      expect(byProvider.status).toBe(403)
      expect(byProvider.body.error).toBe('password_change_required')
    })
  })

  describe('unlinking', () => {
    it('is step-up gated, tells every device, and leaves the account able to sign in', async () => {
      const { token } = await claimByPassword('alice')
      await link(token)
      expect((await call('DELETE', '/v2/me/links/github', {}, token)).status).toBe(403)
      expect((await call('DELETE', '/v2/me/links/github', { current: PASSWORD }, token)).status).toBe(204)
      expect(v2.links.ownerOf('github', '583231')).toBeNull()
    })

    it('refuses to remove the last way in', async () => {
      const { token } = await claimByProvider('github', 'octo')
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'unlink-provider' }, token), undefined, token)
      const refused = await call('DELETE', '/v2/me/links/github', { stepUp: proved.body.stepUp }, token)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toBe('last_sign_in')
    })
  })

  describe('review: the last way in', () => {
    async function twoLinks(): Promise<string> {
      const { token } = await claimByProvider('github', 'octo')
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'link-provider' }, token), undefined, token)
      const t = await trip('google', { intent: 'link', stepUp: proved.body.stepUp }, token)
      expect((await redeem(t, undefined, token)).body.status).toBe('linked')
      return token
    }

    it('a paused link is not a way in, so the working one stays', async () => {
      const token = await twoLinks()
      v2.links.pause('octo', 'github', '583231')
      const proved = await redeem(await trip('google', { intent: 'step-up', act: 'unlink-provider' }, token), undefined, token)
      const refused = await call('DELETE', '/v2/me/links/google', { stepUp: proved.body.stepUp }, token)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toBe('last_sign_in')
    })

    it('a passkey does not stand in for the last link: the desktop could prove nothing after it', async () => {
      const { token } = await claimByProvider('github', 'octo')
      const account = v2.accounts.get('octo')
      if (account === null) throw new Error('no account')
      expect(v2.links.isLastWayIn(account, 'github')).toBe(true)
      expect(token).not.toBe('')
    })

    it('with two working links either may go', async () => {
      const token = await twoLinks()
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'unlink-provider' }, token), undefined, token)
      expect((await call('DELETE', '/v2/me/links/google', { stepUp: proved.body.stepUp }, token)).status).toBe(204)
    })
  })

  describe('review: one id, one key', () => {
    const otherKey = { kty: 'OKP', crv: 'Ed25519', x: 'YmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8' }

    it('a known device id with a new key does not skip the ladder or replace the key', async () => {
      const { dev } = await claimByProvider('github', 'octo')
      const answered = await redeem(await trip('github'), { ...dev, jwk: otherKey })
      expect(answered.status).toBe(400)
      expect(answered.body.error).toBe('bad_device')
      expect(v2.accounts.get('octo')?.devices[0].jwk.x).toBe(dev.jwk.x)
    })

    it('the password door refuses it the same way', async () => {
      const { dev } = await claimByPassword('alice')
      const answered = await call('POST', '/v2/sessions', { username: 'alice', password: PASSWORD, device: { ...dev, jwk: otherKey } })
      expect(answered.status).toBe(400)
      expect(v2.accounts.get('alice')?.devices[0].jwk.x).toBe(dev.jwk.x)
    })

    it('the same key on the same id still signs in', async () => {
      const { dev } = await claimByProvider('github', 'octo')
      expect((await redeem(await trip('github'), dev)).status).toBe(201)
    })
  })

  describe('review: a stolen session on a passwordless account', () => {
    it('cannot mint rescue codes or enrol a factor on the bearer alone', async () => {
      const { token } = await claimByProvider('github', 'octo')
      expect((await call('POST', '/v2/me/recovery-codes', {}, token)).status).toBe(403)
      expect((await call('POST', '/v2/me/totp/enrol', {}, token)).status).toBe(403)
      expect((await call('POST', '/v2/me/passkeys/options', {}, token)).status).toBe(403)
      expect(v2.accounts.get('octo')?.recovery).toHaveLength(0)
    })

    it('a proof from the provider opens each one, once', async () => {
      const { token } = await claimByProvider('github', 'octo')
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'add-factor' }, token), undefined, token)
      const minted = await call('POST', '/v2/me/recovery-codes', { stepUp: proved.body.stepUp }, token)
      expect(minted.status).toBe(201)
      expect((await call('POST', '/v2/me/recovery-codes', { stepUp: proved.body.stepUp }, token)).status).toBeGreaterThanOrEqual(400)
    })

    it('a password account mints with its password (auth UX 2026-11-09: adding a factor asks every account)', async () => {
      const { token } = await claimByPassword('alice')
      expect((await call('POST', '/v2/me/recovery-codes', {}, token)).status).toBeGreaterThanOrEqual(400)
      expect((await call('POST', '/v2/me/recovery-codes', { current: PASSWORD }, token)).status).toBe(201)
    })

    it('a proof earned by one session cannot be spent by another of the same account', async () => {
      const { token, dev } = await claimByProvider('github', 'octo')
      const other = await redeem(await trip('github'), dev)
      const proved = await redeem(await trip('github', { intent: 'step-up', act: 'mint-join-code' }, token), undefined, token)
      const spent = await call('POST', '/v2/me/join-codes', { stepUp: proved.body.stepUp }, String(other.body.token))
      expect(spent.status).toBeGreaterThanOrEqual(400)
      expect((await call('POST', '/v2/me/join-codes', { stepUp: proved.body.stepUp }, token)).status).toBe(201)
    })
  })

  it('"not me" voids a join code in flight on a passwordless account', async () => {
    const { token } = await claimByProvider('github', 'octo')
    const proved = await redeem(await trip('github', { intent: 'step-up', act: 'mint-join-code' }, token), undefined, token)
    const minted = await call('POST', '/v2/me/join-codes', { stepUp: proved.body.stepUp }, token)
    const answered = await redeem(await trip('github'), device('Stranger'))
    const asked = await call('POST', `/v2/sessions/${String(answered.body.pending)}/approve`, {})
    const alarm = await redeem(await trip('github', { intent: 'step-up', act: 'not-me' }, token), undefined, token)
    await call('POST', `/v2/me/approvals/${String(asked.body.approval)}`, { decision: 'not-me', stepUp: alarm.body.stepUp }, token)
    expect((await call('POST', '/v2/join', { code: minted.body.code, device: device('Thief') })).status).toBe(401)
  })

  it('a code-joined machine is told the account has no password', async () => {
    const { token } = await claimByProvider('github', 'octo')
    const proved = await redeem(await trip('github', { intent: 'step-up', act: 'mint-join-code' }, token), undefined, token)
    const minted = await call('POST', '/v2/me/join-codes', { stepUp: proved.body.stepUp }, token)
    const joined = await call('POST', '/v2/join', { code: minted.body.code, device: device('Second Mac') })
    expect(joined.status).toBe(201)
    expect(joined.body.hasPassword).toBe(false)
  })

  describe('GitHub device flow', () => {
    const begin = async (): Promise<{ flow: string; verifier: string; body: Record<string, unknown> }> => {
      const { verifier, challenge } = pkce()
      const started = await call('POST', '/v2/oauth/github/device', { challenge })
      expect(started.status).toBe(201)
      return { flow: String(started.body.flow), verifier, body: started.body }
    }

    it('keeps the device code in the registry and hands out only the user code', async () => {
      const { body } = await begin()
      expect(body.userCode).toBe('WDJB-MJHT')
      expect(typeof body.verificationUri).toBe('string')
      expect(JSON.stringify(body)).not.toContain('dev-code-secret')
    })

    it('polls to a ticket for a new identity, sending no client secret', async () => {
      const { flow, verifier } = await begin()
      const dev = device('Headless box')
      const waiting = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: dev })
      expect(waiting.status).toBe(202)
      expect(waiting.body.status).toBe('pending')
      v2.oauth.flows.allowPollNow(flow)
      fake.device.answer = 'ok'
      const done = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: dev })
      expect(done.status).toBe(200)
      expect(done.body.status).toBe('new')
      expect(fake.device.lastBody?.get('client_secret')).toBeNull()
    })

    it('hands a device flow no email: whoever holds the code may not be the person who approved', async () => {
      const { flow, verifier } = await begin()
      fake.device.answer = 'ok'
      const done = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device() })
      expect(done.body.status).toBe('new')
      expect(JSON.stringify(done.body)).not.toContain('octo@example.com')
    })

    it('keeps that email off the account too, so the claim cannot read it back', async () => {
      const { flow, verifier } = await begin()
      fake.device.answer = 'ok'
      const dev = device('Headless box')
      const done = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: dev })
      const made = await call('POST', '/v2/oauth/claim', { ticket: done.body.ticket, username: 'headless', device: dev })
      expect(made.status).toBe(201)
      const me = await call('GET', '/v2/me', undefined, String(made.body.token))
      expect(me.body.email).toBeNull()
      expect(JSON.stringify(v2.accounts.get('headless'))).not.toContain('octo@example.com')
    })

    it('holds the poll to the provider interval, whoever is asking', async () => {
      const { flow, verifier } = await begin()
      await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device() })
      await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device() })
      expect(fake.device.polls).toBe(1)
    })

    it('a linked identity on a new device still climbs the ladder', async () => {
      await claimByProvider('github', 'octo')
      const { flow, verifier } = await begin()
      fake.device.answer = 'ok'
      const answered = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device('Headless box') })
      expect(answered.status).toBe(401)
      expect(answered.body.error).toBe('second_factor')
    })

    it('needs the verifier, and reports a denial once', async () => {
      const { flow, verifier } = await begin()
      const wrong = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier: pkce().verifier, device: device() })
      expect(wrong.status).toBe(401)
      fake.device.answer = 'denied'
      const denied = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device() })
      expect(denied.status).toBe(410)
      const gone = await call('POST', `/v2/oauth/device/${flow}/poll`, { verifier, device: device() })
      expect(gone.status).toBe(410)
    })

    it('Google offers no device flow', async () => {
      const { challenge } = pkce()
      expect((await call('POST', '/v2/oauth/google/device', { challenge })).status).toBe(404)
    })
  })
})
