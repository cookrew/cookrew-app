import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { PtyManager, setBackends, setMultiplexer } from '../src/main/pty'
import { PtyOwnership } from '../src/main/pty-scope'

/**
 * ENDING A DIRECT SESSION ON A REAL node-pty: the Windows runtime, and a Mac
 * or Linux box with no multiplexer. The end is judged by node-pty's own exit
 * for its own child (terminal-pid.ts · childJudge), never by the pid number.
 *
 * The session stands in for PtySession with exactly the fields the end path
 * reads, over a real node-pty child; a PtyManager is never constructed (its
 * constructor takes the host claim), as in close-detached-pane.test.ts.
 */

type Pty = typeof import('node-pty')
let pty: Pty | null = null
try {
  pty = (await import('node-pty')) as Pty
} catch {
  pty = null
}

const WINDOWS = process.platform === 'win32'
const sleeper = (): [string, string[]] =>
  WINDOWS ? ['cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1']] : ['/bin/sh', ['-c', 'sleep 60']]

const live: Array<{ kill: () => void }> = []

function directSession(node: Pty, [file, args]: [string, string[]]) {
  const proc = node.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> })
  let exited = false
  proc.onExit(() => {
    exited = true
  })
  live.push({ kill: () => proc.kill() })
  const session = {
    usesTmux: false,
    get pid() {
      return proc.pid
    },
    ownChild: {
      get exited() {
        return exited
      },
      terminate: () => proc.kill()
    },
    killSession: () => undefined,
    dispose: () => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }
  }
  return { session, exited: () => exited }
}

function bareManager(sessions: Map<string, unknown>): PtyManager {
  return Object.assign(Object.create(PtyManager.prototype) as PtyManager, { sessions, ownership: new PtyOwnership() })
}

describe.skipIf(pty === null)('ending a direct session (real node-pty)', () => {
  beforeAll(() => {
    const direct = new DirectMultiplexer()
    setMultiplexer(direct)
    setBackends([direct])
  })
  afterEach(() => {
    for (const child of live.splice(0)) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })
  afterAll(() => setBackends([]))

  it('resolves once node-pty reports its child exited', async () => {
    const id = 'd1ec7000-0000-4000-8000-000000000001'
    const { session, exited } = directSession(pty as Pty, sleeper())
    await bareManager(new Map([[id, session]])).killAndWait(id, 8000)
    expect(exited()).toBe(true)
  }, 15_000)

  // A child that shrugs off the hangup and TERM: only a signal to the process
  // ps named ends it. POSIX only: cmd.exe has no way to ignore a close.
  it.skipIf(WINDOWS)('ends a child that ignores the hangup, by a signal to the very process ps named', async () => {
    const id = 'd1ec7000-0000-4000-8000-000000000002'
    const { session, exited } = directSession(pty as Pty, ['/bin/sh', ['-c', "trap '' HUP TERM; while :; do sleep 0.1; done"]])
    await new Promise((resolve) => setTimeout(resolve, 300))
    await bareManager(new Map([[id, session]])).killAndWait(id, 4000)
    expect(exited()).toBe(true)
  }, 15_000)
})
