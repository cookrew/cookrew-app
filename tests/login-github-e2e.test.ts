// `cookrew login --github`, THE REAL HALF: the real door, the real account and
// its IPC table, a real registry on loopback, and a fake GitHub. The pty that
// proves the CLI script forwards the flag is in login-registry-e2e.test.ts.

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { Accounts, accountFilePath, loadAccount, unlockVerifierFor, writeAccount, type FetchLike } from '../src/main/account-v2'
import { accountDoor, type AccountIpcDeps } from '../src/main/account-ipc'
import { Factors } from '../src/main/factors'
import { IdleLock } from '../src/main/lock'
import { LoginDoor, type LoginAudit, type LoginTurn } from '../src/main/login-cli'
import { Requests } from '../src/main/requests'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'
import { fakeOAuth, loopbackOnly, returnOf, walkBrowser, type FakeOAuth } from './support/fake-oauth'

const pane = { id: 'term-owner', kind: 'terminal', name: 'shell' } as unknown as TerminalNodeData
const PASSCODE = '482913'

let dir: string
let homes: string[]
let server: Server
let origin: string
let fake: FakeOAuth
let v2: V2Identity

const guarded: FetchLike = (input, init) => fetch(loopbackOnly(String(input)), init)

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'login-gh-'))
  homes = []
  fake = await fakeOAuth()
  fake.device.answer = 'ok'
  v2 = createV2(dir, { secondStep: 'legacy', 
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000 },
    oauth: fake.config()
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
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

interface Box {
  app: Accounts
  home: string
  lock: IdleLock
  audits: LoginAudit[]
  open: (args?: string[]) => Promise<LoginTurn>
  send: (verb: string, secret?: string) => Promise<LoginTurn>
  /** Open and walk to the first turn after the code, printing what a person sees. */
  throughCode: () => Promise<{ code: LoginTurn; next: LoginTurn }>
  said: string[]
}

function box(name = 'Linux · box', home = mkdtempSync(path.join(tmpdir(), 'login-gh-mac-'))): Box {
  homes.push(home)
  const app: Accounts = new Accounts({
    base: home,
    origin,
    deviceName: name,
    fetch: guarded,
    openBrowser: async (url) => {
      const back = returnOf((await walkBrowser(url)).page)
      app.oauthReturn(`cookrew://oauth#handoff=${back.handoff ?? ''}&state=${back.state ?? ''}`)
    }
  })
  const lock = new IdleLock({
    lockAfterMs: 60_000,
    verify: (typed) => app.verifyUnlock(typed),
    armed: () => app.lockable()
  })
  const deps: AccountIpcDeps = {
    accounts: app,
    lock,
    requests: new Requests({ accounts: app, notify: () => undefined }),
    factors: new Factors({ accounts: app, registry: origin }),
    envUsername: null,
    workspaces: () => [],
    saveCodes: () => Promise.resolve({ ok: false })
  }
  const audits: LoginAudit[] = []
  const door = new LoginDoor({
    account: () => accountDoor(deps, 'linux'),
    ownerPane: () => pane,
    agentBusy: () => false,
    driven: () => false,
    seal: () => () => undefined,
    audit: (event) => audits.push(event),
    sleep: async () => undefined
  })
  const connection = Object.assign(new EventEmitter(), {
    end(this: EventEmitter) {
      this.emit('close')
    }
  })
  const said: string[] = []
  const ask = async (cmd: string, verb: string, args: string[], flags: CliRequest['flags'], secret?: string): Promise<LoginTurn> => {
    const sent: CliRequest = { id: 'r', terminalId: pane.id, cmd, args: [verb, ...args], flags }
    const turn = JSON.parse(await door.handle(sent, secret, connection)) as LoginTurn
    said.push(...turn.say)
    return turn
  }
  const open = (args: string[] = []): Promise<LoginTurn> => ask('login', 'open', args, { tty: true, github: true })
  const send = (verb: string, secret?: string): Promise<LoginTurn> => ask('login', verb, [], {}, secret)
  return {
    app,
    home,
    lock,
    audits,
    open,
    send,
    said,
    throughCode: async () => {
      await open()
      const code = await send('wait')
      return { code, next: await send('wait') }
    }
  }
}

/**
 * THE SAME MACHINE AFTER IT CHOSE A PASSCODE, as the app before 2026-11-09
 * let it. No new machine is put in this state; one that is keeps its passcode.
 */
function choosePasscodeAsBefore(b: Box): Box {
  const held = loadAccount(b.home)
  if (held === null) throw new Error('no account')
  writeAccount({ ...held, unlockBy: 'passcode', unlock: unlockVerifierFor(PASSCODE) }, b.home)
  return box('Linux · box', b.home)
}

/** A new account, made at the terminal. */
async function newAccount(b: Box, name = 'octo'): Promise<void> {
  const { next } = await b.throughCode()
  expect(next.ask?.kind).toBe('text')
  expect((await b.send('answer', name)).exit).toBe(0)
}

describe('cookrew login --github', () => {
  it('makes an account with no password, and the name is the one typed', async () => {
    const b = box()
    const { code, next } = await b.throughCode()
    expect(code.say.join(' ')).toContain('WDJB-MJHT')
    expect(next.ask?.prompt).toContain('octo-cat')
    expect(existsSync(accountFilePath(b.home))).toBe(false)
    const done = await b.send('answer', 'headless')
    expect(done.exit).toBe(0)
    expect(done.say.join(' ')).toContain('@headless')
    // Nobody is at this screen: no passcode, no sheet, the lock off until the
    // account has a password and it is typed here once (owner, 2026-11-09).
    expect(loadAccount(b.home)).toMatchObject({ username: 'headless', passwordless: true, unlock: null, fromTerminal: true })
    expect(loadAccount(b.home)?.unlockBy).toBeUndefined()
    expect(b.app.lockWaits()).toBe('set-password')
    expect(done.say.join(' ')).toContain('@headless has no password yet')
    expect(done.say.join(' ')).not.toContain('passcode')
    expect(v2.accounts.get('headless')?.passwordless).toBe(true)
    expect(b.audits.map((a) => a.type)).toEqual(['account.login'])
  })

  it('never carries the device code or a secret to the terminal', async () => {
    const b = box()
    await newAccount(b)
    expect(b.said.join(' ')).not.toContain('dev-code-secret')
    expect(b.said.join(' ')).not.toContain('octo@example.com')
  })

  it('a name somebody has asks again on the same ticket', async () => {
    const first = box('First')
    await newAccount(first, 'taken-name')
    fake.github = { id: 2, login: 'someone', emails: [] }
    const b = box('Second')
    await b.throughCode()
    const again = await b.send('answer', 'taken-name')
    expect(again.ask).toBeDefined()
    expect((await b.send('answer', 'free-name')).exit).toBe(0)
  })

  it('THE FIRST RUNG WORKS WITH NO PASSWORD HELD: a recovery code lands a new machine', async () => {
    const first = box('First')
    await newAccount(first)
    const proved = await first.app.providerProve('add-factor')
    if (!proved.ok) throw new Error('no proof')
    const codes = await first.app.recoveryCodes({ stepUp: proved.value })
    if (!codes.ok) throw new Error('no codes')
    const b = box('Second')
    const { next } = await b.throughCode()
    expect(next.ask?.kind).toBe('choice')
    const asked = await b.send('answer', '2')
    expect(asked.ask?.kind).toBe('hidden')
    expect(existsSync(accountFilePath(b.home))).toBe(false)
    expect((await b.send('answer', codes.value[0])).exit).toBe(0)
    expect(loadAccount(b.home)).toMatchObject({ username: 'octo', unlock: null, fromTerminal: true })
    expect(b.app.lockWaits()).toBe('set-password')
    expect(b.app.sessionLive()).toBe(true)
  })

  it('the approve rung lands the same way, and a new machine is on the ladder before it is on the account', async () => {
    const first = box('First')
    await newAccount(first)
    const b = box('Second')
    const { next } = await b.throughCode()
    expect(next.wait).toBeDefined()
    const number = /\b([1-9][0-9])\b/.exec(next.say.join(' '))?.[1] ?? ''
    expect(v2.accounts.get('octo')?.devices).toHaveLength(1)
    const listed = await first.app.call<readonly { id: string }[]>('/v2/me/approvals')
    if (!listed.ok) throw new Error('no approvals')
    const decided = await first.app.call(`/v2/me/approvals/${listed.value[0].id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', match: number }),
      parse: false
    })
    expect(decided.ok).toBe(true)
    expect((await b.send('wait')).exit).toBe(0)
    expect(v2.accounts.get('octo')?.devices).toHaveLength(2)
    // Landed on the approve rung, still from a terminal: no sheet on its screen.
    expect(b.app.isFromTerminal()).toBe(true)
  })

  it('renews a dead session on the same device, and a passcode chosen before stays', async () => {
    const first = box()
    await newAccount(first)
    const b = choosePasscodeAsBefore(first)
    const device = b.app.account()?.deviceId
    await b.app.call('/v2/sessions/current', { method: 'POST', parse: false })
    await b.app.call('/v2/me')
    expect(b.app.sessionLive()).toBe(false)
    const { next } = await b.throughCode()
    expect(next.exit).toBe(0)
    expect(b.app.sessionLive()).toBe(true)
    expect(b.app.account()?.deviceId).toBe(device)
    expect(b.app.verifyUnlock(PASSCODE)).toBe(true)
  })

  it('another GitHub account cannot take over a machine that has one', async () => {
    const b = box()
    await newAccount(b)
    await b.app.call('/v2/sessions/current', { method: 'POST', parse: false })
    await b.app.call('/v2/me')
    fake.github = { id: 77, login: 'stranger', emails: [] }
    const { next } = await b.throughCode()
    expect(next.exit).toBe(1)
    expect(loadAccount(b.home)?.username).toBe('octo')
  })

  it('refuses behind the lock, and a landing never opens it', async () => {
    const first = box()
    await newAccount(first)
    const b = choosePasscodeAsBefore(first)
    await b.app.call('/v2/sessions/current', { method: 'POST', parse: false })
    await b.app.call('/v2/me')
    b.lock.lock()
    await b.open()
    const refused = await b.send('wait')
    expect(refused.exit).toBe(1)
    expect(refused.say.join(' ')).toContain('locked')
    expect(b.lock.locked).toBe(true)
    expect(b.app.sessionLive()).toBe(false)
  })

  it('an unconfigured provider is refused in a sentence, with nothing attached', async () => {
    const b = box()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    v2 = createV2(dir, { secondStep: 'legacy', })
    server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      v2
    })
    await new Promise<void>((resolve) => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve))
    await b.open()
    const done = await b.send('wait')
    expect(done.exit).toBe(1)
    expect(done.say.join(' ')).toContain('not available')
    expect(existsSync(accountFilePath(b.home))).toBe(false)
  })
})
