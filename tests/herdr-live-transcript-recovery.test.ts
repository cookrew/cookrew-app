// A live transcript is subscribed to PtySession, not directly to node-pty.
// Recovery therefore has to replace only the failed `herdr agent attach`
// child. Replacing PtySession itself can reconnect underneath the UI while the
// visible transcript, turn tracker and input guard all remain on the dead one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeProc {
  writes: string[]
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

const processes: FakeProc[] = []

vi.mock('node-pty', () => ({
  default: {
    spawn: () => {
      let onData: (data: string) => void = () => undefined
      let onExit: (event: { exitCode: number }) => void = () => undefined
      const proc: FakeProc = {
        writes: [],
        killed: false,
        emitData: (data) => onData(data),
        emitExit: (exitCode) => onExit({ exitCode })
      }
      processes.push(proc)
      return {
        write: (data: string) => proc.writes.push(data),
        resize: () => undefined,
        kill: () => { proc.killed = true },
        onData: (listener: (data: string) => void) => { onData = listener },
        onExit: (listener: (event: { exitCode: number }) => void) => { onExit = listener }
      }
    }
  }
}))

import { CLEAR_SCREEN, PtySession, setBackends, setMultiplexer } from '../src/main/pty'
import type { AttachSpec, Multiplexer } from '../src/main/multiplexer'

const EAGAIN = 'herdr: lost connection to server: Resource temporarily unavailable (os error 35)'

function herdrMux(recover: (spec: AttachSpec) => void): Multiplexer {
  return {
    id: 'herdr',
    capabilities: {
      attach: true,
      persistsAcrossRestart: true,
      copyModeSearch: false,
      wheelScrollback: true,
      monotonicHistory: true,
      agentLifecycle: true
    },
    available: () => true,
    sessionExists: () => true,
    ensureSession: () => undefined,
    recoverAttach: recover,
    attachSpawn: () => ({ file: 'herdr', args: ['agent', 'attach', 'w1:p1'] }),
    killSession: () => undefined,
    listSessions: () => [],
    capture: () => null,
    scrollState: () => ({ scrollRow: null, historySize: null }),
    jumpToText: () => undefined,
    exitCopyMode: () => undefined,
    panePid: () => null,
    paneLaunch: () => null,
    reloadConfig: () => undefined
  } as Multiplexer
}

function session(recover: (spec: AttachSpec) => void = () => undefined): PtySession {
  const mux = herdrMux(recover)
  setMultiplexer(mux)
  setBackends([mux])
  return new PtySession({
    terminalId: 'term-1',
    command: 'claude',
    cwd: '/tmp',
    socketPath: '/tmp/cookrew-test.sock',
    cliDir: '/tmp'
  })
}

describe('live transcript recovery', () => {
  beforeEach(() => {
    processes.length = 0
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reattaches in place so existing transcript and input listeners survive', async () => {
    let recoveries = 0
    const stable = session(() => { recoveries += 1 })
    const data: string[] = []
    const replays: string[] = []
    const exits: number[] = []
    let guarded = 0
    stable.beforeOwnerInput = () => {
      guarded += 1
      return 'allow'
    }
    stable.on('data', (chunk: string) => data.push(chunk))
    stable.on('replay', (frame: string) => replays.push(frame))
    stable.on('exit', (code: number) => exits.push(code))

    const first = processes[0]
    first.emitData(EAGAIN)
    first.emitExit(1)
    expect(exits).toEqual([])
    expect(processes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(250)
    expect(recoveries).toBe(1)
    expect(processes).toHaveLength(2)
    expect(replays).toContain(CLEAR_SCREEN)

    processes[1].emitData('reattached output')
    expect(data).toContain('reattached output')
    expect(stable.write('owner input')).toBe('allow')
    expect(guarded).toBe(1)
    expect(processes[1].writes).toEqual(['owner input'])
    stable.dispose()
  })

  it('recovers the disconnect even when the attach client exits zero', async () => {
    const stable = session()
    const exits: number[] = []
    stable.on('exit', (code: number) => exits.push(code))

    processes[0].emitData(EAGAIN)
    processes[0].emitExit(0)
    await vi.advanceTimersByTimeAsync(250)

    expect(processes).toHaveLength(2)
    expect(exits).toEqual([])
    stable.dispose()
  })

  it('retries when recovery preparation fails before a child can spawn', async () => {
    let recoveries = 0
    const stable = session(() => {
      recoveries += 1
      if (recoveries === 1) throw new Error('server is still restoring')
    })
    const exits: number[] = []
    stable.on('exit', (code: number) => exits.push(code))

    processes[0].emitData(EAGAIN)
    processes[0].emitExit(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(recoveries).toBe(1)
    expect(processes).toHaveLength(1)
    expect(exits).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    expect(recoveries).toBe(2)
    expect(processes).toHaveLength(2)
    expect(exits).toEqual([])
    stable.dispose()
  })

  it('cancels a pending reattach when the terminal is deliberately disposed', async () => {
    let recoveries = 0
    const stable = session(() => { recoveries += 1 })
    processes[0].emitData(EAGAIN)
    processes[0].emitExit(1)
    stable.dispose()

    await vi.advanceTimersByTimeAsync(5000)
    expect(recoveries).toBe(0)
    expect(processes).toHaveLength(1)
  })
})
