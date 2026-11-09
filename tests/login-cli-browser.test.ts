// `cookrew login` ON THE ONE SIGN-IN PAGE. By default the terminal shows a code
// and an address and waits for the page; `--password` keeps the old conversation,
// `--github` keeps GitHub's device flow, and an older registry falls back to the
// password exactly as before. The second half drives the real account door
// against a fake registry, so the 202-then-201 poll is the real one.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LoginDoor, type AccountDoor, type LoginAudit, type LoginTurn } from '../src/main/login-cli'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'
import type { SignInAnswer } from '../src/shared/account-v2'
import type { BrowserCode } from '../src/main/account-browser-auth'
import { Accounts, loadAccount } from '../src/main/account-v2'
import { accountDoor, type AccountIpcDeps } from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { AUDIENCE, FakeRegistry, NOW, ORIGIN } from './support/fake-auth-site'

const pane = { id: 'term-owner', kind: 'terminal', name: 'shell' } as unknown as TerminalNodeData
const landed: SignInAnswer<unknown> = { ok: true, value: {} }

const CODE: BrowserCode = {
  userCode: 'BCDF-GHJK',
  verificationUri: `${AUDIENCE}/device`,
  verificationUriComplete: `${AUDIENCE}/device?code=BCDF-GHJK`,
  expiresAt: NOW + 600_000,
}

type BrowserSeam = NonNullable<AccountDoor['browserDevice']>

/** A page that shows the code and then answers `ending`. */
const coded = (ending: SignInAnswer<unknown>): BrowserSeam =>
  vi.fn(async (onCode: (code: BrowserCode) => void) => {
    onCode(CODE)
    return ending
  }) as unknown as BrowserSeam

/** A page that answers before any code: an older registry. */
const unsupported: BrowserSeam = vi.fn(async () => ({ ok: false as const, reason: 'unsupported' as const })) as unknown as BrowserSeam

interface Who {
  username: string | null
  passwordless?: boolean
  lockWaits?: 'set-password' | 'type-password' | null
  sessionLive?: boolean
}

interface Fixture {
  account: AccountDoor
  audits: LoginAudit[]
  released: string[]
  connection: EventEmitter & { end: () => void }
  open: (args?: string[], flags?: CliRequest['flags']) => Promise<LoginTurn>
  send: (verb: string, secret?: string) => Promise<LoginTurn>
}

const newConnection = (): EventEmitter & { end: () => void } =>
  Object.assign(new EventEmitter(), {
    end(this: EventEmitter) {
      this.emit('close')
    },
  })

function fixture(over: Partial<AccountDoor> = {}, who: Who = { username: null }): Fixture {
  const audits: LoginAudit[] = []
  const released: string[] = []
  const account: AccountDoor = {
    platform: 'darwin',
    who: () => ({
      username: who.username,
      deviceId: 'dev-1',
      deviceName: 'MacBook Pro',
      sessionLive: who.sessionLive ?? false,
      registry: null,
      mismatch: null,
      passwordless: who.passwordless ?? false,
      lockWaits: who.lockWaits ?? null,
    }),
    signIn: vi.fn(async () => landed),
    resume: vi.fn(async () => landed),
    climbCode: vi.fn(async () => landed),
    askApproval: vi.fn(async () => ({ ok: true as const, value: { approval: 'a', expiresAt: 0, sentence: 's' } })),
    waitApproval: vi.fn(async () => landed),
    abandon: vi.fn(),
    signOut: vi.fn(async () => ({ ok: true as const, value: {} })),
    devices: vi.fn(async () => ({ ok: true as const, value: [] })),
    providerDevice: vi.fn(async () => landed),
    providerClaim: vi.fn(async () => landed),
    abandonClaim: vi.fn(),
    browserDevice: coded(landed),
    ...over,
  }
  return wire(account, audits, released)
}

function wire(account: AccountDoor, audits: LoginAudit[] = [], released: string[] = []): Fixture {
  const door = new LoginDoor({
    account: () => account,
    ownerPane: () => pane,
    agentBusy: () => false,
    driven: () => false,
    seal: (id) => () => released.push(id),
    audit: (event) => audits.push(event),
    sleep: async () => undefined,
  })
  const connection = newConnection()
  const ask = async (verb: string, args: string[], flags: CliRequest['flags'] | undefined, secret?: string): Promise<LoginTurn> => {
    const sent: CliRequest = { id: 'r', terminalId: 'term-owner', cmd: 'login', args: [verb, ...args], flags: flags ?? {} }
    return JSON.parse(await door.handle(sent, secret, connection)) as LoginTurn
  }
  return {
    account,
    audits,
    released,
    connection,
    open: (args = [], flags = { tty: true }) => ask('open', args, flags),
    send: (verb, secret) => ask(verb, [], undefined, secret),
  }
}

describe('cookrew login, by default', () => {
  it('waits for the page: the address, the code, the full link, then the landing', async () => {
    const f = fixture({}, { username: null, lockWaits: 'type-password' })
    const first = await f.open()
    expect(first.wait).toEqual({ other: false })
    expect(first.ask).toBeUndefined()
    const shown = await f.send('wait')
    const said = shown.say.join('\n')
    expect(said).toContain(`Open ${AUDIENCE}/device and enter BCDF-GHJK`)
    expect(said).toContain(`${AUDIENCE}/device?code=BCDF-GHJK`)
    expect(shown.wait).toEqual({ other: false })
    const done = await f.send('wait')
    expect(done.exit).toBe(0)
    expect(done.say.join(' ')).toContain('Signed in as @')
    // No password was typed, so the lock is off until the account password is
    // typed here once; said on the terminal, never as a modal on its screen.
    expect(done.say.join(' ')).toContain('will not lock itself')
    expect(done.say.join(' ')).toContain('typed on it once')
    expect(done.say.join(' ')).not.toContain('passcode')
    expect(f.account.signIn).not.toHaveBeenCalled()
    expect(f.audits.at(-1)?.details).toContain('in the browser')
  })

  it('passes a typed name to the page as a prefill', async () => {
    const f = fixture()
    await f.open(['drej'])
    await f.send('wait')
    expect(f.account.browserDevice).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal), 'drej')
  })

  it('renews an ended session on the page, the account name prefilled, passwordless or not', async () => {
    for (const passwordless of [false, true]) {
      const f = fixture({}, { username: 'octo', passwordless })
      await f.open()
      await f.send('wait')
      expect(f.account.browserDevice).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal), 'octo')
      expect((await f.send('wait')).exit).toBe(0)
      expect(f.account.resume).not.toHaveBeenCalled()
    }
  })

  it('says denied, expired, cancelled and another account in the browser’s own words', async () => {
    const cases = [
      ['denied', 'refused in the browser'],
      ['expired', 'went cold'],
      ['wrong_identity', 'not the one on this Mac'],
    ] as const
    for (const [reason, words] of cases) {
      const f = fixture({ browserDevice: coded({ ok: false, reason }) })
      await f.open()
      await f.send('wait')
      const end = await f.send('wait')
      expect(end.exit).toBe(1)
      expect(end.say.join(' ')).toContain(words)
      expect(end.say.join(' ')).not.toContain('GitHub')
    }
  })

  it('Ctrl-C ends the poll: the signal the page waits on is aborted', async () => {
    let seen: AbortSignal | null = null
    const hanging = vi.fn(
      (onCode: (code: BrowserCode) => void, signal: AbortSignal) =>
        new Promise<SignInAnswer<unknown>>((resolve) => {
          seen = signal
          onCode(CODE)
          signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }))
        }),
    ) as unknown as BrowserSeam
    const f = fixture({ browserDevice: hanging })
    await f.open()
    await f.send('wait')
    f.connection.end()
    await vi.waitFor(() => expect((seen as AbortSignal | null)?.aborted).toBe(true))
    expect(f.released).toEqual(['term-owner'])
  })
})

describe('the old ways stay', () => {
  it('--password keeps the password conversation and never asks the page', async () => {
    const f = fixture()
    const first = await f.open(['drej'], { tty: true, password: true })
    expect(first.ask?.kind).toBe('hidden')
    expect((await f.send('answer', 'pw')).exit).toBe(0)
    expect(f.account.signIn).toHaveBeenCalledWith({ username: 'drej', password: 'pw' })
    expect(f.account.browserDevice).not.toHaveBeenCalled()
  })

  it('--github keeps GitHub’s device flow', async () => {
    const f = fixture()
    await f.open([], { tty: true, github: true })
    await f.send('wait')
    expect(f.account.providerDevice).toHaveBeenCalled()
    expect(f.account.browserDevice).not.toHaveBeenCalled()
  })

  it('a door without the page is the password conversation, unchanged', async () => {
    const f = fixture({ browserDevice: undefined })
    expect((await f.open(['drej'])).ask?.kind).toBe('hidden')
  })

  it('an older registry falls back to the name and the password', async () => {
    const f = fixture({ browserDevice: unsupported })
    await f.open()
    const asked = await f.send('wait')
    expect(asked.ask).toEqual({ kind: 'text', prompt: 'Username: ' })
    expect((await f.send('answer', 'drej')).ask?.kind).toBe('hidden')
    expect((await f.send('answer', 'pw')).exit).toBe(0)
    expect(f.account.signIn).toHaveBeenCalledWith({ username: 'drej', password: 'pw' })
  })

  it('an older registry renews with the password, or says a passwordless account cannot', async () => {
    const f = fixture({ browserDevice: unsupported }, { username: 'octo' })
    await f.open()
    expect((await f.send('wait')).ask?.prompt).toContain('@octo')
    expect((await f.send('answer', 'pw')).exit).toBe(0)
    expect(f.account.resume).toHaveBeenCalledWith('pw')

    const none = fixture({ browserDevice: unsupported }, { username: 'octo', passwordless: true })
    await none.open()
    const said = await none.send('wait')
    expect(said.exit).toBe(1)
    expect(said.say.join(' ')).toContain('has no password')
  })
})

describe('the real account door, a fake registry', () => {
  let base: string | null = null
  afterEach(() => {
    if (base !== null) rmSync(base, { recursive: true, force: true })
    base = null
  })

  it('polls 202 until the page finishes, then 201 lands this Mac', async () => {
    base = mkdtempSync(path.join(tmpdir(), 'login-browser-'))
    const registry = new FakeRegistry()
    registry.pending = 2
    const opened: string[] = []
    const accounts = new Accounts({
      base,
      origin: ORIGIN,
      deviceName: 'Linux · box',
      fetch: registry.fetch,
      now: () => NOW,
      openBrowser: (url) => void opened.push(url),
    })
    const deps: AccountIpcDeps = {
      accounts,
      lock: new IdleLock({ lockAfterMs: 60_000, verify: () => false }),
      requests: new Requests({ accounts, notify: () => undefined }),
      factors: new Factors({ accounts, registry: ORIGIN }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false }),
    }
    const f = wire(accountDoor(deps, 'linux'))
    await f.open()
    const shown = await f.send('wait')
    expect(shown.say.join('\n')).toContain('enter BCDF-GHJK')
    const done = await f.send('wait')
    expect(done.exit).toBe(0)
    expect(done.say.join(' ')).toContain('Signed in as @octo')
    expect(registry.calls('/v2/auth/token').map((call) => Object.keys(call.body).sort().join(','))).toEqual([
      'request,verifier',
      'request,verifier',
      'request,verifier',
    ])
    // The page without the code: the person types what the terminal printed.
    expect(opened).toEqual([`${AUDIENCE}/device`])
    expect(loadAccount(base)).toMatchObject({ username: 'octo', name: 'Linux · box', fromTerminal: true })
    expect(loadAccount(base)?.unlockBy).toBeUndefined()
    deps.requests.stop()
  })
})
