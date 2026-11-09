import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { Accounts, accountFilePath, deviceIdFor, loadAccount, unlockVerifierFor, writeAccount, type FetchLike } from '../src/main/account-v2'
import { accountHandlers, accountStatus, type AccountIpcDeps } from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { parseOAuthReturn } from '../src/main/account-oauth'
import { listenForReturn } from '../src/main/oauth-loopback'
import type { DoorSeats, ServedTeamRef } from '../src/main/door-seats'
import { connect } from 'node:net'
import { fakeOAuth, loopbackOnly, walkBrowser, returnOf, type FakeOAuth } from './support/fake-oauth'

/**
 * THE APP'S HALF OF A PROVIDER SIGN-IN — a real registry, a fake provider, and
 * the real account class over HTTP. Nothing here reaches beyond loopback: the
 * registry is named per test and passes through `loopbackOnly`, so a pane's
 * COOKREW_REGISTRY cannot pull a credential to production.
 */

const PASSWORD = 'correct horse battery staple'
const PASSCODE = '482913'

let dir: string
let homes: string[]
let server: Server
let origin: string
let fake: FakeOAuth
let v2: V2Identity

async function boot(configured = true): Promise<void> {
  dir = mkdtempSync(path.join(tmpdir(), 'oauth-reg-'))
  homes = []
  fake = await fakeOAuth()
  v2 = createV2(dir, { secondStep: 'legacy', 
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000, joinCodesPerHour: 1000 },
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

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

interface Mac {
  app: Accounts
  home: string
  /** What the system browser was asked to open. */
  opened: string[]
}

/**
 * A Mac whose browser answers at once: consent, callback, and the return page
 * handed back through the scheme, as the OS would.
 */
/**
 * A MAC THAT CHOSE A PASSCODE before the ruling of 2026-11-09, written the way
 * the old app wrote it. Such a Mac keeps unlocking with it until the account
 * password is typed there; no new machine is ever put in this state.
 */
function choosePasscodeAsBefore(m: Mac, passcode: string, over: { fetch?: FetchLike } = {}): Mac {
  const held = loadAccount(m.home)
  if (held === null) throw new Error('no account to give a passcode')
  writeAccount({ ...held, unlockBy: 'passcode', unlock: unlockVerifierFor(passcode) }, m.home)
  return mac('MacBook Pro', { ...over, home: m.home })
}

function mac(name = 'MacBook Pro', over: { fetch?: FetchLike; home?: string; viaLoopback?: boolean } = {}): Mac {
  const home = over.home ?? mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
  homes.push(home)
  const opened: string[] = []
  const app: Accounts = new Accounts({
    base: home,
    origin,
    deviceName: name,
    ...(over.fetch ? { fetch: over.fetch } : {}),
    openBrowser: async (url) => {
      opened.push(url)
      const walked = await walkBrowser(url)
      if (over.viaLoopback) {
        const link = /href="(http:\/\/127\.0\.0\.1:[^"]+)"/.exec(walked.page)?.[1] ?? ''
        await fetch(link.replaceAll('&amp;', '&'))
        return
      }
      const back = returnOf(walked.page)
      const fields = new URLSearchParams({
        ...(back.handoff ? { handoff: back.handoff } : {}),
        ...(back.error ? { error: back.error } : {}),
        state: back.state ?? ''
      })
      app.oauthReturn(`cookrew://oauth#${fields.toString()}`)
    }
  })
  return { app, home, opened }
}

/** A new passwordless account, on this Mac. */
async function joinByGithub(m: Mac, username = 'octo'): Promise<void> {
  const asked = await m.app.providerSignIn('github')
  expect(asked).toMatchObject({ ok: false, reason: 'new_identity' })
  const made = await m.app.providerClaim(username)
  expect(made.ok).toBe(true)
}

/** Rescue codes on a passwordless account: minted under a provider proof. */
async function codesFor(m: Mac): ReturnType<Accounts['recoveryCodes']> {
  const proved = await m.app.providerProve('add-factor')
  if (!proved.ok) throw new Error(`no proof: ${proved.reason}`)
  return m.app.recoveryCodes({ stepUp: proved.value })
}

describe('with no provider configured', () => {
  beforeEach(() => boot(false))

  it('lists none, and an old or silent registry reads the same', async () => {
    expect(await mac().app.providers()).toEqual([])
    const old = mac('Old', { fetch: () => Promise.resolve(new Response('', { status: 404 })) })
    expect(await old.app.providers()).toEqual([])
    const gone = mac('Gone', { fetch: () => Promise.reject(new Error('offline')) })
    expect(await gone.app.providers()).toEqual([])
  })
})

describe('configured', () => {
  beforeEach(() => boot(true))

  it('lists what the registry offers', async () => {
    expect((await mac().app.providers()).map((p) => p.id)).toEqual(['github', 'google'])
  })

  describe('a new identity', () => {
    it('writes nothing until a handle is chosen, then writes a file with no secret from the provider', async () => {
      const m = mac()
      const asked = await m.app.providerSignIn('github')
      expect(asked).toMatchObject({ ok: false, reason: 'new_identity', suggest: 'octo-cat', free: true })
      expect(existsSync(accountFilePath(m.home))).toBe(false)
      const made = await m.app.providerClaim('octo')
      expect(made.ok).toBe(true)
      const file = readFileSync(accountFilePath(m.home), 'utf8')
      expect(file).not.toContain('gh-secret')
      const held = loadAccount(m.home)
      expect(held).toMatchObject({ username: 'octo', unlock: null, passwordless: true })
      expect(held?.unlockBy).toBeUndefined()
    })

    it('a clash stays on the question, and the ticket never reaches the answer', async () => {
      const first = mac('First')
      await first.app.claim({ username: 'octo-cat', password: PASSWORD })
      const m = mac()
      const asked = await m.app.providerSignIn('github')
      expect(asked).toMatchObject({ reason: 'new_identity', free: false })
      expect(JSON.stringify(asked)).not.toContain('ticket')
      const taken = await m.app.providerClaim('octo-cat')
      expect(taken).toMatchObject({ ok: false, reason: 'taken' })
      expect((await m.app.providerClaim('octo-two')).ok).toBe(true)
    })

    it('opens the system browser and only on an https or loopback address', async () => {
      const m = mac()
      await m.app.providerSignIn('github')
      expect(m.opened).toHaveLength(1)
      const hostile = mac('Hostile', {
        fetch: (input, init) =>
          String(input).endsWith('/start')
            ? Promise.resolve(Response.json({ authorizeUrl: 'file:///etc/passwd' }, { status: 201 }))
            : fetch(input, init)
      })
      expect(await hostile.app.providerSignIn('github')).toMatchObject({ ok: false, reason: 'unknown' })
      expect(hostile.opened).toEqual([])
    })
  })

  describe('the way back', () => {
    it('comes through the loopback listener when the scheme does not', async () => {
      const m = mac('Loop', { viaLoopback: true })
      expect(await m.app.providerSignIn('github')).toMatchObject({ reason: 'new_identity' })
    })

    it('ignores a return it did not start, and keeps waiting for the real one', async () => {
      const forged = `cookrew://oauth#${new URLSearchParams({ handoff: 'x', state: 'y'.repeat(32) }).toString()}`
      const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
      homes.push(home)
      let droppedMidTrip: boolean | null = null
      const app: Accounts = new Accounts({
        base: home,
        origin,
        openBrowser: async (url) => {
          droppedMidTrip = app.oauthReturn(forged)
          const back = returnOf((await walkBrowser(url)).page)
          app.oauthReturn(`cookrew://oauth#handoff=${back.handoff}&state=${back.state}`)
        }
      })
      expect(app.oauthReturn(forged)).toBe(false)
      expect(await app.providerSignIn('github')).toMatchObject({ reason: 'new_identity' })
      expect(droppedMidTrip).toBe(false)
    })

    it('a cancelled consent answers as cancelled and writes nothing', async () => {
      fake.denyNext()
      const m = mac()
      expect(await m.app.providerSignIn('github')).toMatchObject({ ok: false, reason: 'cancelled' })
      expect(existsSync(accountFilePath(m.home))).toBe(false)
    })

    it('cancelling from the app ends the wait', async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
      homes.push(home)
      const app = new Accounts({ base: home, origin, openBrowser: () => Promise.resolve() })
      const waiting = app.providerSignIn('github')
      await vi.waitFor(() => expect(app.providerCancel()).toBe(true))
      expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' })
    })

    it('parses only the one shape', () => {
      expect(parseOAuthReturn('cookrew://oauth#handoff=a&state=b')).toEqual({ handoff: 'a', state: 'b', error: null })
      expect(parseOAuthReturn('cookrew://oauth#error=denied&state=b')).toEqual({ handoff: null, state: 'b', error: 'denied' })
      expect(parseOAuthReturn('cookrew://oauth?handoff=a&state=b')).toBeNull()
      expect(parseOAuthReturn('cookrew://oauth/x#handoff=a&state=b')).toBeNull()
      expect(parseOAuthReturn('cookrew://join#handoff=a&state=b')).toBeNull()
      expect(parseOAuthReturn('https://oauth#handoff=a&state=b')).toBeNull()
      expect(parseOAuthReturn('cookrew://oauth#handoff=a')).toBeNull()
      expect(parseOAuthReturn('not a url')).toBeNull()
    })
  })

  describe('a second Mac', () => {
    it('climbs the same ladder and lands with no verifier', async () => {
      const first = mac('First')
      await joinByGithub(first)
      const second = mac('Second')
      const asked = await second.app.providerSignIn('github')
      expect(asked).toMatchObject({ ok: false, reason: 'second_factor' })
      expect(existsSync(accountFilePath(second.home))).toBe(false)
      if (asked.ok || asked.reason !== 'second_factor') throw new Error('expected a ladder')
      const pending = asked.step.pending
      const sent = await second.app.resumeAsk(pending)
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error('not asked')
      const decided = await first.app.call(`/v2/me/approvals/${sent.value.approval}`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', match: asked.step.match }),
        parse: false
      })
      expect(decided.ok).toBe(true)
      const landed = await second.app.resumeWait(pending, { everyMs: 5 })
      expect(landed.ok).toBe(true)
      expect(loadAccount(second.home)).toMatchObject({ username: 'octo', unlock: null })
      expect(second.app.lockWaits()).toBe('set-password')
    })
  })

  describe('a Mac that already holds the account', () => {
    it('resumes an ended session with the same device, and the passcode stays', async () => {
      const joined = mac()
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      const before = loadAccount(m.home)
      const ended = loadAccount(m.home)?.session?.token ?? ''
      await m.app.call('/v2/sessions/current', { method: 'POST', parse: false })
      expect(ended).not.toBe('')
      const resumed = await m.app.providerSignIn('github')
      expect(resumed.ok).toBe(true)
      const after = loadAccount(m.home)
      expect(after?.deviceId).toBe(before?.deviceId)
      expect(after?.session?.token).not.toBe(ended)
      expect(after?.unlock).toEqual(before?.unlock)
    })

    it('a different identity is refused and never offers a claim', async () => {
      const m = mac()
      await joinByGithub(m)
      fake.github = { id: 77, login: 'stranger', emails: [] }
      expect(await m.app.providerSignIn('github')).toMatchObject({ ok: false, reason: 'wrong_identity' })
    })
  })

  describe('no separate passcode (owner, 2026-11-09)', () => {
    it('a provider-joined Mac is never put in passcode mode: its lock waits for an account password', async () => {
      const m = mac()
      await joinByGithub(m)
      expect(m.app.account()?.unlockBy).toBeUndefined()
      expect(m.app.lockWaits()).toBe('set-password')
      expect(m.app.lockable()).toBe(false)
      expect(m.app.passwordPending()).toBe(false)
      expect(m.app.setPasscode(PASSCODE)).toMatchObject({ ok: false, reason: 'not_offered' })
    })

    it('a password account’s provider-joined Mac takes the account password, and resume writes it as the lock', async () => {
      const first = mac('First')
      await first.app.claim({ username: 'alice', password: PASSWORD })
      const linked = await first.app.providerLink('github', { current: PASSWORD })
      expect(linked.ok).toBe(true)
      const third = mac('Third')
      const asked = await third.app.providerSignIn('github')
      if (asked.ok || asked.reason !== 'second_factor') throw new Error('expected a ladder')
      const sent = await third.app.resumeAsk(asked.step.pending)
      if (!sent.ok) throw new Error('not asked')
      await first.app.call(`/v2/me/approvals/${sent.value.approval}`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', match: asked.step.match }),
        parse: false
      })
      expect((await third.app.resumeWait(asked.step.pending, { everyMs: 5 })).ok).toBe(true)
      // Nothing asked up front: the first unlock checks the password through
      // this Mac's own session (account-ipc.ts · firstUnlock).
      expect(third.app.lockWaits()).toBeNull()
      expect(third.app.passwordPending()).toBe(true)
      expect(third.app.lockable()).toBe(true)
      await third.app.call('/v2/sessions/current', { method: 'POST', parse: false })
      expect((await third.app.resume(PASSWORD)).ok).toBe(true)
      expect(third.app.verifyUnlock(PASSWORD)).toBe(true)
    })

    it('a code-joined Mac on a passwordless account waits for the account password, never a passcode', async () => {
      const first = mac('First')
      await joinByGithub(first)
      const proved = await first.app.providerProve('mint-join-code')
      if (!proved.ok) throw new Error('no proof')
      const code = await first.app.mintJoinCode({ stepUp: proved.value })
      if (!code.ok) throw new Error(`no code: ${code.reason}`)
      const second = mac('Second')
      expect((await second.app.join({ code: code.value.code })).ok).toBe(true)
      expect(second.app.passwordPending()).toBe(false)
      expect(second.app.lockWaits()).toBe('set-password')
    })

    it('a Mac waiting for a passcode it never chose is read as a terminal machine with no lock secret', async () => {
      const m = mac()
      await joinByGithub(m)
      const held = loadAccount(m.home)
      if (held === null) throw new Error('no account')
      writeAccount({ ...held, unlockBy: 'passcode', unlock: null }, m.home)
      const again = mac('MacBook Pro', { home: m.home })
      expect(again.app.account()?.unlockBy).toBeUndefined()
      expect(again.app.isFromTerminal()).toBe(true)
      expect(again.app.lockWaits()).toBe('set-password')
    })

    it('a chosen passcode keeps working; a rescue code spends it and the account password takes over', async () => {
      const joined = mac()
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      expect(m.app.verifyUnlock(PASSCODE)).toBe(true)
      expect(readFileSync(accountFilePath(m.home), 'utf8')).not.toContain(PASSCODE)
      const codes = await codesFor(m)
      if (!codes.ok) throw new Error('no codes')
      expect(await m.app.rescuePasscode('NOT-A-CODE')).toMatchObject({ ok: false })
      expect((await m.app.rescuePasscode(codes.value[0])).ok).toBe(true)
      expect(m.app.verifyUnlock(PASSCODE)).toBe(false)
      expect(m.app.account()?.unlockBy).toBeUndefined()
      expect(m.app.lockWaits()).toBe('set-password')
    })
  })

  describe('the lock channels', () => {
    function wired(m: Mac, over: Partial<AccountIpcDeps> = {}): { deps: AccountIpcDeps; handlers: ReturnType<typeof accountHandlers> } {
      const lock = new IdleLock({
        lockAfterMs: 60_000,
        verify: (typed) => m.app.verifyUnlock(typed),
        armed: () => m.app.lockable()
      })
      const deps: AccountIpcDeps = {
        accounts: m.app,
        lock,
        requests: new Requests({ accounts: m.app, notify: () => undefined }),
        factors: new Factors({ accounts: m.app, registry: origin }),
        envUsername: null,
        workspaces: () => [],
        saveCodes: () => Promise.resolve({ ok: false }),
        ...over
      }
      return { deps, handlers: accountHandlers(deps) }
    }

    it('A PASSCODE NEVER LEAVES THIS MAC, even with the session dead', async () => {
      const sent: string[] = []
      const spied: FetchLike = (input, init) => {
        sent.push(`${String(input)} ${String(init?.body ?? '')}`)
        return fetch(input, init)
      }
      const joined = mac('Spied', { fetch: spied })
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE, { fetch: spied })
      await m.app.call('/v2/sessions/current', { method: 'POST', parse: false })
      const held = m.app.account()
      if (held === null) throw new Error('no account')
      await m.app.call('/v2/nothing')
      const { deps, handlers } = wired(m)
      deps.lock.lock()
      sent.length = 0
      const answer = await handlers['account:unlock'](PASSCODE)
      expect(answer).toMatchObject({ ok: true })
      expect(sent).toEqual([])
    })

    it('the idle lock stays disarmed until the account has a password, and says so', async () => {
      const m = mac()
      await joinByGithub(m)
      const { deps, handlers } = wired(m)
      deps.lock.lock()
      expect(deps.lock.locked).toBe(false)
      expect(accountStatus(deps)).toMatchObject({ lockWaits: 'set-password', fromTerminal: false, passwordPending: false, passwordless: true })
      // The same first-password path as the security card; its result is this Mac's lock.
      expect(await handlers['account:setPassword']({ current: '', next: PASSWORD })).toMatchObject({ ok: true })
      expect(accountStatus(deps)).toMatchObject({ lockWaits: null, passwordless: false })
      expect(accountStatus(deps).unlockBy).toBe('password')
      deps.lock.lock()
      expect(deps.lock.locked).toBe(true)
      expect(await handlers['account:unlock'](PASSWORD)).toMatchObject({ ok: true })
    })

    it('a provider sign-in never opens the lock', async () => {
      const joined = mac()
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      const { deps, handlers } = wired(m)
      deps.lock.lock()
      expect(await handlers['account:oauthStart']('github')).toMatchObject({ ok: false, reason: 'locked' })
      expect(deps.lock.locked).toBe(true)
    })

    it('a provider landing mid-lock leaves the lock shut', async () => {
      const joined = mac()
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      const { deps, handlers } = wired(m)
      const lockDuringTrip = new Accounts({
        base: m.home,
        origin,
        openBrowser: async (url) => {
          deps.lock.lock()
          const back = returnOf((await walkBrowser(url)).page)
          lockDuringTrip.oauthReturn(`cookrew://oauth#handoff=${back.handoff}&state=${back.state}`)
        }
      })
      const late = accountHandlers({ ...deps, accounts: lockDuringTrip })
      await late['account:oauthStart']('github')
      expect(deps.lock.locked).toBe(true)
      void handlers
    })

    it('no new Mac is offered a passcode; a Mac that chose one changes it only with the current one', async () => {
      const joined = mac()
      await joinByGithub(joined)
      expect(await wired(joined).handlers['account:setPasscode']({ next: PASSCODE })).toMatchObject({ ok: false, reason: 'not_offered' })
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      const { deps, handlers } = wired(m)
      expect(await handlers['account:setPasscode']({ next: '111111' })).toMatchObject({ ok: false, reason: 'bad_credentials' })
      expect(await handlers['account:setPasscode']({ next: '111111', current: 'nope-nope' })).toMatchObject({ ok: false })
      expect(m.app.verifyUnlock(PASSCODE)).toBe(true)
      expect(await handlers['account:setPasscode']({ next: '111111', current: PASSCODE })).toMatchObject({ ok: true })
      expect(m.app.verifyUnlock('111111')).toBe(true)
      deps.lock.lock()
      expect(await handlers['account:setPasscode']({ next: '222222', current: '111111' })).toMatchObject({ ok: false })
    })

    it('Touch ID opens the lock only on a passing prompt, only once it is on', async () => {
      const joined = mac()
      await joinByGithub(joined)
      const m = choosePasscodeAsBefore(joined, PASSCODE)
      let finger = false
      const touchId = { available: () => true, prompt: () => Promise.resolve(finger) }
      const { deps, handlers } = wired(m, { touchId })
      deps.lock.lock()
      expect(await handlers['account:unlockTouchId']()).toMatchObject({ ok: false })
      expect(deps.lock.locked).toBe(true)
      deps.lock.proven()
      expect(await handlers['account:setTouchId'](true)).toMatchObject({ ok: false })
      finger = true
      expect(await handlers['account:setTouchId'](true)).toMatchObject({ ok: true })
      expect(accountStatus(deps).touchId).toEqual({ available: true, on: true })
      deps.lock.lock()
      finger = false
      expect(await handlers['account:unlockTouchId']()).toMatchObject({ ok: false })
      expect(deps.lock.locked).toBe(true)
      finger = true
      expect(await handlers['account:unlockTouchId']()).toMatchObject({ ok: true })
      expect(deps.lock.locked).toBe(false)
    })

    it('Touch ID replaces typing on a password Mac too, and is never offered where it is not available (owner, 2026-11-09)', async () => {
      const m = mac()
      await m.app.claim({ username: 'alice', password: PASSWORD })
      const none = wired(m, { touchId: { available: () => false, prompt: () => Promise.resolve(true) } })
      expect(accountStatus(none.deps).touchId).toEqual({ available: false, on: false })
      expect(await none.handlers['account:setTouchId'](true)).toMatchObject({ ok: false })
      const touchId = { available: () => true, prompt: () => Promise.resolve(true) }
      const { deps, handlers } = wired(m, { touchId })
      expect(accountStatus(deps).touchId).toEqual({ available: true, on: false })
      expect(await handlers['account:setTouchId'](true)).toMatchObject({ ok: true })
      expect(accountStatus(deps).touchId).toEqual({ available: true, on: true })
    })

    it('a password Mac still resumes on unlock, exactly as before', async () => {
      const m = mac()
      await m.app.claim({ username: 'alice', password: PASSWORD })
      await m.app.call('/v2/sessions/current', { method: 'POST', parse: false })
      await m.app.call('/v2/me')
      const { deps, handlers } = wired(m)
      deps.lock.lock()
      expect(await handlers['account:unlock'](PASSWORD)).toMatchObject({ ok: true, sessionRenewed: true })
    })
  })

  describe('acts that step up, on a passwordless account', () => {
    it('sign out goes through a provider proof, and the last device still may not leave', async () => {
      const first = mac('First')
      await joinByGithub(first)
      expect(await first.app.signOutWithProvider()).toMatchObject({ ok: false, reason: 'last_device' })
      const proved = await first.app.providerProve('mint-join-code')
      if (!proved.ok) throw new Error('no proof')
      const code = await first.app.mintJoinCode({ stepUp: proved.value })
      if (!code.ok) throw new Error('no code')
      const second = mac('Second')
      await second.app.join({ code: code.value.code })
      expect((await second.app.signOutWithProvider()).ok).toBe(true)
      expect(existsSync(accountFilePath(second.home))).toBe(false)
    })

    it('the IPC table asks the provider in place of an empty password', async () => {
      const first = mac('First')
      await joinByGithub(first)
      const second = mac('Second')
      const proved = await first.app.providerProve('mint-join-code')
      if (!proved.ok) throw new Error('no proof')
      const code = await first.app.mintJoinCode({ stepUp: proved.value })
      if (!code.ok) throw new Error('no code')
      await second.app.join({ code: code.value.code })
      const lock = new IdleLock({ lockAfterMs: 0, verify: () => false })
      const deps: AccountIpcDeps = {
        accounts: first.app,
        lock,
        requests: new Requests({ accounts: first.app, notify: () => undefined }),
        factors: new Factors({ accounts: first.app, registry: origin }),
        envUsername: null,
        workspaces: () => [],
        saveCodes: () => Promise.resolve({ ok: false })
      }
      const handlers = accountHandlers(deps)
      expect(await handlers['account:joinCode']('')).toMatchObject({ ok: true })
      const other = second.app.account()?.deviceId
      expect(await handlers['account:revoke']({ deviceId: other, password: '' })).toMatchObject({ ok: true })
    })
  })

  describe('linking', () => {
    it('adds and removes a provider on a password account', async () => {
      const m = mac()
      await m.app.claim({ username: 'alice', password: PASSWORD })
      expect(await m.app.providerLink('github', { current: 'wrong wrong wrong' })).toMatchObject({ ok: false })
      expect((await m.app.providerLink('github', { current: PASSWORD })).ok).toBe(true)
      const profile = await m.app.profile()
      if (!profile.ok) throw new Error('no profile')
      expect(profile.value.links).toMatchObject([{ provider: 'github', paused: false }])
      expect(profile.value.email).toMatchObject({ address: 'octo@example.com' })
      expect((await m.app.providerUnlink('github', { current: PASSWORD })).ok).toBe(true)
    })

    it('a signed-in passwordless account links a second provider after proving the first', async () => {
      const m = mac()
      await joinByGithub(m)
      const proved = await m.app.providerProve('link-provider')
      if (!proved.ok) throw new Error('no proof')
      expect((await m.app.providerLink('google', { stepUp: proved.value })).ok).toBe(true)
    })
  })

  describe('the device flow seam, for `cookrew login --github`', () => {
    it('shows the code once, polls, and lands the same way', async () => {
      const m = mac('Headless')
      const codes: string[] = []
      fake.device.answer = 'ok'
      const asked = await m.app.providerDeviceSignIn('github', {
        onCode: (shown) => codes.push(`${shown.userCode} ${shown.verificationUri}`)
      })
      expect(codes).toHaveLength(1)
      expect(codes[0]).toContain('WDJB-MJHT')
      expect(asked).toMatchObject({ ok: false, reason: 'new_identity' })
      expect((await m.app.providerClaim('headless')).ok).toBe(true)
      expect(loadAccount(m.home)).toMatchObject({ username: 'headless', passwordless: true })
    })

    it('a denial ends it', async () => {
      const m = mac('Headless')
      fake.device.answer = 'denied'
      expect(await m.app.providerDeviceSignIn('github', { onCode: () => undefined })).toMatchObject({
        ok: false,
        reason: 'cancelled'
      })
    })
  })
})

describe('the "not me" alarm from the desktop, on a passwordless account', () => {
  beforeEach(() => boot(true))

  it('proves at the provider and pauses the link, so a person is never asked for a password', async () => {
    const first = mac('First')
    await joinByGithub(first)
    const stranger = mac('Stranger')
    const asked = await stranger.app.providerSignIn('github')
    if (asked.ok || asked.reason !== 'second_factor') throw new Error('expected a ladder')
    const sent = await stranger.app.resumeAsk(asked.step.pending)
    if (!sent.ok) throw new Error('not asked')
    const requests = new Requests({ accounts: first.app, notify: () => undefined })
    await requests.refresh()
    const row = requests.list().find((r) => r.id === sent.value.approval)
    expect(row).toBeDefined()
    const answered = await requests.decide(sent.value.approval, 'not-me')
    expect(answered).toMatchObject({ ok: true })
    const profile = await first.app.profile()
    if (!profile.ok) throw new Error('no profile')
    expect(profile.value.links).toMatchObject([{ provider: 'github', paused: true }])
    expect(v2.factors.store.mustChangePassword('octo')).toBe(false)
  })
})

describe('review: the trip', () => {
  beforeEach(() => boot(true))

  /** A Mac whose browser opens and then does nothing, like a person reading. */
  function idle(over: { fetch?: FetchLike } = {}): { app: Accounts; opened: string[] } {
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    homes.push(home)
    const opened: string[] = []
    const app = new Accounts({
      base: home,
      origin,
      ...(over.fetch ? { fetch: over.fetch } : {}),
      openBrowser: (url) => {
        opened.push(url)
      }
    })
    return { app, opened }
  }

  it('a malformed loopback request is answered, and never throws in main', async () => {
    const listener = await listenForReturn(() => true)
    if (listener === null) throw new Error('no port')
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.write(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\nConnection: close\r\n\r\n`)
      })
      let read = ''
      socket.on('data', (chunk) => {
        read += chunk.toString()
      })
      socket.on('end', () => resolve(read))
      socket.on('error', reject)
    })
    listener.close()
    expect(answer).toContain('400')
  })

  it('cancelling before the browser opens means it never opens', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { app, opened } = idle({
      fetch: async (input, init) => {
        if (String(input).endsWith('/start')) await held
        return fetch(input, init)
      }
    })
    const waiting = app.providerSignIn('github')
    await vi.waitFor(() => expect(app.providerCancel()).toBe(true))
    release()
    expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(opened).toEqual([])
  })

  it('a second trip ends the first, which answers instead of hanging', async () => {
    const { app, opened } = idle()
    const first = app.providerSignIn('github')
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    const second = app.providerSignIn('google')
    expect(await first).toMatchObject({ ok: false, reason: 'cancelled' })
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    expect(app.providerCancel()).toBe(true)
    expect(await second).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('a password sign-in ends a trip, so two keys cannot race for one file', async () => {
    const owner = mac('Owner')
    await owner.app.claim({ username: 'alice', password: PASSWORD })
    const { app, opened } = idle()
    const trip = app.providerSignIn('github')
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    await app.signIn({ username: 'alice', password: 'wrong wrong wrong' })
    expect(await trip).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('a name answered another way spends the waiting claim', async () => {
    const m = mac()
    expect(await m.app.providerSignIn('github')).toMatchObject({ reason: 'new_identity' })
    expect((await m.app.claim({ username: 'alice', password: PASSWORD })).ok).toBe(true)
    expect(await m.app.providerClaim('other')).toMatchObject({ ok: false, reason: 'expired' })
    expect(loadAccount(m.home)?.username).toBe('alice')
  })

  it('a device-flow cancel during a poll lands nothing', async () => {
    let cancel: () => void = () => undefined
    const m = mac('Headless', {
      fetch: async (input, init) => {
        const answer = await fetch(input, init)
        if (String(input).endsWith('/poll')) cancel()
        return answer
      }
    })
    cancel = () => m.app.providerCancel()
    fake.device.answer = 'ok'
    const asked = await m.app.providerDeviceSignIn('github', { onCode: () => undefined })
    expect(asked).toMatchObject({ ok: false, reason: 'cancelled' })
  })
})

describe('a device poll already on the wire', () => {
  beforeEach(() => boot(true))

  it('lands a session that came back after the cancel: the registry cannot be asked to forget it', async () => {
    let cancel: () => void = () => undefined
    let arm = false
    const m = mac('Known', {
      fetch: async (input, init) => {
        const answer = await fetch(input, init)
        if (arm && String(input).endsWith('/poll')) cancel()
        return answer
      }
    })
    await joinByGithub(m)
    cancel = () => m.app.providerCancel()
    await m.app.call('/v2/sessions/current', { method: 'POST', parse: false })
    await m.app.call('/v2/me')
    const before = m.app.account()?.session?.token
    arm = true
    fake.device.answer = 'ok'
    const asked = await m.app.providerDeviceSignIn('github', { onCode: () => undefined })
    expect(asked.ok).toBe(true)
    expect(m.app.account()?.session?.token).not.toBe(before)
  })

  it('an abort signal ends the wait between polls', async () => {
    const m = mac('Waiting')
    const stop = new AbortController()
    fake.device.answer = 'pending'
    const waiting = m.app.providerDeviceSignIn('github', { onCode: () => undefined, signal: stop.signal, everyMs: 1_000 })
    await vi.waitFor(() => expect(fake.device.polls).toBeGreaterThan(0))
    stop.abort()
    expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('a ladder a provider opened is forgotten by its pending, key and all', async () => {
    const first = mac('First')
    await joinByGithub(first)
    const second = mac('Second')
    const asked = await second.app.providerSignIn('github')
    if (asked.ok || asked.reason !== 'second_factor') throw new Error('expected a ladder')
    second.app.abandonSignIn(asked.step.pending)
    expect(await second.app.resumeWithCode(asked.step.pending, 'recovery', 'X')).toMatchObject({ ok: false, reason: 'expired' })
  })
})

describe('review: landing', () => {
  beforeEach(() => boot(true))

  it('a session for another account never lands in this account file', async () => {
    const answer = (input: string, init?: RequestInit): Promise<Response> =>
      input.endsWith('/v2/oauth/redeem')
        ? Promise.resolve(Response.json({ token: 't', exp: Date.now() + 60_000, deviceId: 'x', username: 'someone-else' }, { status: 201 }))
        : fetch(input, init)
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    const m = mac('First', { home })
    await joinByGithub(m)
    const before = loadAccount(home)
    const hijacked = mac('First', { home, fetch: answer })
    expect(await hijacked.app.providerSignIn('github')).toMatchObject({ ok: false, reason: 'wrong_identity' })
    expect(loadAccount(home)).toEqual(before)
  })

  it('a landing whose device is not the key held here writes no file', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    const answer = (input: string, init?: RequestInit): Promise<Response> =>
      input.endsWith('/v2/oauth/redeem')
        ? Promise.resolve(Response.json({ token: 't', exp: Date.now() + 60_000, deviceId: 'not-this-key', username: 'octo' }, { status: 201 }))
        : fetch(input, init)
    const m = mac('Fresh', { home, fetch: answer })
    expect(await m.app.providerSignIn('github')).toMatchObject({ ok: false, reason: 'wrong_identity' })
    expect(existsSync(accountFilePath(home))).toBe(false)
  })
})

describe('review: the lock during a trip', () => {
  beforeEach(() => boot(true))

  function lockedDeps(m: Mac, onLocked?: () => void): AccountIpcDeps {
    return {
      accounts: m.app,
      lock: new IdleLock({
        lockAfterMs: 60_000,
        verify: (typed) => m.app.verifyUnlock(typed),
        onChange: (locked) => {
          if (locked) onLocked?.()
        }
      }),
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    }
  }

  /** A Mac whose browser locks the app before it answers. */
  function lockingMac(lock: () => void, home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))): Mac {
    homes.push(home)
    const opened: string[] = []
    const app: Accounts = new Accounts({
      base: home,
      origin,
      deviceName: 'Locking',
      openBrowser: async (url) => {
        opened.push(url)
        lock()
        const back = returnOf((await walkBrowser(url)).page)
        app.oauthReturn(`cookrew://oauth#handoff=${back.handoff ?? ''}&state=${back.state ?? ''}`)
      }
    })
    return { app, home, opened }
  }

  it('an act whose proof finished behind the lock does not happen', async () => {
    let armed = false
    let deps: AccountIpcDeps | null = null
    const locker = (): void => {
      if (armed) deps?.lock.lock()
    }
    const joined = lockingMac(locker)
    await joinByGithub(joined)
    const m = lockingMac(locker, choosePasscodeAsBefore(joined, PASSCODE).home)
    deps = lockedDeps(m)
    armed = true
    expect(await accountHandlers(deps)['account:joinCode']('')).toMatchObject({ ok: false, reason: 'locked' })
  })

  it('locking cancels a link in flight, as index.ts wires it', async () => {
    const source = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(source).toMatch(/if \(locked\) accounts\.providerCancel\(\)/)
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    homes.push(home)
    let deps: AccountIpcDeps | null = null
    const m: Mac = { home, opened: [], app: new Accounts({ base: home, origin, openBrowser: () => deps?.lock.lock() }) }
    await m.app.claim({ username: 'alice', password: PASSWORD })
    deps = lockedDeps(m, () => m.app.providerCancel())
    const answer = await accountHandlers(deps)['account:oauthLink']({ provider: 'github', current: PASSWORD })
    expect(answer).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(v2.links.ownerOf('github', '583231')).toBeNull()
  })

  it('every provider act refuses behind the lock, the alarm and sign-out included', async () => {
    const joined = mac()
    await joinByGithub(joined)
    const m = choosePasscodeAsBefore(joined, PASSCODE)
    const deps = lockedDeps(m)
    deps.lock.lock()
    const handlers = accountHandlers(deps)
    expect(await handlers['account:signOut']('')).toMatchObject({ ok: false, reason: 'locked' })
    expect(await handlers['account:decideRequest']({ id: 'x', action: 'not-me' })).toMatchObject({ ok: false, reason: 'locked' })
    expect(joined.opened).toHaveLength(1)
    expect(m.opened).toHaveLength(0)
  })

  it('a paused try at the passcode says it is paused', async () => {
    const joined = mac()
    await joinByGithub(joined)
    const m = choosePasscodeAsBefore(joined, PASSCODE)
    const handlers = accountHandlers(lockedDeps(m))
    let last: unknown = null
    for (let i = 0; i < 6; i += 1) last = await handlers['account:setPasscode']({ next: '111111', current: 'nope-nope' })
    expect(last).toMatchObject({ ok: false, reason: 'rate_limited' })
  })
})

describe('review: acts that were left out', () => {
  beforeEach(() => boot(true))

  it('ending a seat on a passwordless account carries a provider proof', async () => {
    const m = mac()
    await joinByGithub(m)
    const ended: unknown[] = []
    const door = { end: (_team: string, _id: string, proof?: unknown) => {
      ended.push(proof)
      return Promise.resolve({ ok: true, value: undefined })
    } } as unknown as DoorSeats
    const handlers = accountHandlers({
      accounts: m.app,
      lock: new IdleLock({ lockAfterMs: 0, verify: () => false }),
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false }),
      seats: { door, origin, serving: () => [{ serviceId: 's', slug: 'alpha', team: '@octo/alpha', title: 'Alpha' } as ServedTeamRef] }
    })
    expect(await handlers['account:endSeat']({ slug: 'alpha', id: 'seat-1' })).toMatchObject({ ok: true })
    expect(ended).toMatchObject([{ stepUp: expect.any(String) }])
  })

  it('a last device is told so before any browser opens', async () => {
    const m = mac()
    await joinByGithub(m)
    const before = m.opened.length
    expect(await m.app.signOutWithProvider()).toMatchObject({ ok: false, reason: 'last_device' })
    expect(m.opened).toHaveLength(before)
  })
})

describe('review: the provider is lost', () => {
  beforeEach(() => boot(true))

  it('a rescue code links a new provider, and the new one then proves everything', async () => {
    const m = mac()
    await joinByGithub(m)
    const codes = await codesFor(m)
    if (!codes.ok) throw new Error('no codes')
    const lock = new IdleLock({ lockAfterMs: 0, verify: () => false })
    const handlers = accountHandlers({
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })
    expect(await handlers['account:oauthLink']({ provider: 'google', rescue: 'NOT-A-CODE' })).toMatchObject({ ok: false, reason: 'bad_recovery' })
    expect(await handlers['account:oauthLink']({ provider: 'google', rescue: codes.value[0] })).toMatchObject({ ok: true })
    // GitHub is gone for good: from here the newest link is what answers.
    fake.github = { id: 999, login: 'not-me-any-more', emails: [] }
    expect(await handlers['account:joinCode']('')).toMatchObject({ ok: true })
  })
})

describe('review: channels that widen or open', () => {
  beforeEach(() => boot(true))

  const handlersFor = (m: Mac, lock: IdleLock): ReturnType<typeof accountHandlers> =>
    accountHandlers({
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })

  it('the lock setting cannot open the lock', async () => {
    const m = mac()
    await m.app.claim({ username: 'alice', password: PASSWORD })
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false })
    const handlers = handlersFor(m, lock)
    lock.lock()
    expect(await handlers['account:setLock'](0)).toMatchObject({ ok: false, reason: 'locked' })
    expect(lock.locked).toBe(true)
    lock.proven()
    expect(await handlers['account:setLock'](0)).toMatchObject({ ok: true })
  })

  it('a passwordless Mac proves at the provider for codes, an authenticator and a passkey', async () => {
    const m = mac()
    await joinByGithub(m)
    const handlers = handlersFor(m, new IdleLock({ lockAfterMs: 0, verify: () => false }))
    expect(await handlers['account:recoveryCodes']()).toMatchObject({ ok: true })
    expect(await handlers['account:totpEnrol']()).toMatchObject({ ok: true })
    expect(await handlers['account:passkeyOptions']()).toMatchObject({ ok: true })
  })

  it('a password Mac opens no browser for any of them', async () => {
    const m = mac()
    await m.app.claim({ username: 'alice', password: PASSWORD })
    const handlers = handlersFor(m, new IdleLock({ lockAfterMs: 0, verify: () => false }))
    expect(await handlers['account:recoveryCodes']()).toMatchObject({ ok: true })
    expect(await handlers['account:totpEnrol']()).toMatchObject({ ok: true })
    expect(m.opened).toEqual([])
  })
})

describe('review: a cancel in the gaps around a trip', () => {
  beforeEach(() => boot(true))

  /** A fetch that waits at one path until released, and says when it got there. */
  function gate(tail: string): { fetch: FetchLike; reached: Promise<void>; release: () => void; armed: { on: boolean } } {
    let release: () => void = () => undefined
    let arrive: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      arrive = resolve
    })
    const armed = { on: false }
    return {
      armed,
      reached,
      release,
      fetch: async (input, init) => {
        if (armed.on && String(input).endsWith(tail)) {
          armed.on = false
          arrive()
          await held
        }
        return fetch(input, init)
      }
    }
  }

  it('before a proof trip: the browser never opens', async () => {
    const g = gate('/v2/me')
    const m = mac('Gap', { fetch: g.fetch })
    await joinByGithub(m)
    const before = m.opened.length
    g.armed.on = true
    const proving = m.app.providerProve('mint-join-code')
    await g.reached
    m.app.providerCancel()
    g.release()
    expect(await proving).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(m.opened).toHaveLength(before)
  })

  it('during sign-out: nothing proves and the file stays', async () => {
    const first = mac('First')
    await joinByGithub(first)
    const code = await first.app.providerProve('mint-join-code').then((p) => {
      if (!p.ok) throw new Error('no proof')
      return first.app.mintJoinCode({ stepUp: p.value })
    })
    if (!code.ok) throw new Error('no code')
    const g = gate('/v2/me')
    const second = mac('Second', { fetch: g.fetch })
    await second.app.join({ code: code.value.code })
    g.armed.on = true
    const leaving = second.app.signOutWithProvider()
    await g.reached
    second.app.providerCancel()
    g.release()
    expect(await leaving).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(second.opened).toEqual([])
    expect(existsSync(accountFilePath(second.home))).toBe(true)
  })

  it('between the proof and the link: the second trip never starts', async () => {
    const g = gate('/v2/oauth/redeem')
    const m = mac('Between', { fetch: g.fetch })
    await joinByGithub(m)
    const handlers = accountHandlers({
      accounts: m.app,
      lock: new IdleLock({ lockAfterMs: 0, verify: () => false }),
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })
    const before = m.opened.length
    g.armed.on = true
    const linking = handlers['account:oauthLink']({ provider: 'google' })
    await g.reached
    m.app.providerCancel()
    g.release()
    expect(await linking).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(m.opened).toHaveLength(before + 1)
    expect(v2.accounts.get('octo')?.links).toHaveLength(1)
  })

  it('a rescue code is not spent when the cancel comes first', async () => {
    const g = gate('/start')
    const m = mac('Rescue', { fetch: g.fetch })
    await joinByGithub(m)
    const codes = await codesFor(m)
    if (!codes.ok) throw new Error('no codes')
    g.armed.on = true
    const spending = m.app.providerAct(() => m.app.providerRescueProof('google', codes.value[0]))
    await g.reached
    m.app.providerCancel()
    g.release()
    expect(await spending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(v2.accounts.recoveryCodesLeft('octo')).toBe(8)
  })

  it('the rescue branch stops if the Mac locked while the code was spent', async () => {
    const g = gate('/recovery')
    const joined = mac('RescueLock', { fetch: g.fetch })
    await joinByGithub(joined)
    const m = choosePasscodeAsBefore(joined, PASSCODE, { fetch: g.fetch })
    const codes = await codesFor(m)
    if (!codes.ok) throw new Error('no codes')
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false })
    const handlers = accountHandlers({
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })
    const before = m.opened.length
    g.armed.on = true
    const linking = handlers['account:oauthLink']({ provider: 'google', rescue: codes.value[0] })
    await g.reached
    lock.lock()
    g.release()
    expect(await linking).toMatchObject({ ok: false, reason: 'locked' })
    expect(m.opened).toHaveLength(before)
  })

  it('says when a trip is in flight, for the idle clock', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    homes.push(home)
    const app = new Accounts({ base: home, origin, openBrowser: () => Promise.resolve() })
    expect(app.providerTripping()).toBe(false)
    const waiting = app.providerSignIn('github')
    expect(app.providerTripping()).toBe(true)
    app.providerCancel()
    await waiting
    expect(app.providerTripping()).toBe(false)
  })
})

describe('final review', () => {
  beforeEach(() => boot(true))

  const handlersWith = (m: Mac, lock: IdleLock): ReturnType<typeof accountHandlers> =>
    accountHandlers({
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })

  it('a Mac with no account has nothing to unlock with, so it never locks itself', async () => {
    const m = mac()
    let now = 0
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false, now: () => now, armed: () => m.app.lockable() })
    now = 120_000
    expect(lock.tick()).toBe(false)
    lock.lock()
    expect(lock.locked).toBe(false)
    await m.app.claim({ username: 'alice', password: PASSWORD })
    now = 240_000
    expect(lock.tick()).toBe(true)
  })

  it('index.ts arms the lock on that rule', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(source).toContain('armed: () => accounts.lockable()')
  })

  it('a rung on a ladder a provider opened leaves the lock shut; a password ladder still opens it', async () => {
    const first = mac('First')
    await joinByGithub(first)
    const codes = await codesFor(first)
    if (!codes.ok) throw new Error('no codes')
    const second = mac('Second')
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false })
    const handlers = handlersWith(second, lock)
    const asked = await handlers['account:oauthStart']('github')
    if (typeof asked !== 'object' || asked === null || !('step' in asked)) throw new Error('expected a ladder')
    const { step } = asked as { step: { pending: string } }
    lock.lock()
    const landed = await handlers['account:resumeCode']({ pending: step.pending, factor: 'recovery', code: codes.value[0] })
    expect(landed).toMatchObject({ ok: true })
    expect(lock.locked).toBe(true)

    const owner = mac('Owner')
    await owner.app.claim({ username: 'alice', password: PASSWORD })
    const rescue = await owner.app.recoveryCodes()
    if (!rescue.ok) throw new Error('no codes')
    const other = mac('Other')
    const otherLock = new IdleLock({ lockAfterMs: 60_000, verify: () => false })
    const otherHandlers = handlersWith(other, otherLock)
    const typed = await other.app.signIn({ username: 'alice', password: PASSWORD })
    if (typed.ok || typed.reason !== 'second_factor') throw new Error('expected a ladder')
    otherLock.lock()
    await otherHandlers['account:resumeCode']({ pending: typed.step.pending, factor: 'recovery', code: rescue.value[0] })
    expect(otherLock.locked).toBe(false)
  })

  it('a password ladder cannot write its session into a file a provider landed meanwhile', async () => {
    const owner = mac('Owner')
    await owner.app.claim({ username: 'alice', password: PASSWORD })
    const codes = await owner.app.recoveryCodes()
    if (!codes.ok) throw new Error('no codes')
    const m = mac('Race')
    const typed = await m.app.signIn({ username: 'alice', password: PASSWORD })
    if (typed.ok || typed.reason !== 'second_factor') throw new Error('expected a ladder')
    expect(await m.app.providerSignIn('github')).toMatchObject({ reason: 'new_identity' })
    expect((await m.app.providerClaim('octo')).ok).toBe(true)
    const held = loadAccount(m.home)
    expect(await m.app.resumeWithCode(typed.step.pending, 'recovery', codes.value[0])).toMatchObject({
      ok: false,
      reason: 'wrong_identity'
    })
    expect(loadAccount(m.home)).toEqual(held)
  })

  it('forgetting the terminal claim leaves a browser trip alone', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oauth-mac-'))
    homes.push(home)
    const app = new Accounts({ base: home, origin, openBrowser: () => Promise.resolve() })
    const trip = app.providerSignIn('github')
    await vi.waitFor(() => expect(app.providerTripping()).toBe(true))
    app.providerForget()
    expect(app.providerTripping()).toBe(true)
    app.providerCancel()
    await trip
  })

  it('it does forget the claim the device flow left, and only that one', async () => {
    const m = mac('Headless')
    fake.device.answer = 'ok'
    await m.app.providerDeviceSignIn('github', { onCode: () => undefined })
    m.app.providerForget()
    expect(await m.app.providerClaim('headless')).toMatchObject({ ok: false, reason: 'expired' })
    const window = mac('Window')
    await window.app.providerSignIn('github')
    window.app.providerForget()
    expect((await window.app.providerClaim('windowed')).ok).toBe(true)
  })

  it('one failed poll is not the end: the person keeps the code they typed', async () => {
    let failures = 1
    const m = mac('Flaky', {
      fetch: (input, init) => {
        if (String(input).endsWith('/poll') && failures > 0) {
          failures -= 1
          return Promise.reject(new Error('the wifi dropped'))
        }
        return fetch(input, init)
      }
    })
    fake.device.answer = 'ok'
    const asked = await m.app.providerDeviceSignIn('github', { onCode: () => undefined, everyMs: 1 })
    expect(asked).toMatchObject({ ok: false, reason: 'new_identity' })
  })
})

describe('final review, second look', () => {
  beforeEach(() => boot(true))

  it('a retry after a dropped ladder lands with its own key, and the file holds that key', async () => {
    const first = mac('First')
    await joinByGithub(first)
    const codes = await codesFor(first)
    if (!codes.ok) throw new Error('no codes')
    const second = mac('Second')
    const dropped = await second.app.providerSignIn('github')
    const retried = await second.app.providerSignIn('github')
    if (dropped.ok || dropped.reason !== 'second_factor') throw new Error('expected a ladder')
    if (retried.ok || retried.reason !== 'second_factor') throw new Error('expected a ladder')
    expect((await second.app.resumeWithCode(retried.step.pending, 'recovery', codes.value[0])).ok).toBe(true)
    const held = loadAccount(second.home)
    expect(held).toMatchObject({ username: 'octo' })
    expect(held?.deviceId).toBe(deviceIdFor(held?.publicKeyJwk ?? {}))
    expect(v2.accounts.get('octo')?.devices.map((d) => d.id)).toContain(held?.deviceId)
  })

  it('a password ladder left open does not spoil a provider landing either', async () => {
    const owner = mac('Owner')
    await owner.app.claim({ username: 'alice', password: PASSWORD })
    expect((await owner.app.providerLink('github', { current: PASSWORD })).ok).toBe(true)
    const codes = await owner.app.recoveryCodes()
    if (!codes.ok) throw new Error('no codes')
    const m = mac('Stale')
    const typed = await m.app.signIn({ username: 'alice', password: PASSWORD })
    if (typed.ok || typed.reason !== 'second_factor') throw new Error('expected a password ladder')
    const asked = await m.app.providerSignIn('github')
    if (asked.ok || asked.reason !== 'second_factor') throw new Error('expected a provider ladder')
    expect((await m.app.resumeWithCode(asked.step.pending, 'recovery', codes.value[0])).ok).toBe(true)
    const held = loadAccount(m.home)
    expect(held?.deviceId).toBe(deviceIdFor(held?.publicKeyJwk ?? {}))
    expect(v2.accounts.get('alice')?.devices.map((d) => d.id)).toContain(held?.deviceId)
  })

  it('signing out behind the lock releases it: there is no account left to unlock', async () => {
    const owner = mac('Owner')
    await owner.app.claim({ username: 'alice', password: PASSWORD })
    const codes = await owner.app.recoveryCodes()
    if (!codes.ok) throw new Error('no codes')
    const m = mac('Leaving')
    const typed = await m.app.signIn({ username: 'alice', password: PASSWORD })
    if (typed.ok || typed.reason !== 'second_factor') throw new Error('expected a ladder')
    expect((await m.app.resumeWithCode(typed.step.pending, 'recovery', codes.value[0])).ok).toBe(true)
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false })
    const handlers = accountHandlers({
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false })
    })
    lock.lock()
    expect(await handlers['account:signOut'](PASSWORD)).toMatchObject({ ok: true })
    expect(lock.locked).toBe(false)
  })
})
