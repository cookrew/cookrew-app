import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Accounts, DEFAULT_LOCK_AFTER_MS, loadAccount, mintDeviceKey, unlockVerifierFor, writeAccount, type AccountFile } from '../src/main/account-v2'
import { accountHandlers, type AccountIpcDeps } from '../src/main/account-ipc'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { IdleLock } from '../src/main/lock'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { grantWorld, type GrantWorld } from './support/grant-world'
import { tempBase } from './support/idv2'

/**
 * THE PASSCODE FOLDS INTO THE ACCOUNT PASSWORD (owner, 2026-11-09).
 *
 * Two machines of a provider-only account, each with its own passcode. One
 * sets the account password; its lock takes it at once. The other keeps its
 * passcode — nobody is stranded — until the account password is first typed
 * at it, which cookrew.dev confirms and the machine then keeps.
 */

const NEXT = 'our new account password'
let world: GrantWorld
let n = 0
beforeAll(async () => {
  world = await grantWorld()
})
afterAll(async () => world.close())
beforeEach(() => forgetGrantRests())

interface Machine {
  readonly accounts: Accounts
  readonly lock: IdleLock
  readonly handlers: ReturnType<typeof accountHandlers>
  readonly base: string
}

/** A passcode machine of `username`, signed in (just now, by its provider). */
function passcodeMachine(username: string, passcode: string): Machine {
  const keys = mintDeviceKey()
  const deviceId = randomUUID()
  const attached = world.v2.accounts.attachDevice(username, { id: deviceId, kind: 'desktop', name: 'Solis', jwk: keys.publicKeyJwk })
  if (!attached.ok) throw new Error(attached.reason)
  const session = world.v2.accounts.startSession(username, deviceId, { verifiedBy: 'provider' })!
  const minted = world.v2.tokens.mintSession(username, deviceId, session.jti)
  const { base } = tempBase()
  const file: AccountFile = {
    username,
    deviceId,
    kind: 'desktop',
    name: 'Solis',
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    registry: world.origin,
    session: { token: minted.token, exp: minted.exp },
    unlock: unlockVerifierFor(passcode),
    unlockBy: 'passcode',
    passwordless: true,
    lockAfterMs: DEFAULT_LOCK_AFTER_MS,
    claimedAt: Date.now(),
    workspacesReachable: true,
    recoveryCodesSavedAt: null
  } as AccountFile
  writeAccount(file, base)
  const accounts = new Accounts({ base, origin: world.origin })
  const lock = new IdleLock({ lockAfterMs: DEFAULT_LOCK_AFTER_MS, verify: (p) => accounts.verifyUnlock(p), armed: () => accounts.lockable() })
  const deps: AccountIpcDeps = {
    accounts,
    lock,
    requests: new Requests({ accounts, notify: () => undefined }),
    factors: new Factors({ accounts, registry: world.origin }),
    envUsername: null,
    workspaces: () => [],
    saveCodes: () => Promise.resolve({ ok: false, reason: 'no_window' })
  }
  return { accounts, lock, handlers: accountHandlers(deps), base }
}

const unlockOf = (m: Machine) => m.handlers['account:unlock'] as (p: string) => Promise<Record<string, unknown>>

describe('the passcode folds into the account password', () => {
  it('setting the password on one machine moves its lock to the password at once', async () => {
    const username = `fold${++n}`
    await world.account(username, { passwordless: true })
    const a = passcodeMachine(username, '1234-a')
    const set = (await (a.handlers['account:setPassword'] as (i: unknown) => Promise<{ ok: boolean }>)({ current: '', next: NEXT }))
    expect(set.ok).toBe(true)
    expect(world.v2.accounts.get(username)?.passwordless).toBe(false)
    const file = loadAccount(a.base)!
    expect(file.unlockBy).toBeUndefined()
    expect(file.passwordless).toBe(false)
    a.lock.lock()
    expect(await unlockOf(a)('1234-a')).toMatchObject({ ok: false })
    expect(await unlockOf(a)(NEXT)).toMatchObject({ ok: true })
  })

  it('another machine keeps its passcode until the account password is first typed there', async () => {
    const username = `fold${++n}`
    await world.account(username, { passwordless: true })
    const a = passcodeMachine(username, '1234-a')
    const b = passcodeMachine(username, '5678-b')
    await (a.handlers['account:setPassword'] as (i: unknown) => Promise<unknown>)({ current: '', next: NEXT })
    // B has not heard yet: its passcode still opens it, and a wrong one never leaves it.
    b.lock.lock()
    expect(await unlockOf(b)('5678-b')).toMatchObject({ ok: true })
    // B reads the profile, learns the account has a password.
    await b.accounts.profile()
    b.lock.lock()
    expect(await unlockOf(b)('not either of them')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(await unlockOf(b)(NEXT)).toMatchObject({ ok: true })
    expect(loadAccount(b.base)?.unlockBy).toBeUndefined()
    b.lock.lock()
    expect(await unlockOf(b)('5678-b')).toMatchObject({ ok: false })
    expect(await unlockOf(b)(NEXT)).toMatchObject({ ok: true })
  })

  it('Touch ID is offered on a password machine too', async () => {
    const username = `fold${++n}`
    await world.account(username, { passwordless: true })
    const a = passcodeMachine(username, '1234-a')
    await (a.handlers['account:setPassword'] as (i: unknown) => Promise<unknown>)({ current: '', next: NEXT })
    a.accounts.setTouchId(true)
    expect(a.accounts.touchIdOn()).toBe(true)
  })

  it('a passcode typo never leaves the machine: only text long enough to be the account password is asked about', async () => {
    const username = `fold${++n}`
    await world.account(username, { passwordless: true })
    const a = passcodeMachine(username, '1234-a')
    const b = passcodeMachine(username, '5678-b')
    await (a.handlers['account:setPassword'] as (i: unknown) => Promise<unknown>)({ current: '', next: NEXT })
    await b.accounts.profile()
    let asked = 0
    const real = b.accounts.isAccountPassword.bind(b.accounts)
    b.accounts.isAccountPassword = async (p: string) => ((asked += 1), real(p))
    b.lock.lock()
    expect(await unlockOf(b)('5687-b')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(asked).toBe(0)
  })
})
