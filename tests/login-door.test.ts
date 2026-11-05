// `cookrew login`, the half that decides. The CLI is a printer and a keyboard:
// everything that can be wrong about signing in from a terminal is decided here,
// so it is pinned here, against a fake account. The real account, a real registry
// and a real pty are in login-registry-e2e.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { LoginDoor, LoginRefused, type AccountDoor, type LoginAudit, type LoginTurn } from '../src/main/login-cli'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'
import type { LadderFactor, SecondFactorStep, SignInAnswer } from '../src/shared/account-v2'

const PASSWORD = 'SENTINEL-password-never-repeat'
const CODE = '845120'
const RESCUE = 'SENTINEL-RESCUE-CODE'
const pane = { id: 'term-owner', kind: 'terminal', name: 'shell' } as unknown as TerminalNodeData

const step = (next: readonly LadderFactor[], match: string | null = '42'): SecondFactorStep => ({
  pending: 'pending-1',
  next,
  expiresAt: Date.now() + 600_000,
  ...(match === null ? {} : { match })
})
const ladder = (next: readonly LadderFactor[], match: string | null = '42'): SignInAnswer<unknown> => ({
  ok: false,
  reason: 'second_factor',
  step: step(next, match),
  message: 'One more step. Prove it is you.'
})
const landed: SignInAnswer<unknown> = { ok: true, value: {} }

interface Fixture {
  door: LoginDoor
  account: AccountDoor
  audits: LoginAudit[]
  sealed: string[]
  released: string[]
  connection: EventEmitter
  open: (args?: string[], flags?: CliRequest['flags']) => Promise<LoginTurn>
  send: (verb: string, secret?: string) => Promise<LoginTurn>
}

const request = (cmd: string, args: string[], flags: CliRequest['flags'] = { tty: true }): CliRequest => ({
  id: 'r',
  terminalId: 'term-owner',
  cmd,
  args,
  flags
})

function fixture(
  over: Partial<AccountDoor> = {},
  cmd = 'login',
  extra: { busy?: boolean; sessionId?: string; driven?: boolean; idleMs?: number } = {}
): Fixture {
  const audits: LoginAudit[] = []
  const sealed: string[] = []
  const released: string[] = []
  const account: AccountDoor = {
    platform: 'linux',
    who: () => ({ username: null, deviceId: 'dev-1', deviceName: 'Linux · box', sessionLive: false, registry: null, mismatch: null }),
    signIn: vi.fn(async () => landed),
    resume: vi.fn(async () => landed),
    climbCode: vi.fn(async () => landed),
    askApproval: vi.fn(async () => ({ ok: true as const, value: { approval: 'a', expiresAt: 0, sentence: 's' } })),
    waitApproval: vi.fn(async () => landed),
    abandon: vi.fn(),
    signOut: vi.fn(async () => ({ ok: true as const, value: {} })),
    devices: vi.fn(async () => ({ ok: true as const, value: [] })),
    ...over
  }
  const door = new LoginDoor({
    account: () => account,
    ownerPane: () => pane,
    agentBusy: () => extra.busy === true,
    driven: () => extra.driven === true,
    ...(extra.idleMs === undefined ? {} : { idleMs: extra.idleMs }),
    seal: (id) => {
      sealed.push(id)
      return () => released.push(id)
    },
    audit: (event) => audits.push(event),
    sleep: async () => undefined
  })
  const connection = new EventEmitter()
  const ask = async (verb: string, args: string[], flags: CliRequest['flags'] | undefined, secret?: string): Promise<LoginTurn> => {
    const sent = { ...request(cmd, [verb, ...args], flags), ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) }
    return JSON.parse(await door.handle(sent, secret, connection)) as LoginTurn
  }
  return {
    door,
    account,
    audits,
    sealed,
    released,
    connection,
    open: (args = ['drej'], flags) => ask('open', args, flags),
    send: (verb, secret) => ask(verb, [], undefined, secret)
  }
}

const refusal = async (run: () => Promise<unknown>): Promise<LoginRefused> => {
  const caught = await run().catch((error: unknown) => error)
  expect(caught).toBeInstanceOf(LoginRefused)
  return caught as LoginRefused
}

describe('who may open it', () => {
  it('is only ever the owner pane the rule names, the same rule as `cookrew secret`', async () => {
    const door = new LoginDoor({
      account: () => null,
      ownerPane: () => {
        throw new LoginRefused("refused: signing in is the owner's — never from a served session", 3)
      },
      agentBusy: () => false,
      driven: () => false,
      seal: () => () => undefined,
      audit: () => undefined,
      sleep: async () => undefined
    })
    const refused = await refusal(() => door.handle(request('login', ['open']), undefined, new EventEmitter()))
    expect(refused.exitCode).toBe(3)
    expect(refused.message).toContain('never from a served session')
  })

  it('refuses a command with no keyboard, and the attempt is on the record', async () => {
    const f = fixture()
    const refused = await refusal(() => f.open(['drej'], { tty: false }))
    expect(refused.exitCode).toBe(3)
    expect(refused.message).toContain('a person at a terminal')
    expect(f.sealed).toEqual([])
    expect(f.account.signIn).not.toHaveBeenCalled()
    expect(f.audits).toMatchObject([{ type: 'account.login-refused', terminalId: 'term-owner' }])
  })

  it('refuses a caller whose own process tree is a claude session', async () => {
    const f = fixture({}, 'login', { sessionId: '11111111-1111-1111-1111-111111111111' })
    const refused = await refusal(() => f.open())
    expect(refused.exitCode).toBe(3)
    expect(refused.message).toContain('an agent')
    expect(f.audits).toMatchObject([{ type: 'account.login-refused' }])
  })

  it('refuses a pane whose agent is mid-turn: a faked tty does not get past this', async () => {
    const f = fixture({}, 'login', { busy: true })
    const refused = await refusal(() => f.open())
    expect(refused.exitCode).toBe(3)
    expect(refused.message).toContain('working')
    expect(f.sealed).toEqual([])
  })

  it('refuses a pane an agent typed into: the keys, not the caller, give it away', async () => {
    const f = fixture({}, 'login', { driven: true })
    const refused = await refusal(() => f.open())
    expect(refused.exitCode).toBe(3)
    expect(refused.message).toContain('not a keyboard')
    expect(f.sealed).toEqual([])
    expect(f.audits).toMatchObject([{ type: 'account.login-refused' }])
  })

  it('holds logout to the driven rule too: `ask --raw "cookrew logout"`', async () => {
    const f = fixture({}, 'logout', { driven: true })
    await refusal(() => f.open([]))
    expect(f.account.signOut).not.toHaveBeenCalled()
  })

  it('holds logout to the same gate', async () => {
    const f = fixture({}, 'logout', { busy: true })
    await refusal(() => f.open([]))
    expect(f.account.signOut).not.toHaveBeenCalled()
  })

  it('refuses a door this app does not have, rather than failing open', async () => {
    const door = new LoginDoor({
      account: () => null,
      ownerPane: () => pane,
      agentBusy: () => false,
      driven: () => false,
      seal: () => () => undefined,
      audit: () => undefined,
      sleep: async () => undefined
    })
    const refused = await refusal(() => door.handle(request('login', ['open']), undefined, new EventEmitter()))
    expect(refused.exitCode).toBe(3)
  })

  it('takes one conversation at a time: two ladders on one machine are two keys', async () => {
    const f = fixture()
    await f.open()
    const other = new EventEmitter()
    const refused = await refusal(() => f.door.handle(request('login', ['open', 'drej']), undefined, other))
    expect(refused.message).toContain('already')
  })

  it('answers nothing on a connection that never opened', async () => {
    const f = fixture()
    await refusal(() => f.send('answer', PASSWORD))
    expect(f.account.signIn).not.toHaveBeenCalled()
  })
})

describe('the seal', () => {
  it('is on before the first prompt, and off the moment the connection goes', async () => {
    const f = fixture()
    const turn = await f.open()
    expect(turn.ask).toMatchObject({ kind: 'hidden' })
    expect(f.sealed).toEqual(['term-owner'])
    expect(f.released).toEqual([])
    f.connection.emit('close')
    expect(f.released).toEqual(['term-owner'])
  })

  it('is off when the conversation ends, whatever the connection does', async () => {
    const f = fixture()
    await f.open()
    await f.send('answer', PASSWORD)
    expect(f.released).toEqual(['term-owner'])
  })
})

describe('the password step', () => {
  it('asks for a username first when none was given, with echo on', async () => {
    const f = fixture()
    const turn = await f.open([])
    expect(turn.ask).toMatchObject({ kind: 'text' })
    const next = await f.send('answer', '@drej')
    expect(next.ask).toMatchObject({ kind: 'hidden' })
    expect(next.ask?.prompt).toContain('@drej')
  })

  it('reads the password hidden and hands it to the existing sign-in', async () => {
    const f = fixture()
    await f.open()
    await f.send('answer', PASSWORD)
    expect(f.account.signIn).toHaveBeenCalledWith({ username: 'drej', password: PASSWORD })
  })

  it('names the account and the device as cookrew.dev filed it', async () => {
    const f = fixture({
      who: () => ({ username: 'drej', deviceId: 'dev-1', deviceName: 'local name', sessionLive: true, registry: null, mismatch: null }),
      devices: async () => ({
        ok: true,
        value: [{ id: 'dev-1', name: 'Linux · solis-model-test', kind: 'desktop' }] as never
      })
    })
    ;(f.account as { who: AccountDoor['who'] }).who = vi
      .fn()
      .mockReturnValueOnce({ username: null, deviceId: '', deviceName: '', sessionLive: false, registry: null, mismatch: null })
      .mockReturnValue({ username: 'drej', deviceId: 'dev-1', deviceName: 'local name', sessionLive: true, registry: null, mismatch: null })
    await f.open()
    const turn = await f.send('answer', PASSWORD)
    expect(turn.exit).toBe(0)
    expect(turn.say.join(' ')).toContain('@drej')
    expect(turn.say.join(' ')).toContain('Linux · solis-model-test')
    expect(turn.say.join(' ')).toContain('this machine')
    expect(f.audits).toMatchObject([{ type: 'account.login', terminalId: 'term-owner' }])
  })

  it('falls back to the name it sent when the list cannot be read', async () => {
    const f = fixture({ devices: async () => ({ ok: false, reason: 'offline' }) })
    ;(f.account as { who: AccountDoor['who'] }).who = vi
      .fn()
      .mockReturnValueOnce({ username: null, deviceId: '', deviceName: '', sessionLive: false, registry: null, mismatch: null })
      .mockReturnValue({ username: 'drej', deviceId: 'dev-1', deviceName: 'Linux · box', sessionLive: true, registry: null, mismatch: null })
    await f.open()
    const turn = await f.send('answer', PASSWORD)
    expect(turn.say.join(' ')).toContain('Linux · box')
  })

  it('asks again after a wrong password, three times and no more', async () => {
    const wrong: SignInAnswer<unknown> = { ok: false, reason: 'session-expired', message: 'That is not the password.' }
    const f = fixture({ signIn: vi.fn(async () => wrong) })
    await f.open()
    const second = await f.send('answer', 'one')
    expect(second.say).toContain('That is not the password.')
    expect(second.ask).toMatchObject({ kind: 'hidden' })
    const third = await f.send('answer', 'two')
    expect(third.ask).toMatchObject({ kind: 'hidden' })
    const over = await f.send('answer', 'three')
    expect(over.ask).toBeUndefined()
    expect(over.exit).toBe(1)
  })

  it('stops at once on a refusal that typing again cannot fix', async () => {
    const f = fixture({ signIn: vi.fn(async () => ({ ok: false as const, reason: 'rate_limited' as const })) })
    await f.open()
    const turn = await f.send('answer', PASSWORD)
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('slow down')
  })
})

describe('an account already here', () => {
  const held = (live: boolean) => () => ({
    username: 'drej',
    deviceId: 'dev-1',
    deviceName: 'Linux · box',
    sessionLive: live,
    registry: 'https://cookrew.dev',
    mismatch: null
  })

  it('says who, asks nothing, seals nothing', async () => {
    const f = fixture({ who: held(true) })
    const turn = await f.open([])
    expect(turn.exit).toBe(0)
    expect(turn.say.join(' ')).toContain('@drej')
    expect(turn.ask).toBeUndefined()
    expect(f.released).toEqual(f.sealed)
  })

  it('refuses another name, and says the way out', async () => {
    const f = fixture({ who: held(true) })
    const turn = await f.open(['anvz'])
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('cookrew logout')
  })

  it('renews an ended session on the device it already is', async () => {
    const f = fixture({ who: held(false) })
    const first = await f.open([])
    expect(first.ask).toMatchObject({ kind: 'hidden' })
    await f.send('answer', PASSWORD)
    expect(f.account.resume).toHaveBeenCalledWith(PASSWORD)
    expect(f.account.signIn).not.toHaveBeenCalled()
  })

  it('will not renew against the wrong registry', async () => {
    const f = fixture({
      who: () => ({ ...held(false)(), mismatch: { signedInAt: 'https://cookrew.dev', pointedAt: 'http://127.0.0.1:9' } })
    })
    const turn = await f.open([])
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('http://127.0.0.1:9')
  })
})

describe('the ladder', () => {
  const climbing = async (next: readonly LadderFactor[], over: Partial<AccountDoor> = {}, match: string | null = '42') => {
    const f = fixture({ signIn: vi.fn(async () => ladder(next, match)), ...over })
    await f.open()
    const turn = await f.send('answer', PASSWORD)
    return { f, turn }
  }

  it('offers approve, then the authenticator, then a recovery code', async () => {
    const { turn } = await climbing(['totp', 'approve', 'recovery'])
    expect(turn.ask?.kind).toBe('choice')
    expect(turn.ask?.options?.map((option) => option.label)).toEqual([
      'Approve on another device',
      'Authenticator code',
      'Recovery code'
    ])
  })

  it('says a passkey cannot happen here, and offers the next rung', async () => {
    const { turn } = await climbing(['passkey', 'totp', 'approve', 'recovery'])
    expect(turn.say.join(' ')).toMatch(/passkey/i)
    expect(turn.ask?.options?.map((option) => option.label)).not.toContain('Passkey')
    expect(turn.ask?.options).toHaveLength(3)
  })

  it('has nowhere to go on a passkey alone, and says so with a next step', async () => {
    const { f, turn } = await climbing(['passkey'])
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toMatch(/passkey/i)
    expect(f.account.abandon).toHaveBeenCalledWith('pending-1')
  })

  it('goes straight to the only rung there is', async () => {
    const { turn } = await climbing(['recovery'])
    expect(turn.ask).toMatchObject({ kind: 'hidden' })
  })

  it('climbs the authenticator rung with the digits read hidden', async () => {
    const { f } = await climbing(['totp', 'recovery'])
    const asked = await f.send('answer', '1')
    expect(asked.ask).toMatchObject({ kind: 'hidden' })
    const turn = await f.send('answer', CODE)
    expect(f.account.climbCode).toHaveBeenCalledWith('pending-1', 'totp', CODE)
    expect(turn.exit).toBe(0)
  })

  it('takes the first rung on a bare Enter, and asks again on nonsense', async () => {
    const { f } = await climbing(['totp', 'recovery'])
    const again = await f.send('answer', '9')
    expect(again.ask?.kind).toBe('choice')
    const asked = await f.send('answer', '')
    expect(asked.ask?.kind).toBe('hidden')
  })

  it('keeps the rung open on a wrong code, and says the registry sentence verbatim', async () => {
    const climbCode = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'bad_code', message: 'Not that one.' })
      .mockResolvedValueOnce(landed)
    const { f } = await climbing(['totp', 'recovery'], { climbCode })
    await f.send('answer', '1')
    const retry = await f.send('answer', '000000')
    expect(retry.say).toContain('Not that one.')
    expect(retry.ask).toMatchObject({ kind: 'hidden' })
    expect((await f.send('answer', CODE)).exit).toBe(0)
  })

  it('climbs the recovery rung', async () => {
    const { f } = await climbing(['totp', 'recovery'])
    await f.send('answer', '2')
    await f.send('answer', RESCUE)
    expect(f.account.climbCode).toHaveBeenCalledWith('pending-1', 'recovery', RESCUE)
  })

  it('ends when the ladder is over, and forgets the pending', async () => {
    const { f } = await climbing(['totp', 'recovery'], {
      climbCode: vi.fn(async () => ({ ok: false as const, reason: 'too_many_attempts' as const }))
    })
    await f.send('answer', '1')
    const turn = await f.send('answer', CODE)
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('Run cookrew login')
    expect(f.account.abandon).toHaveBeenCalledWith('pending-1')
  })

  it('prints the number to match, then waits', async () => {
    const { f } = await climbing(['approve', 'totp'], {}, '73')
    const asked = await f.send('answer', '1')
    expect(f.account.askApproval).toHaveBeenCalledWith('pending-1')
    expect(asked.say.join(' ')).toContain('73')
    expect(asked.wait).toBeDefined()
    expect((await f.send('wait')).exit).toBe(0)
    expect(f.account.waitApproval).toHaveBeenCalled()
  })

  it('drops the approve rung when cookrew.dev sent no number, and says why', async () => {
    const { turn } = await climbing(['approve', 'totp', 'recovery'], {}, null)
    expect(turn.say.join(' ')).toMatch(/cannot be approved/)
    expect(turn.ask?.options?.map((option) => option.label)).toEqual(['Authenticator code', 'Recovery code'])
  })

  it('goes back to the rungs when the owner stops waiting, with the ladder still standing', async () => {
    let release: (answer: SignInAnswer<unknown>) => void = () => undefined
    const waitApproval = vi.fn(
      (_pending: string, signal: AbortSignal) =>
        new Promise<SignInAnswer<unknown>>((resolve) => {
          release = resolve
          signal.addEventListener('abort', () => resolve({ ok: false, reason: 'expired' }))
        })
    )
    const { f } = await climbing(['approve', 'totp'], { waitApproval })
    await f.send('answer', '1')
    const waiting = f.send('wait')
    await vi.waitFor(() => expect(waitApproval).toHaveBeenCalled())
    await f.send('stop')
    const turn = await waiting
    expect(turn.ask?.kind).toBe('choice')
    expect(f.account.abandon).not.toHaveBeenCalled()
    release(landed)
  })

  it('keeps waiting through a dropped connection to cookrew.dev', async () => {
    const waitApproval = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'offline' }).mockResolvedValueOnce(landed)
    const { f } = await climbing(['approve', 'totp'], { waitApproval })
    await f.send('answer', '1')
    const first = await f.send('wait')
    expect(first.wait).toBeDefined()
    expect((await f.send('wait')).exit).toBe(0)
  })

  it('says a denial plainly and stops', async () => {
    const { f } = await climbing(['approve', 'totp'], {
      waitApproval: vi.fn(async () => ({ ok: false as const, reason: 'denied' as const }))
    })
    await f.send('answer', '1')
    const turn = await f.send('wait')
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('denied')
  })

  it('walks away cleanly: a closed connection stops the wait and forgets the ladder', async () => {
    let aborted = false
    const waitApproval = vi.fn(
      (_pending: string, signal: AbortSignal) =>
        new Promise<SignInAnswer<unknown>>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve({ ok: false, reason: 'expired' })
          })
        })
    )
    const { f } = await climbing(['approve', 'totp'], { waitApproval })
    await f.send('answer', '1')
    const waiting = f.send('wait')
    await vi.waitFor(() => expect(waitApproval).toHaveBeenCalled())
    f.connection.emit('close')
    await waiting.catch(() => undefined)
    expect(aborted).toBe(true)
    expect(f.account.abandon).toHaveBeenCalledWith('pending-1')
    expect(f.released).toEqual(['term-owner'])
    // And the next person in is not told a sign-in is already open.
    const next = new EventEmitter()
    await expect(f.door.handle(request('login', ['open', 'drej']), undefined, next)).resolves.toBeTypeOf('string')
  })
})

describe('an act already on the wire when the terminal goes', () => {
  const held = <T,>(): { promise: Promise<T>; settle: (value: T) => void } => {
    let settle: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      settle = resolve
    })
    return { promise, settle }
  }

  it('keeps the minted key until the rung answers: a device must not be orphaned', async () => {
    const rung = held<SignInAnswer<unknown>>()
    const f = fixture({
      signIn: vi.fn(async () => ladder(['totp', 'recovery'])),
      climbCode: vi.fn(() => rung.promise)
    })
    await f.open()
    await f.send('answer', PASSWORD)
    await f.send('answer', '1')
    const flying = f.send('answer', CODE)
    await vi.waitFor(() => expect(f.account.climbCode).toHaveBeenCalled())
    f.connection.emit('close')
    // The keys are free at once. The ladder is not touched while the rung flies.
    expect(f.released).toEqual(['term-owner'])
    expect(f.account.abandon).not.toHaveBeenCalled()
    rung.settle(landed)
    await flying
    expect(f.account.abandon).not.toHaveBeenCalled()
    expect(f.audits.map((audit) => audit.type)).toEqual(['account.login'])
    expect(f.audits[0]?.details).toContain('after the terminal left')
  })

  it('abandons the ladder once the rung comes back refused', async () => {
    const rung = held<SignInAnswer<unknown>>()
    const f = fixture({
      signIn: vi.fn(async () => ladder(['totp', 'recovery'])),
      climbCode: vi.fn(() => rung.promise)
    })
    await f.open()
    await f.send('answer', PASSWORD)
    await f.send('answer', '1')
    const flying = f.send('answer', CODE)
    await vi.waitFor(() => expect(f.account.climbCode).toHaveBeenCalled())
    f.connection.emit('close')
    rung.settle({ ok: false, reason: 'bad_code' })
    await flying
    expect(f.account.abandon).toHaveBeenCalledWith('pending-1')
    expect(f.audits.map((audit) => audit.type)).toEqual(['account.login-refused'])
  })

  it('forgets a ladder that only opened after the terminal left, and asks nobody', async () => {
    const password = held<SignInAnswer<unknown>>()
    const f = fixture({ signIn: vi.fn(() => password.promise) })
    await f.open()
    const flying = f.send('answer', PASSWORD)
    await vi.waitFor(() => expect(f.account.signIn).toHaveBeenCalled())
    f.connection.emit('close')
    password.settle(ladder(['approve']))
    await flying
    expect(f.account.askApproval).not.toHaveBeenCalled()
    expect(f.account.abandon).toHaveBeenCalledWith('pending-1')
  })
})

describe('nothing waits for ever', () => {
  it('ends a conversation left at a prompt: the seal and the door both come back', async () => {
    const f = fixture({}, 'login', { idleMs: 10 })
    await f.open()
    await vi.waitFor(() => expect(f.released).toEqual(['term-owner']))
    await expect(f.door.handle(request('login', ['open', 'drej']), undefined, new EventEmitter())).resolves.toBeTypeOf('string')
  })

  it('a throw on the way in leaves the door open for the next one', async () => {
    let broken = true
    const f = fixture({
      who: () => {
        if (broken) throw new Error('the file could not be read')
        return { username: null, deviceId: '', deviceName: '', sessionLive: false, registry: null, mismatch: null }
      }
    })
    await expect(f.open()).rejects.toThrow('could not be read')
    broken = false
    await expect(f.door.handle(request('login', ['open', 'drej']), undefined, new EventEmitter())).resolves.toBeTypeOf('string')
  })

  it('reads a name that is not a string as no name', async () => {
    const f = fixture()
    const turn = JSON.parse(
      await f.door.handle(request('login', ['open', 7 as unknown as string]), undefined, f.connection)
    ) as LoginTurn
    expect(turn.ask).toMatchObject({ kind: 'text' })
  })
})

describe('logout', () => {
  const signedIn = () => ({
    username: 'drej',
    deviceId: 'dev-1',
    deviceName: 'Linux · box',
    sessionLive: true,
    registry: 'https://cookrew.dev',
    mismatch: null
  })

  it('asks for the password, hidden, then leaves through the existing sign-out', async () => {
    const f = fixture({ who: signedIn }, 'logout')
    const first = await f.open([])
    expect(first.ask).toMatchObject({ kind: 'hidden' })
    const turn = await f.send('answer', PASSWORD)
    expect(f.account.signOut).toHaveBeenCalledWith(PASSWORD)
    expect(turn.exit).toBe(0)
    expect(turn.say.join(' ')).toContain('@drej')
    expect(f.audits).toMatchObject([{ type: 'account.logout' }])
  })

  it('says to sign in first when the session has ended, instead of doubting the password', async () => {
    const f = fixture({ who: () => ({ ...signedIn(), sessionLive: false }) }, 'logout')
    const turn = await f.open([])
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('cookrew login')
    expect(f.account.signOut).not.toHaveBeenCalled()
  })

  it('says there is nothing to leave', async () => {
    const f = fixture({}, 'logout')
    const turn = await f.open([])
    expect(turn.exit).toBe(0)
    expect(turn.say.join(' ')).toContain('Not signed in')
  })

  it('reports the last device refusal, and what would be lost', async () => {
    const f = fixture(
      { who: signedIn, signOut: vi.fn(async () => ({ ok: false as const, reason: 'last_device' as const })) },
      'logout'
    )
    await f.open([])
    const turn = await f.send('answer', PASSWORD)
    expect(turn.exit).toBe(1)
    expect(turn.say.join(' ')).toContain('last device')
  })
})

describe('whoami', () => {
  const whoami = (who: ReturnType<AccountDoor['who']>) => {
    const f = fixture({ who: () => who })
    return f.door.whoami(request('whoami', [], {}))
  }

  it('names the account, the device and the registry', () => {
    const line = whoami({ username: 'drej', deviceId: 'd', deviceName: 'Linux · box', sessionLive: true, registry: 'https://cookrew.dev', mismatch: null })
    expect(line).toContain('@drej')
    expect(line).toContain('Linux · box')
    expect(line).toContain('https://cookrew.dev')
  })

  it('exits 1 when nobody is signed in, so a script can branch on it', async () => {
    const refused = await refusal(async () =>
      whoami({ username: null, deviceId: '', deviceName: '', sessionLive: false, registry: null, mismatch: null })
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.message).toContain('cookrew login')
  })

  it('says a session has ended rather than naming a dead one as live', async () => {
    const refused = await refusal(async () =>
      whoami({ username: 'drej', deviceId: 'd', deviceName: 'Linux · box', sessionLive: false, registry: null, mismatch: null })
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.message).toContain('ended')
  })

  it('needs no tty: it is safe for an agent to ask', () => {
    const f = fixture({}, 'login', { busy: true })
    expect(() => f.door.whoami(request('whoami', [], {}))).toThrow(/cookrew login/)
    expect(f.audits).toEqual([])
  })
})

describe('nothing typed comes back out', () => {
  it('leaves no answer in any reply or audit line, down every rung', async () => {
    const climbCode = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'bad_recovery' })
      .mockResolvedValueOnce(landed)
    const f = fixture({ signIn: vi.fn(async () => ladder(['totp', 'recovery'])), climbCode })
    const replies: LoginTurn[] = [await f.open()]
    replies.push(await f.send('answer', PASSWORD))
    replies.push(await f.send('answer', '2'))
    replies.push(await f.send('answer', RESCUE))
    replies.push(await f.send('answer', RESCUE))
    const all = JSON.stringify({ replies, audits: f.audits })
    expect(all).not.toContain(PASSWORD)
    expect(all).not.toContain(RESCUE)
    expect(all).not.toContain('pending-1')
  })
})
