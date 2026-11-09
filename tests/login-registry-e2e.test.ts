// `cookrew login`, END TO END, with nothing faked that matters: a real registry
// on a loopback port, the real account module, the real socket server, and the
// real CLI script reading from a real pseudo-terminal. A second account device
// plays the owner's phone. Only a real cookrew.dev account is missing, and that
// is on purpose (see the guard below).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { base32Decode, totpAt } from '../registry/src/v2-totp'
import { Accounts, accountFilePath, loadAccount, writeAccount, type AccountFile, type FetchLike } from '../src/main/account-v2'
import { accountDoor, type AccountIpcDeps } from '../src/main/account-ipc'
import { cliWrapper } from '../src/main/cli-shim'
import { paneInputs } from '../src/main/pane-input'
import type { LoginAudit } from '../src/main/login-cli'
import { startSocketServer, type SocketServerDeps } from '../src/main/socket-server'
import { fakeOAuth, type FakeOAuth } from './support/fake-oauth'

const USERNAME = 'solis-test'
const PASSWORD = 'SENTINEL correct horse battery staple'
const DEVICE = 'Linux · solis-model-test'
const CLI = path.resolve('cli/cookrew.mjs')

/**
 * CREDENTIALS GO TO LOOPBACK AND NOWHERE ELSE.
 *
 * Panes export COOKREW_REGISTRY=https://cookrew.dev, and a default picked up
 * from there would post this file's password to production. So this file names
 * its own registry, never reads the environment for one, and every request the
 * account makes goes through this check first.
 */
const assertLoopback = (url: string): string => {
  const { hostname, protocol } = new URL(url)
  if (protocol !== 'http:' || hostname !== '127.0.0.1') throw new Error(`refusing to send credentials to ${url}`)
  return url
}
const loopbackFetch: FetchLike = (input, init) => fetch(assertLoopback(String(input)), init)

/**
 * A REAL PSEUDO-TERMINAL, OUTSIDE THIS PROCESS TREE.
 *
 * Python's pty gives the CLI a tty. The CLI refuses a claude session in its
 * ancestry (rightly), and this suite is often run by one, so the pty lives in a
 * double-forked grandchild: orphaned, the walk up stops at pid 1 as it does for
 * a person at a shell. The direct child stays to relay bytes over two pipes,
 * because node closes a child's stdin when that child exits. The exit status
 * comes out as the last line, since nobody is left to wait for it.
 */
const PTY_BRIDGE = String.raw`
import os, pty, select, signal, sys
in_r, in_w = os.pipe()
out_r, out_w = os.pipe()
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    os.close(in_w)
    os.close(out_r)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    inputs = [fd, in_r]
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if fd in ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(out_w, data)
        if in_r in ready:
            data = os.read(in_r, 4096)
            if data:
                os.write(fd, data)
            else:
                os.kill(pid, signal.SIGKILL)
                inputs = [fd]
    _, status = os.waitpid(pid, 0)
    os.write(out_w, ('\n@@exit=%d\n' % os.waitstatus_to_exitcode(status)).encode())
    os._exit(0)
os.close(in_r)
os.close(out_w)
inputs = [0, out_r]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if out_r in ready:
        data = os.read(out_r, 4096)
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(in_w, data)
        else:
            os.close(in_w)
            inputs = [out_r]
`

// A swapping machine runs scrypt and a pty slowly; nothing here is a benchmark.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

const hasPython = spawnSync('python3', ['-c', 'import pty']).status === 0

/** A pty's bridge has no parent to die with, so each one is ended by hand. */
const terminals: Terminal[] = []

class Terminal {
  private child: ChildProcess
  transcript = ''

  constructor(command: readonly string[], env: Record<string, string>) {
    terminals.push(this)
    this.child = spawn('python3', ['-c', PTY_BRIDGE, ...command], { env, stdio: ['pipe', 'pipe', 'inherit'] })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.transcript += chunk.toString()
    })
  }

  /** Waits for `text` to be on the screen, and answers what followed it. */
  async sees(text: string | RegExp): Promise<void> {
    await vi.waitFor(
      () => {
        const found = typeof text === 'string' ? this.transcript.includes(text) : text.test(this.transcript)
        if (!found) throw new Error(`waiting for ${String(text)} in: ${this.transcript}`)
      },
      { timeout: 20_000, interval: 25 }
    )
  }

  type(text: string): void {
    this.child.stdin?.write(text)
  }

  end(): void {
    this.child.stdin?.end()
  }

  async exit(): Promise<number> {
    await this.sees(/@@exit=(-?\d+)/)
    return Number(/@@exit=(-?\d+)/.exec(this.transcript)?.[1])
  }
}

interface Box {
  accounts: Accounts
  audits: LoginAudit[]
  socketPath: string
  home: string
  close: () => Promise<void>
  hangUp: () => void
}

let dir = ''
let homes: string[] = []
let origin = ''
let server: Server
let boxes: Box[] = []
let github: FakeOAuth

beforeEach(async () => {
  github = await fakeOAuth()
  github.device.answer = 'ok'
  dir = mkdtempSync(path.join(tmpdir(), 'login-e2e-registry-'))
  homes = []
  boxes = []
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, { secondStep: 'legacy', oauth: github.config() })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = assertLoopback(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})

afterEach(async () => {
  for (const term of terminals.splice(0)) term.end()
  await Promise.all(boxes.map((box) => box.close()))
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await github.close()
  for (const home of [dir, ...homes]) rmSync(home, { recursive: true, force: true })
})

const scratchHome = (): string => {
  const home = mkdtempSync(path.join(tmpdir(), 'login-e2e-home-'))
  homes.push(home)
  return home
}

/** The owner's first device: already on the account, playing the phone. */
const ownerDevice = async (): Promise<{ accounts: Accounts; token: string }> => {
  const accounts = new Accounts({ base: scratchHome(), origin, deviceName: 'iPhone', fetch: loopbackFetch })
  const claimed = await accounts.claim({ username: USERNAME, password: PASSWORD })
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`)
  return { accounts, token: accounts.account()?.session?.token ?? '' }
}

const asOwner = (token: string, pathname: string, init: RequestInit = {}): Promise<Response> =>
  loopbackFetch(`${origin}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  })

/** The owner adds an authenticator, on their own device. Answers its secret. */
const enrolTotp = async (token: string): Promise<Buffer> => {
  const begun = (await (await asOwner(token, '/v2/me/totp/enrol', { method: 'POST', body: '{}' })).json()) as { secret: string }
  const secret = base32Decode(begun.secret) as Buffer
  const confirmed = await asOwner(token, '/v2/me/totp/confirm', {
    method: 'POST',
    body: JSON.stringify({ code: totpAt(secret, Date.now()) })
  })
  expect(confirmed.status).toBeLessThan(300)
  return secret
}

/** The registry spends a time step once, and enrolling spent this one. */
const freshCode = (secret: Buffer): string => totpAt(secret, Date.now() + 30_000)

/** The machine with no window: the real account and the real door, behind the real socket. */
const bootBox = async (home: string = scratchHome()): Promise<Box> => {
  const accounts = new Accounts({ base: home, origin, deviceName: DEVICE, platform: 'linux', fetch: loopbackFetch })
  const audits: LoginAudit[] = []
  const ipc = {
    accounts,
    lock: { proven: () => undefined, locked: false, lockAfterMs: 0 },
    requests: { start: () => undefined, stop: () => undefined, count: 0 },
    workspaces: () => [{ id: 'w1', name: 'solis' }],
    envUsername: null,
    saveCodes: async () => ({ ok: true })
  } as unknown as AccountIpcDeps
  const door = accountDoor(ipc, 'linux')
  const socketPath = path.join(home, `app-${boxes.length}.sock`)
  const pane = { id: 'term-box', kind: 'terminal', name: 'shell' }
  const handle = startSocketServer({
    ptys: { socketPath, get: () => undefined },
    store: { node: (id: string) => (id === pane.id ? pane : null), terminalsAcross: () => [], nodeAcrossWorkspaces: () => null },
    agents: {},
    turns: { phaseOf: () => 'idle', backendPhaseFor: () => undefined, dropDraft: () => undefined },
    isServed: () => false,
    account: () => door,
    auditLogin: (event: LoginAudit) => audits.push(event)
  } as unknown as SocketServerDeps)
  await handle.claim
  const sockets = new Set<Socket>()
  handle.server.on('connection', (socket) => sockets.add(socket))
  const box = {
    accounts,
    audits,
    socketPath,
    home,
    close: () => new Promise<void>((resolve) => handle.server.close(() => resolve())),
    hangUp: () => {
      for (const socket of sockets) socket.end()
    }
  }
  boxes.push(box)
  return box
}

/** A shell in that machine's pane. Nothing of this test's environment comes along. */
const shellOn = (box: Box, argv: readonly string[]): Terminal =>
  new Terminal([process.execPath, CLI, ...argv], {
    PATH: process.env.PATH ?? '',
    HOME: box.home,
    COOKREW_SOCKET: box.socketPath,
    COOKREW_TERMINAL_ID: 'term-box'
  })

const signedInThroughPassword = async (box: Box, term: Terminal): Promise<void> => {
  await term.sees(`Password for @${USERNAME}: `)
  term.type(`${PASSWORD}\r`)
  await term.sees('One more step')
}

const nothingTypedAnywhere = (box: Box, term: Terminal, ...typed: string[]): void => {
  const record = JSON.stringify({ transcript: term.transcript, audits: box.audits })
  for (const secret of [PASSWORD, ...typed]) expect(record).not.toContain(secret)
}

const piped = (box: Box, wrapper: readonly string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(wrapper[0] ?? '', wrapper.slice(1), {
      env: { PATH: process.env.PATH ?? '', HOME: box.home, COOKREW_SOCKET: box.socketPath, COOKREW_TERMINAL_ID: 'term-box' }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.stdin.end(`${PASSWORD}\n`)
    child.on('exit', (code) => resolve({ code, out, err }))
  })

describe.skipIf(!hasPython)('the guard on this file', () => {
  it('will not send a credential anywhere but loopback', async () => {
    expect(() => assertLoopback('https://cookrew.dev')).toThrow(/refusing/)
    expect(() => assertLoopback('http://10.0.0.1:8080')).toThrow(/refusing/)
    await expect(async () => loopbackFetch('https://cookrew.dev/v2/sessions')).rejects.toThrow(/refusing/)
  })
})

describe.skipIf(!hasPython)('a new machine signs in from a terminal', () => {
  it('approve: prints the number, the phone types it, and the machine is on the account', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees(/type this number: (\d\d)/)
    const match = /type this number: (\d\d)/.exec(term.transcript)?.[1]

    // The phone: the request is on its list without the number, as it must be.
    const listed = (await (await asOwner(owner.token, '/v2/me/approvals')).json()) as Array<{ id: string; match?: unknown }>
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(`"match":"${match}"`)
    const decided = await asOwner(owner.token, `/v2/me/approvals/${listed[0]?.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', match })
    })
    expect(decided.status).toBeLessThan(300)

    await term.sees(`Signed in as @${USERNAME}. cookrew.dev shows this machine as ${DEVICE}.`)
    expect(await term.exit()).toBe(0)

    // The account the registry holds, read as the phone reads it.
    const profile = (await (await asOwner(owner.token, '/v2/me')).json()) as {
      devices: Array<{ name: string }>
      desktops: Array<{ name: string; workspaces: Array<{ name: string }> }>
    }
    expect(profile.devices.map((device) => device.name)).toContain(DEVICE)
    await vi.waitFor(async () => {
      const again = (await (await asOwner(owner.token, '/v2/me')).json()) as typeof profile
      expect(again.desktops.find((desktop) => desktop.name === DEVICE)?.workspaces).toEqual([
        expect.objectContaining({ name: 'solis' })
      ])
    })

    // And this machine's own record of it.
    const file = accountFilePath(box.home)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain(PASSWORD)
    expect(loadAccount(box.home)).toMatchObject({ username: USERNAME, name: DEVICE })
    expect(paneInputs.sealed('term-box')).toBe(false)
    expect(box.audits).toMatchObject([{ type: 'account.login', terminalId: 'term-box' }])
    nothingTypedAnywhere(box, term)
  })

  it('authenticator: a wrong code keeps the rung open, the right one lands, neither is echoed', async () => {
    const owner = await ownerDevice()
    const secret = await enrolTotp(owner.token)
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees('Which one? [1]: ')
    term.type('2\r')
    await term.sees('Six digits from your authenticator: ')
    const right = freshCode(secret)
    const wrong = right === '000000' ? '111111' : '000000'
    term.type(`${wrong}\r`)
    await vi.waitFor(() => expect(term.transcript.split('Six digits').length).toBe(3), { timeout: 15_000 })
    term.type(`${right}\r`)
    await term.sees(`Signed in as @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
    nothingTypedAnywhere(box, term, wrong, right)
  })

  it('recovery: a real code from the account opens it, once', async () => {
    const owner = await ownerDevice()
    const minted = await owner.accounts.recoveryCodes()
    if (!minted.ok) throw new Error(minted.reason)
    const code = minted.value[0] ?? ''
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees('Which one? [1]: ')
    term.type('2\r')
    await term.sees('Recovery code: ')
    term.type(`${code}\r`)
    await term.sees(`Signed in as @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
    nothingTypedAnywhere(box, term, code)
  })

  it('asks for the username when it was not given, and a wrong password is said and asked again', async () => {
    const owner = await ownerDevice()
    expect(owner.token).not.toBe('')
    const box = await bootBox()
    const term = shellOn(box, ['login'])
    await term.sees('Username: ')
    term.type(`${USERNAME}\r`)
    await term.sees(`Password for @${USERNAME}: `)
    term.type('SENTINEL-wrong-password\r')
    await vi.waitFor(() => expect(term.transcript.split('Password for').length).toBe(3), { timeout: 15_000 })
    expect(existsSync(accountFilePath(box.home))).toBe(false)
    nothingTypedAnywhere(box, term, 'SENTINEL-wrong-password')
    term.type('\x03')
    expect(await term.exit()).toBe(130)
  })
})

describe.skipIf(!hasPython)('walking away', () => {
  it('Ctrl-C at the wait ends it: a nod that comes later signs nothing in', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees(/type this number: (\d\d)/)
    const match = /type this number: (\d\d)/.exec(term.transcript)?.[1]
    term.type('\x03')
    expect(await term.exit()).toBe(130)
    await vi.waitFor(() => expect(paneInputs.sealed('term-box')).toBe(false))

    const listed = (await (await asOwner(owner.token, '/v2/me/approvals')).json()) as Array<{ id: string }>
    await asOwner(owner.token, `/v2/me/approvals/${listed[0]?.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', match })
    })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(existsSync(accountFilePath(box.home))).toBe(false)
    const profile = (await (await asOwner(owner.token, '/v2/me')).json()) as { devices: Array<{ name: string }> }
    expect(profile.devices.map((device) => device.name)).not.toContain(DEVICE)
    expect(box.audits).toMatchObject([{ type: 'account.login-refused', details: 'left before it finished' }])
  })

  it('c at the wait goes back to the rungs, and the ladder still finishes', async () => {
    const owner = await ownerDevice()
    const secret = await enrolTotp(owner.token)
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees('Which one? [1]: ')
    term.type('1\r')
    await term.sees('Press c to use another way in.')
    term.type('c')
    await vi.waitFor(() => expect(term.transcript.split('Which one?').length).toBe(3), { timeout: 15_000 })
    term.type('2\r')
    await term.sees('Six digits from your authenticator: ')
    term.type(`${freshCode(secret)}\r`)
    await term.sees(`Signed in as @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
  })
})

describe.skipIf(!hasPython)('the app going away mid-prompt', () => {
  it('ends the CLI at once: nobody types a password into silence', async () => {
    await ownerDevice()
    const box = await bootBox()
    const term = shellOn(box, ['login', USERNAME])
    await term.sees(`Password for @${USERNAME}: `)
    box.hangUp()
    expect(await term.exit()).toBe(1)
    expect(term.transcript).toContain('Run this again')
  })
})

describe.skipIf(!hasPython)('an agent, or a script', () => {

  it('cannot pipe a password in, and the try is on the record', async () => {
    await ownerDevice()
    const box = await bootBox()
    const result = await piped(box, [process.execPath, CLI, 'login', USERNAME])
    expect(result.code).toBe(3)
    // Which refusal depends on who runs this suite: under a claude session the
    // caller's ancestry is refused first, which is the same door shut sooner.
    expect(result.err).toMatch(/a person at a terminal|run by an agent/)
    expect(result.out).toBe('')
    expect(paneInputs.sealed('term-box')).toBe(false)
    expect(box.audits).toMatchObject([{ type: 'account.login-refused', terminalId: 'term-box' }])
    expect(existsSync(accountFilePath(box.home))).toBe(false)
  })

  it('cannot get past by faking a terminal from inside a claude session', async () => {
    await ownerDevice()
    const box = await bootBox()
    const uuid = '11111111-2222-3333-4444-555555555555'
    const term = new Terminal(['/bin/sh', '-c', `"$0" "$@"; exit $? # --session-id ${uuid}`, process.execPath, CLI, 'login', USERNAME], {
      PATH: process.env.PATH ?? '',
      HOME: box.home,
      COOKREW_SOCKET: box.socketPath,
      COOKREW_TERMINAL_ID: 'term-box'
    })
    expect(await term.exit()).toBe(3)
    expect(term.transcript).toContain('run by an agent')
    expect(term.transcript).not.toContain('Password for')
    expect(box.audits).toMatchObject([{ type: 'account.login-refused' }])
  })

  it('refuses a password on the command line before a socket exists, and does not repeat it', async () => {
    const box = await bootBox()
    for (const argv of [['login', USERNAME, '--password', 'SENTINEL-argv'], ['login', USERNAME, 'SENTINEL-argv']]) {
      const result = await piped(box, [process.execPath, CLI, ...argv])
      expect(result.code).toBe(1)
      expect(result.err).toContain('hidden prompt')
      expect(result.err).not.toContain('SENTINEL-argv')
    }
    expect(box.audits).toEqual([])
  })
})

describe.skipIf(!hasPython)('cookrew login --github, through the real CLI', () => {
  it('shows the code, asks for a name in the open, and never asks for a password', async () => {
    const box = await bootBox()
    const term = shellOn(box, ['login', '--github'])
    await term.sees('type this code: WDJB-MJHT')
    await term.sees('Choose your Cookrew name [octo-cat]: ')
    term.type('\r')
    await term.sees('Signed in as @octo-cat')
    // No passcode to choose and no sheet on this screen: the terminal says why
    // the lock is off and what turns it on (owner, 2026-11-09).
    await term.sees('has no password yet')
    expect(await term.exit()).toBe(0)
    expect(term.transcript).not.toContain('Password for')
    expect(term.transcript).not.toContain('dev-code-secret')
    expect(term.transcript).not.toContain('passcode')
    expect(loadAccount(box.home)).toMatchObject({ username: 'octo-cat', passwordless: true, unlock: null, fromTerminal: true })
  })

  it('Ctrl-C at the wait ends it, and nothing is written', async () => {
    github.device.answer = 'pending'
    const box = await bootBox()
    const term = shellOn(box, ['login', '--github'])
    await term.sees('Waiting for GitHub')
    term.type('\x03')
    expect(await term.exit()).toBe(130)
    expect(existsSync(accountFilePath(box.home))).toBe(false)
    await vi.waitFor(() => expect(box.audits.map((a) => a.type)).toContain('account.login-refused'))
  })

  it('cookrew logout on a passwordless machine points at the app and asks for nothing', async () => {
    const box = await bootBox()
    const first = shellOn(box, ['login', '--github'])
    await first.sees('Choose your Cookrew name')
    first.type('nopass\r')
    expect(await first.exit()).toBe(0)
    const leaving = shellOn(box, ['logout'])
    await leaving.sees('has no password')
    expect(await leaving.exit()).toBe(1)
    expect(leaving.transcript).not.toContain('Password for')
    expect(existsSync(accountFilePath(box.home))).toBe(true)
  })

  it('takes no username beside the flag, and logout takes no flag, before a socket exists', async () => {
    const box = await bootBox()
    for (const argv of [['login', 'octo', '--github'], ['login', '--github', 'octo'], ['logout', '--github']]) {
      const result = await piped(box, [process.execPath, CLI, ...argv])
      expect(result.code).toBe(1)
      expect(result.err).toContain('cookrew login --github')
    }
    expect(box.audits).toEqual([])
  })

  it('a script has no keyboard, flag or not', async () => {
    const box = await bootBox()
    const result = await piped(box, [process.execPath, CLI, 'login', '--github'])
    expect(result.code).toBe(3)
    expect(github.device.polls).toBe(0)
  })
})

describe.skipIf(!hasPython)('whoami and logout', () => {
  const onTheAccount = async (box: Box, owner: { token: string }): Promise<void> => {
    const term = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, term)
    await term.sees(/type this number: (\d\d)/)
    const match = /type this number: (\d\d)/.exec(term.transcript)?.[1]
    const listed = (await (await asOwner(owner.token, '/v2/me/approvals')).json()) as Array<{ id: string; deviceName: string }>
    const mine = listed[listed.length - 1]
    await asOwner(owner.token, `/v2/me/approvals/${mine?.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve', match }) })
    expect(await term.exit()).toBe(0)
  }

  it('whoami names the account and the device, and needs no terminal', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    await onTheAccount(box, owner)
    const term = shellOn(box, ['whoami'])
    await term.sees(`@${USERNAME} on ${DEVICE} (${origin})`)
    expect(await term.exit()).toBe(0)
  })

  it('whoami exits 1 on a machine with no account', async () => {
    const box = await bootBox()
    const term = shellOn(box, ['whoami'])
    await term.sees('Not signed in on this machine.')
    expect(await term.exit()).toBe(1)
  })

  it('logout takes this machine off the account, and the file goes with it', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    await onTheAccount(box, owner)
    const term = shellOn(box, ['logout'])
    await term.sees(', to sign this machine out: ')
    term.type(`${PASSWORD}\r`)
    await term.sees(`Signed out. This machine left @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
    expect(existsSync(accountFilePath(box.home))).toBe(false)
    const profile = (await (await asOwner(owner.token, '/v2/me')).json()) as { devices: Array<{ name: string }> }
    expect(profile.devices.map((device) => device.name)).not.toContain(DEVICE)
    nothingTypedAnywhere(box, term)
  })

  it('logout works on an account with an authenticator, on the password alone', async () => {
    const owner = await ownerDevice()
    const secret = await enrolTotp(owner.token)
    const box = await bootBox()
    const login = shellOn(box, ['login', USERNAME])
    await signedInThroughPassword(box, login)
    await login.sees('Which one? [1]: ')
    login.type('2\r')
    await login.sees('Six digits from your authenticator: ')
    login.type(`${freshCode(secret)}\r`)
    expect(await login.exit()).toBe(0)
    const term = shellOn(box, ['logout'])
    await term.sees(', to sign this machine out: ')
    term.type(`${PASSWORD}\r`)
    await term.sees(`Signed out. This machine left @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
    expect(existsSync(accountFilePath(box.home))).toBe(false)
  })

  it('logout with the wrong password changes nothing', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    await onTheAccount(box, owner)
    const term = shellOn(box, ['logout'])
    await term.sees(', to sign this machine out: ')
    term.type('SENTINEL-not-it\r')
    await vi.waitFor(() => expect(term.transcript.split('to sign this machine out').length).toBe(3), { timeout: 15_000 })
    expect(existsSync(accountFilePath(box.home))).toBe(true)
    nothingTypedAnywhere(box, term, 'SENTINEL-not-it')
    term.type('\x03')
    expect(await term.exit()).toBe(130)
  })

  it('renews an ended session from a terminal, on the device it already is', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    await onTheAccount(box, owner)
    const before = loadAccount(box.home)
    writeAccount({ ...(before as AccountFile), session: { token: 'dead', exp: 1 } }, box.home)
    const reborn = await bootBox(box.home)
    const term = shellOn(reborn, ['login'])
    await term.sees(`Password for @${USERNAME}: `)
    term.type(`${PASSWORD}\r`)
    await term.sees(`Signed in as @${USERNAME}. cookrew.dev shows this machine as ${DEVICE}.`)
    expect(await term.exit()).toBe(0)
    expect(loadAccount(box.home)?.deviceId).toBe(before?.deviceId)
  })
})

describe.skipIf(!hasPython)('on the app own Electron, with no node on the PATH', () => {
  const electron = (() => {
    try {
      return createRequire(import.meta.url)('electron') as unknown as string
    } catch {
      return ''
    }
  })()

  it.skipIf(!existsSync(electron))('reads a hidden password through the shim', async () => {
    const owner = await ownerDevice()
    const box = await bootBox()
    const wrapper = path.join(box.home, 'cookrew')
    writeFileSync(wrapper, cliWrapper(CLI, electron))
    chmodSync(wrapper, 0o755)
    const term = new Terminal([wrapper, 'login', USERNAME], {
      PATH: '/usr/bin:/bin',
      HOME: box.home,
      COOKREW_SOCKET: box.socketPath,
      COOKREW_TERMINAL_ID: 'term-box'
    })
    await signedInThroughPassword(box, term)
    await term.sees(/type this number: (\d\d)/)
    const match = /type this number: (\d\d)/.exec(term.transcript)?.[1]
    const listed = (await (await asOwner(owner.token, '/v2/me/approvals')).json()) as Array<{ id: string }>
    await asOwner(owner.token, `/v2/me/approvals/${listed[0]?.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve', match }) })
    await term.sees(`Signed in as @${USERNAME}.`)
    expect(await term.exit()).toBe(0)
    nothingTypedAnywhere(box, term)
  })
})
