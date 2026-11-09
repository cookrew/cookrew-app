import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Accounts, DEFAULT_LOCK_AFTER_MS, loadAccount, mintDeviceKey, unlockVerifierFor, writeAccount, type AccountFile } from '../src/main/account-v2'
import { accountHandlers, accountStatus, type AccountIpcDeps } from '../src/main/account-ipc'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { IdleLock } from '../src/main/lock'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { shouldAskAccountPassword } from '../src/renderer/src/account/provider-store'
import { PASSWORD, grantWorld, type GrantWorld } from './support/grant-world'
import { tempBase } from './support/idv2'

/**
 * NO SEPARATE PASSCODE (owner, 2026-11-09), on the machines that asked for one.
 *
 * Solis-Core was signed in with `cookrew login` on a screen nobody sits at,
 * and still put up "Choose a passcode". Now a machine with no lock secret
 * WAITS: for the account password typed on it once (checked through its own
 * session), or for the account to have a password at all. It never puts a
 * modal on a terminal machine's screen, and never says "passcode" to someone
 * who did not choose one.
 */

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
  readonly deps: AccountIpcDeps
  readonly handlers: ReturnType<typeof accountHandlers>
  readonly base: string
}

/** A signed-in machine of `username` whose file says `shape`, as index.ts wires it. */
function machine(username: string, shape: Partial<AccountFile>): Machine {
  const keys = mintDeviceKey()
  const deviceId = randomUUID()
  const attached = world.v2.accounts.attachDevice(username, { id: deviceId, kind: 'desktop', name: 'Solis-Core', jwk: keys.publicKeyJwk })
  if (!attached.ok) throw new Error(attached.reason)
  const session = world.v2.accounts.startSession(username, deviceId, { verifiedBy: 'provider' })
  if (session === null) throw new Error('no session')
  const minted = world.v2.tokens.mintSession(username, deviceId, session.jti)
  const { base } = tempBase()
  writeAccount(
    {
      username,
      deviceId,
      kind: 'desktop',
      name: 'Solis-Core',
      privateKeyJwk: keys.privateKeyJwk,
      publicKeyJwk: keys.publicKeyJwk,
      registry: world.origin,
      session: { token: minted.token, exp: minted.exp },
      unlock: null,
      lockAfterMs: DEFAULT_LOCK_AFTER_MS,
      claimedAt: Date.now(),
      workspacesReachable: true,
      recoveryCodesSavedAt: null,
      ...shape
    } as AccountFile,
    base
  )
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
  return { accounts, lock, deps, handlers: accountHandlers(deps), base }
}

async function passwordAccount(): Promise<string> {
  n += 1
  const username = `lockwait-${n}`
  await world.account(username)
  return username
}

async function providerAccount(): Promise<string> {
  n += 1
  const username = `lockwait-p${n}`
  await world.account(username, { passwordless: true })
  return username
}

const adopt = (m: Machine) => m.handlers['account:adoptPassword'] as (p: unknown) => Promise<Record<string, unknown>>
const unlock = (m: Machine) => m.handlers['account:unlock'] as (p: string) => Promise<Record<string, unknown>>

describe('a machine that was waiting for a passcode it never chose (Solis-Core, 22:15)', () => {
  it('on a provider-only account: no unlockBy, read as a terminal machine, no sheet, the lock off and saying why', async () => {
    const m = machine(await providerAccount(), { unlockBy: 'passcode', passwordless: true })
    expect(m.accounts.account()?.unlockBy).toBeUndefined()
    expect(m.accounts.isFromTerminal()).toBe(true)
    expect(m.accounts.lockWaits()).toBe('set-password')
    const status = accountStatus(m.deps)
    expect(status).toMatchObject({ lockWaits: 'set-password', fromTerminal: true, unlockBy: 'password' })
    expect(shouldAskAccountPassword(status, false)).toBe(false)
    m.lock.lock()
    expect(m.lock.locked).toBe(false)
    // Every start reads it the same way: the file is migrated as it is read.
    expect(loadAccount(m.base)).toMatchObject({ fromTerminal: true })
    expect(loadAccount(m.base)?.unlockBy).toBeUndefined()
  })

  it('on a password account: the lock waits for the password typed here once', async () => {
    const m = machine(await passwordAccount(), { unlockBy: 'passcode' })
    expect(m.accounts.lockWaits()).toBe('type-password')
    expect(shouldAskAccountPassword(accountStatus(m.deps), false)).toBe(false)
  })

  it('a passcode that WAS chosen is left alone, and keeps opening the lock', async () => {
    const m = machine(await providerAccount(), { unlockBy: 'passcode', passwordless: true, unlock: unlockVerifierFor('a chosen one') })
    expect(m.accounts.account()?.unlockBy).toBe('passcode')
    expect(m.accounts.isFromTerminal()).toBe(false)
    expect(m.accounts.lockWaits()).toBeNull()
    m.lock.lock()
    expect(await unlock(m)('a chosen one')).toMatchObject({ ok: true })
  })
})

describe('the account password, typed on a terminal machine once', () => {
  it('a wrong one is refused by cookrew.dev and turns nothing on', async () => {
    const m = machine(await passwordAccount(), { fromTerminal: true })
    expect(m.accounts.lockWaits()).toBe('type-password')
    expect(await adopt(m)('not the password at all')).toMatchObject({ ok: false, reason: 'bad_credentials' })
    expect(m.accounts.lockWaits()).toBe('type-password')
    expect(m.accounts.account()?.unlock).toBeNull()
  })

  it('the right one becomes the lock: armed, offline, and the terminal mark goes', async () => {
    const m = machine(await passwordAccount(), { fromTerminal: true })
    const answer = await adopt(m)(PASSWORD)
    expect(answer).toMatchObject({ ok: true, value: { lockWaits: null, fromTerminal: false } })
    expect(m.accounts.lockable()).toBe(true)
    expect(m.accounts.verifyUnlock(PASSWORD)).toBe(true)
    expect(JSON.stringify(loadAccount(m.base))).not.toContain(PASSWORD)
    m.lock.lock()
    expect(m.lock.locked).toBe(true)
    expect(await unlock(m)(PASSWORD)).toMatchObject({ ok: true })
  })

  it('wrong tries are counted here too: five buy a pause, even with cookrew.dev’s rest forgotten', async () => {
    const m = machine(await passwordAccount(), { fromTerminal: true })
    let last: Record<string, unknown> = {}
    for (let i = 0; i < 5; i += 1) {
      forgetGrantRests()
      last = await adopt(m)('not the password at all')
    }
    expect(last).toMatchObject({ ok: false, reason: 'rate_limited' })
    forgetGrantRests()
    expect(await adopt(m)(PASSWORD)).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect(m.accounts.lockWaits()).toBe('type-password')
  })

  it('is refused behind the lock, and an empty one never leaves the machine', async () => {
    const m = machine(await passwordAccount(), {})
    expect(await adopt(m)('')).toMatchObject({ ok: false, reason: 'bad_credentials' })
    m.lock.lock()
    expect(await adopt(m)(PASSWORD)).toMatchObject({ ok: false, reason: 'locked' })
  })
})

describe('a machine a person signed in at, on a password account', () => {
  it('asks nothing up front; the first unlock asks cookrew.dev through this machine’s session and keeps the answer', async () => {
    const m = machine(await passwordAccount(), {})
    expect(m.accounts.lockWaits()).toBeNull()
    expect(shouldAskAccountPassword(accountStatus(m.deps), false)).toBe(false)
    m.lock.lock()
    expect(m.lock.locked).toBe(true)
    expect(await unlock(m)('not the password at all')).toMatchObject({ ok: false, reason: 'wrong' })
    expect(m.lock.locked).toBe(true)
    expect(await unlock(m)(PASSWORD)).toMatchObject({ ok: true })
    expect(m.lock.locked).toBe(false)
    expect(m.accounts.verifyUnlock(PASSWORD)).toBe(true)
  })
})

describe('a first unlock on a machine whose session has died', () => {
  it('is never told the right password is wrong: it signs in afresh, or says why it cannot', async () => {
    const m = machine(await passwordAccount(), {})
    await m.accounts.call('/v2/sessions/current', { method: 'POST', parse: false })
    await m.accounts.call('/v2/me')
    expect(m.accounts.sessionLive()).toBe(false)
    m.lock.lock()
    expect(await unlock(m)('not the password at all')).toMatchObject({ ok: false, reason: 'wrong' })
    const answer = await unlock(m)(PASSWORD)
    expect(answer.reason).not.toBe('wrong')
    // This account has no second step yet, so a fresh sign-in is refused, and
    // the lock says so in the registry's words rather than "not it".
    expect(answer).toMatchObject({ ok: false, reason: 'unproven' })
    expect(String(answer.message)).toContain('second step')
  })
})

describe('the words', () => {
  /** Every renderer string a person can read, minus the one place a chosen passcode is named. */
  function rendererSource(): string {
    const dir = path.join(process.cwd(), 'src/renderer/src/account')
    return readdirSync(dir)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .map((file) => readFileSync(path.join(dir, file), 'utf8'))
      .join('\n')
  }

  it('no sheet anywhere says "Choose a passcode"', () => {
    expect(rendererSource()).not.toMatch(/Choose a passcode/i)
    expect(rendererSource()).not.toContain('PasscodeCard')
  })

  it('"passcode" is said only on a machine whose file says it chose one', () => {
    const table = readFileSync(path.join(process.cwd(), 'src/renderer/src/account/provider-store.ts'), 'utf8')
    const said = [...table.matchAll(/^\s+([A-Z_]+):\s*\n?\s*'([^']*)'/gm)]
      .filter(([, , text]) => /passcode/i.test(text))
      .map(([, key]) => key)
    expect(said.every((key) => key.startsWith('CHOSEN_PASSCODE_'))).toBe(true)
  })
})
