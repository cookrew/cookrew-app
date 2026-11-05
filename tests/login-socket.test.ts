// `cookrew login` at the socket: raw JSON lines against the real server. This is
// the line the password crosses, so what is pinned here is that it crosses as a
// sealed field and nothing that reads a request can ever see it.

import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSocketServer, type SocketServerDeps } from '../src/main/socket-server'
import type { AccountDoor, LoginAudit } from '../src/main/login-cli'
import { paneInputs } from '../src/main/pane-input'

const PASSWORD = 'SENTINEL-socket-password'

let dir = ''
let sock = ''
let close: () => Promise<void> = async () => undefined
let audits: LoginAudit[] = []
let served = false
let phase: string | undefined = 'idle'
let backendPhase: string | undefined
let signIn: AccountDoor['signIn']

const account = (): AccountDoor => ({
  platform: 'linux',
  who: () => ({ username: null, deviceId: 'd', deviceName: 'Linux · box', sessionLive: false, registry: null, mismatch: null }),
  signIn: (input) => signIn(input),
  resume: async () => ({ ok: true, value: {} }),
  climbCode: async () => ({ ok: true, value: {} }),
  askApproval: async () => ({ ok: false, reason: 'offline' }),
  waitApproval: async () => ({ ok: true, value: {} }),
  abandon: () => undefined,
  signOut: async () => ({ ok: true, value: {} }),
  devices: async () => ({ ok: true, value: [] })
})

const pane = { id: 'term-1', kind: 'terminal', name: 'shell' }

const deps = (): SocketServerDeps =>
  ({
    ptys: { socketPath: sock, get: () => undefined },
    store: {
      node: (id: string) => (id === pane.id ? pane : null),
      terminalsAcross: () => [],
      nodeAcrossWorkspaces: () => null
    },
    agents: {},
    turns: { phaseOf: () => phase, backendPhaseFor: () => backendPhase, dropDraft: () => undefined },
    isServed: () => served,
    account,
    auditLogin: (event: LoginAudit) => {
      audits = [...audits, event]
    },
    adoptPictures: async (text: string) => text
  }) as unknown as SocketServerDeps

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'login-sock-'))
  sock = path.join(dir, 'app.sock')
  audits = []
  served = false
  phase = 'idle'
  backendPhase = undefined
  signIn = async () => ({ ok: false, reason: 'session-expired', message: 'That is not the password.' })
  const handle = startSocketServer(deps())
  await handle.claim
  close = () => new Promise((resolve) => handle.server.close(() => resolve()))
})

afterEach(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

/** One connection, one JSON request per call, answers by id. */
const connect = async () => {
  const socket = net.createConnection(sock)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  let buffer = ''
  const waiting = new Map<string, (answer: Record<string, unknown>) => void>()
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const answer = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
      buffer = buffer.slice(at + 1)
      waiting.get(String(answer.id))?.(answer)
    }
  })
  let n = 0
  const send = (fields: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      n += 1
      const id = `q${n}`
      waiting.set(id, resolve)
      socket.write(`${JSON.stringify({ id, terminalId: 'term-1', args: [], flags: {}, ...fields })}\n`)
    })
  return { socket, send }
}

const open = (send: (fields: Record<string, unknown>) => Promise<Record<string, unknown>>, cmd = 'login') =>
  send({ cmd, args: ['open', 'drej'], flags: { tty: true } })

describe('the password on the socket', () => {
  it('reaches the account and comes back in no answer, log or audit line', async () => {
    const heard: string[] = []
    signIn = async (input) => {
      heard.push(input.password)
      return { ok: false, reason: 'session-expired' }
    }
    const logged: unknown[][] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    )
    const { socket, send } = await connect()
    const replies = [await open(send), await send({ cmd: 'login', args: ['answer'], secret: PASSWORD })]
    socket.destroy()
    await vi.waitFor(() => expect(paneInputs.sealed('term-1')).toBe(false))
    for (const spy of spies) spy.mockRestore()
    expect(heard).toEqual([PASSWORD])
    expect(JSON.stringify({ replies, audits, logged })).not.toContain(PASSWORD)
  })

  it('never travels as an argument: a request that carries one is not read as a password', async () => {
    const heard: string[] = []
    signIn = async (input) => {
      heard.push(input.password)
      return { ok: true, value: {} }
    }
    const { socket, send } = await connect()
    await open(send)
    await send({ cmd: 'login', args: ['answer', 'in-an-argument'], flags: { password: 'in-a-flag' } })
    socket.destroy()
    expect(heard).toEqual([''])
  })

  it('is taken off every request before anything else reads it, whatever the verb', async () => {
    const handleDeps = deps()
    const adopted: unknown[] = []
    const second = path.join(dir, 'second.sock')
    ;(handleDeps as unknown as { ptys: { socketPath: string } }).ptys.socketPath = second
    ;(handleDeps as unknown as { adoptPictures: (text: string) => Promise<string> }).adoptPictures = async (text) => {
      adopted.push(text)
      return text
    }
    const server = startSocketServer(handleDeps)
    await server.claim
    const client = net.createConnection(second)
    const line = await new Promise<string>((resolve) => {
      client.once('data', (chunk) => resolve(chunk.toString()))
      client.write(`${JSON.stringify({ id: 'x', terminalId: '', cmd: 'nonsense', args: [], flags: {}, secret: PASSWORD })}\n`)
    })
    client.destroy()
    await new Promise<void>((resolve) => server.server.close(() => resolve()))
    expect(line).not.toContain(PASSWORD)
    expect(JSON.stringify(adopted)).not.toContain(PASSWORD)
  })
})

describe('the owner rule, at the socket', () => {
  it('refuses a plain shell', async () => {
    const { socket, send } = await connect()
    const answer = await send({ cmd: 'login', terminalId: '', args: ['open'], flags: { tty: true } })
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
    expect(answer.error).toContain("signing in is the owner's")
    expect(answer.error).toContain('not a Cookrew terminal')
  })

  it('refuses --as, which names another pane', async () => {
    const { socket, send } = await connect()
    const answer = await send({ cmd: 'login', args: ['open'], flags: { tty: true, as: 'Conductor' } })
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
  })

  it('refuses a served session, and the attempt is written down', async () => {
    served = true
    const { socket, send } = await connect()
    const answer = await open(send)
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
    expect(answer.error).toContain('served session')
    expect(audits).toMatchObject([{ type: 'account.login-refused' }])
  })

  it('refuses a pane that holds a served session, as `cookrew secret` does', async () => {
    const held = pane as unknown as { servedSession?: unknown }
    held.servedSession = { id: 'seat' }
    const { socket, send } = await connect()
    const answer = await open(send)
    socket.destroy()
    delete held.servedSession
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
    expect(answer.error).toContain('served session')
  })

  it('refuses a pane whose agent is mid-turn', async () => {
    phase = 'thinking'
    const { socket, send } = await connect()
    const answer = await open(send)
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
    expect(answer.error).toContain('working')
  })

  it('refuses a detached pane whose agent the backend says is working', async () => {
    phase = undefined
    backendPhase = 'thinking'
    const { socket, send } = await connect()
    expect(await open(send)).toMatchObject({ ok: false, exitCode: 3 })
    socket.destroy()
  })

  it('refuses a pane the last keys of which came from an agent', async () => {
    paneInputs.drive('term-1')
    const { socket, send } = await connect()
    const answer = await open(send)
    paneInputs.noteKeyboard('term-1')
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
    expect(answer.error).toContain('not a keyboard')
  })

  it('refuses a pane whose agent is held at a menu of its own', async () => {
    phase = 'waiting'
    const { socket, send } = await connect()
    expect(await open(send)).toMatchObject({ ok: false, exitCode: 3 })
    socket.destroy()
  })

  it('holds whoami to the owner rule too', async () => {
    const { socket, send } = await connect()
    const answer = await send({ cmd: 'whoami', terminalId: '' })
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 3 })
  })
})

describe('the seal, at the socket', () => {
  it('is held from the first prompt, with or without a session here, and let go when the CLI dies', async () => {
    const { socket, send } = await connect()
    await open(send)
    expect(paneInputs.sealed('term-1')).toBe(true)
    socket.destroy()
    await vi.waitFor(() => expect(paneInputs.sealed('term-1')).toBe(false))
  })
})

describe('whoami', () => {
  it('answers a plain request and exits 1 for nobody', async () => {
    const { socket, send } = await connect()
    const answer = await send({ cmd: 'whoami' })
    socket.destroy()
    expect(answer).toMatchObject({ ok: false, exitCode: 1 })
    expect(answer.error).toContain('Not signed in')
  })
})
