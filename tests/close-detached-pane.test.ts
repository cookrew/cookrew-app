import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PtyManager, sessionNameFor, setBackends, setMultiplexer } from '../src/main/pty'
import { TMUX_LABEL, TmuxMultiplexer } from '../src/main/tmux-multiplexer'
import { PtyOwnership } from '../src/main/pty-scope'
import type { CommandRunner, Multiplexer } from '../src/main/multiplexer'

// BOX TEST 2, BUG 1, ON A REAL TMUX. A relaunched app has no mirror on a pane
// it found still running, so `kill` found no session in its map and returned
// having done nothing, while the card went and the log said killed.
//
// The server is PRIVATE: every call is rewritten off Cookrew's own `-L cookrew`
// label, so this test can never reach a running fleet. A PtyManager is never
// constructed (its constructor takes the host claim); the fields the kill path
// reads are given to a bare instance.

const LABEL = `cookrew-test-${process.pid}`
const hasTmux = spawnSync('tmux', ['-V']).status === 0

const rewrite = (args: string[]): string[] => args.map((arg, i) => (arg === TMUX_LABEL && args[i - 1] === '-L' ? LABEL : arg))
const privateRunner: CommandRunner = {
  run: (file, args) => execFileSync(file, rewrite(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  runQuiet: (file, args) => {
    spawnSync(file, rewrite(args), { stdio: 'ignore' })
  },
  probe: (file, args) => spawnSync(file, rewrite(args), { stdio: 'ignore' }).status === 0
}

const tmux = (...args: string[]): string =>
  execFileSync('tmux', ['-L', LABEL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function bareManager(): PtyManager {
  return Object.assign(Object.create(PtyManager.prototype) as PtyManager, {
    sessions: new Map(),
    ownership: new PtyOwnership()
  })
}

describe.skipIf(!hasTmux)('closing a pane this run never attached (real tmux)', () => {
  const id = 'c10500de-0000-4000-8000-00000000abcd'
  const name = sessionNameFor(id)
  let mux: Multiplexer

  const startCounter = (script: string): number => {
    tmux('new-session', '-d', '-s', name, 'sh', '-c', script)
    return Number(tmux('list-panes', '-t', name, '-F', '#{pane_pid}').trim())
  }

  beforeAll(() => {
    const conf = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-close-')), 'tmux.conf')
    writeFileSync(conf, '')
    mux = new TmuxMultiplexer({ configFile: conf, runner: privateRunner })
    setMultiplexer(mux)
    setBackends([mux])
  })

  afterEach(() => {
    spawnSync('tmux', ['-L', LABEL, 'kill-session', '-t', name], { stdio: 'ignore' })
  })

  afterAll(() => {
    spawnSync('tmux', ['-L', LABEL, 'kill-server'], { stdio: 'ignore' })
  })

  it('kill() reaches it: the pane ends though no mirror exists', async () => {
    startCounter('i=0; while true; do i=$((i+1)); echo $i; sleep 0.2; done')
    expect(mux.sessionExists(name)).toBe(true)
    bareManager().kill(id)
    await expect.poll(() => mux.sessionExists(name), { timeout: 3000 }).toBe(false)
  })

  it('killAndWait() returns only once the pane AND its process are gone', async () => {
    const pid = startCounter('i=0; while true; do i=$((i+1)); echo $i; sleep 0.2; done')
    await bareManager().killAndWait(id)
    expect(mux.sessionExists(name)).toBe(false)
    expect(alive(pid)).toBe(false)
  })

  it('a process that ignores the hangup is still ended, not reported ended and left', async () => {
    // tmux drops the pane on kill-session; a root that traps HUP outlives it.
    const pid = startCounter("trap '' HUP; while true; do sleep 0.2; done")
    await bareManager().killAndWait(id, 4000)
    expect(mux.sessionExists(name)).toBe(false)
    expect(alive(pid)).toBe(false)
  })

  it('a survivor is remembered: the next close finds it though its pane is gone', async () => {
    const pid = startCounter("trap '' HUP; while true; do sleep 0.2; done")
    const realKill = process.kill.bind(process)
    // Signals are swallowed for the first close, so its process outlives it.
    const swallow = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (signal === 0 || signal === undefined) return realKill(target, 0)
      return true
    })
    await expect(bareManager().killAndWait(id, 600)).rejects.toThrow(/still running/)
    swallow.mockRestore()
    expect(mux.sessionExists(name)).toBe(false)
    expect(alive(pid)).toBe(true)
    await bareManager().killAndWait(id, 3000)
    expect(alive(pid)).toBe(false)
  })

  it('liveSessions tells no server from a failed read', async () => {
    await expect(mux.liveSessions?.()).resolves.toEqual(new Set())
    startCounter('sleep 30')
    await expect(mux.liveSessions?.()).resolves.toEqual(new Set([name]))
    const broken = new TmuxMultiplexer({
      configFile: '/nonexistent',
      runner: {
        ...privateRunner,
        run: () => {
          throw Object.assign(new Error('spawn EAGAIN'), { status: null })
        }
      }
    })
    await expect(broken.liveSessions()).rejects.toThrow(/EAGAIN/)
  })

  it('sessionPresence answers null when the read itself failed', () => {
    startCounter('sleep 30')
    expect(mux.sessionPresence?.(name)).toBe(true)
    expect(mux.sessionPresence?.('cookrew_nobody')).toBe(false)
    const broken = new TmuxMultiplexer({
      configFile: '/nonexistent',
      runner: {
        ...privateRunner,
        run: () => {
          throw Object.assign(new Error('spawn EAGAIN'), { status: null })
        }
      }
    })
    expect(broken.sessionPresence('cookrew_x')).toBeNull()
  })

  it('a pane already gone is nothing to report', async () => {
    await expect(bareManager().killAndWait(id)).resolves.toBeUndefined()
  })
})

describe('liveness on the herdr host', () => {
  const host = async (reply: () => Promise<string>, sync: () => string = () => '') => {
    const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer')
    return new HerdrHostMultiplexer({
      session: 'test',
      configPath: '/nonexistent',
      runner: { run: (_file, args) => (args[0] === 'pane' ? sync() : ''), runQuiet: () => undefined, probe: () => true },
      asyncRunner: () => reply()
    })
  }

  it('sessionPresence: a failed listing is no answer, where sessionExists reads it as no pane', async () => {
    let reply: () => string = () => {
      throw new Error('socket busy')
    }
    const mux = await host(async () => '', () => reply())
    expect(mux.sessionExists('cookrew_x')).toBe(false)
    expect(mux.sessionPresence('cookrew_x')).toBeNull()
    reply = () => '{"result":{"panes":[{"pane_id":"w1:p1","label":"cookrew_x"}]}}'
    expect(mux.sessionPresence('cookrew_x')).toBe(true)
    expect(mux.sessionPresence('cookrew_y')).toBe(false)
    reply = () => '{"error":{"code":"nope"}}'
    expect(mux.sessionPresence('cookrew_x')).toBeNull()
  })

  it('liveSessions reads off the main thread', async () => {
    const mux = await host(async () => '{"result":{"panes":[{"pane_id":"w1:p1","label":"cookrew_x"}]}}')
    await expect(mux.liveSessions()).resolves.toEqual(new Set(['cookrew_x']))
  })

  it('a server that is not running holds no panes: that is an answer', async () => {
    const mux = await host(async () => {
      throw new Error('Command failed: herdr pane list {"error":{"code":"server_not_running"}}')
    })
    await expect(mux.liveSessions()).resolves.toEqual(new Set())
  })

  it('any other failure rejects: blindness is not absence', async () => {
    const reject = await host(async () => {
      throw new Error('timed out')
    })
    await expect(reject.liveSessions()).rejects.toThrow()
    const mangled = await host(async () => '{"error":{"code":"nope"}}')
    await expect(mangled.liveSessions()).rejects.toThrow()
  })
})
