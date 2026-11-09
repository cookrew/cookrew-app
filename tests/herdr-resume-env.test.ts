import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import { HERDR_CONF } from '../src/main/herdr-conf'
import { AgentWaker } from '../src/main/agent-wake'
import { sharedMcpArgs } from '../src/main/route/shared-mcp'
import type { AttachSpec, CommandRunner } from '../src/main/multiplexer'

// 2026-11-09: herdr restarted at 11:19:54 and restored every pane as `-zsh`.
// About a second later it ran `claude --dangerously-skip-permissions --resume
// <id>` (or `codex resume <id>`) itself, as a CHILD of that shell, taken from
// the agent_session it had recorded. That agent ran with the herdr server's
// env: no COOKREW_TERMINAL_ID, no COOKREW_SOCKET, no cookrew shim on PATH, no
// Magpie --mcp-config, no route. Nine fleet panes, the orchestrator Roaster
// among them: `cookrew secret exec` refused it and its Magpie MCP was gone.
//
// herdr's own switch for this is `[session] resume_agents_on_restore`, on by
// default. Cookrew's config turns it off, so a restored pane stays a bare shell
// (a husk) and Cookrew's boot script resumes the SAME session with its env.
//
// The fake herdr below restores by the config it was started with, and when
// a boot line is typed into a bare shell it RUNS the boot script Cookrew wrote,
// under the herdr server's env, with a stand-in agent that records the env and
// argv it was started with: those are what the assertions read.

const SESSION_ID = '523d324b-ec6c-47d2-b86c-3f0d1e2a4b5c'
const ROLLOUT_ID = '01a19c6e-22b8-7f83-a2e1-dc630e4ae2c0'
const SHELL_PID = 2775
const GATEWAY = 'http://127.0.0.1:8788'
/** The suites that run the boot script need a POSIX sh (CI also runs Windows). */
const posixOnly = describe.skipIf(process.platform === 'win32')

/** What herdr's server env is: it was started by Cookrew, but a pane's shell is not Cookrew's boot. */
const SERVER_ENV: Record<string, string> = {
  HOME: tmpdir(),
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/sh',
  HERDR_SESSION: 'cookrew',
  // herdr 0.9.2+ sets this in the panes it starts; the boot must still win.
  TERM_PROGRAM: 'herdr'
}

/** herdr's documented default is on; only an explicit `false` under [session] turns it off. */
function herdrResumesOnRestore(config: string): boolean {
  let section = ''
  for (const raw of config.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section = header[1].trim()
      continue
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line)
    if (section === 'session' && pair?.[1] === 'resume_agents_on_restore') return pair[2].trim() !== 'false'
  }
  return true
}

interface Agent {
  argv: string[]
  env: Record<string, string>
}

interface Pane {
  root: string
  foreground: { pid: number; name: string; argv0: string; argv: string[] }[]
  group: number
  status: 'idle' | 'working' | null
  /** The agent process in this pane, with the env and argv it really started with. */
  agent: Agent | null
}

const husk = (): Pane => ({
  root: '-zsh',
  foreground: [{ pid: SHELL_PID, name: 'zsh', argv0: '-zsh', argv: ['-zsh'] }],
  group: SHELL_PID,
  status: null,
  agent: null
})

/** What herdr's own resume leaves: the agent under the restored shell, on the server's env. */
const herdrResumed = (kind: 'claude' | 'codex', status: Pane['status'] = 'idle'): Pane => {
  const argv = kind === 'claude' ? ['--dangerously-skip-permissions', '--resume', SESSION_ID] : ['resume', ROLLOUT_ID]
  return {
    root: '-zsh',
    foreground: [{ pid: 3373, name: kind === 'claude' ? 'claude.exe' : kind, argv0: kind, argv: [kind, ...argv] }],
    group: 3373,
    status,
    agent: { argv, env: { ...SERVER_ENV } }
  }
}

/** A pane whose shell exec'd Cookrew's boot: the agent IS the root. */
const booted = (kind: string, agent: Agent, status: Pane['status'] = 'idle'): Pane => ({
  root: [kind, ...agent.argv].join(' '),
  foreground: [{ pid: SHELL_PID, name: kind, argv0: kind, argv: [kind, ...agent.argv] }],
  group: SHELL_PID,
  status,
  agent
})

interface Sandbox {
  dir: string
  spec: (kind: 'claude' | 'codex') => AttachSpec
  /** The stand-in agent's record of how it was started, once it ran. */
  started: () => Agent | null
}

/** A real directory with a stand-in `claude` and `codex` that record their env and argv. */
function sandbox(): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), 'herdr-resume-env-'))
  for (const sub of ['bin', 'cli', 'work', 'rec']) mkdirSync(path.join(dir, sub))
  const rec = path.join(dir, 'rec')
  const agent = [
    '#!/bin/sh',
    `env > '${rec}/env.txt'`,
    `: > '${rec}/argv.txt'`,
    `for a in "$@"; do printf '%s\\n' "$a" >> '${rec}/argv.txt'; done`
  ].join('\n')
  for (const kind of ['claude', 'codex']) {
    writeFileSync(path.join(dir, 'bin', kind), `${agent}\n`)
    chmodSync(path.join(dir, 'bin', kind), 0o755)
  }
  return {
    dir,
    spec: (kind) => ({
      sessionName: 'cookrew_abc',
      command: kind === 'claude' ? `claude --permission-mode bypassPermissions --resume ${SESSION_ID}` : `codex resume ${ROLLOUT_ID}`,
      args: ['--model', 'group/smart', ...sharedMcpArgs(kind, GATEWAY)],
      env: { ANTHROPIC_BASE_URL: GATEWAY, NODE_OPTIONS: '--require /tmp/tsc-gate.cjs' },
      shell: '/bin/zsh',
      terminalId: 'abc-123',
      socketPath: '/tmp/cookrew.sock',
      cliDir: path.join(dir, 'cli'),
      path: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
      cwd: path.join(dir, 'work')
    }),
    started: () => {
      if (!existsSync(path.join(rec, 'argv.txt'))) return null
      const env = Object.fromEntries(
        readFileSync(path.join(rec, 'env.txt'), 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
      )
      const argv = readFileSync(path.join(rec, 'argv.txt'), 'utf8').split('\n').slice(0, -1)
      return { argv, env }
    }
  }
}

interface World {
  runner: CommandRunner
  pane: () => Pane
  typed: () => string[]
  keys: () => number
  closes: () => number
}

/**
 * A fake herdr holding ONE labelled pane, restarted with `config`: herdr's
 * resume (when the config leaves it on) or a husk. A boot line typed into a
 * bare shell runs the boot script for real, under the server's env.
 */
function restartedWorld(config: string, box: Sandbox, kind: 'claude' | 'codex', start?: Pane): World {
  let pane: Pane = start ?? (herdrResumesOnRestore(config) ? herdrResumed(kind) : husk())
  const typed: string[] = []
  let keys = 0
  let closes = 0
  const runner: CommandRunner = {
    run: (file, args) => {
      if (file === 'ps') return `${pane.root}\n`
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') {
        const panes = [{ pane_id: 'w2:pXE', label: 'cookrew_abc', agent: pane.agent ? kind : null, agent_status: pane.status }]
        return JSON.stringify({ result: { type: 'pane_list', panes } })
      }
      if (key === 'pane process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'w2:pXE',
              shell_pid: SHELL_PID,
              foreground_process_group_id: pane.group,
              foreground_processes: pane.foreground
            }
          }
        })
      }
      if (key === 'pane read') return pane.agent ? '│ > │' : '%'
      if (key === 'agent get') return JSON.stringify({ result: { agent: { agent: kind, pane_id: 'w2:pXE' } } })
      throw new Error(`no scripted reply for ${file} ${key}`)
    },
    runQuiet: (_file, args) => {
      if (args[0] !== 'pane') return
      if (args[1] === 'close') closes++
      if (args[1] === 'send-keys') keys++
      if (args[1] !== 'send-text') return
      const line = args[args.length - 1]
      typed.push(line)
      // A line typed into a running agent is input to it, never a boot.
      const boot = /^clear; exec sh (.+)$/.exec(line)
      if (!boot || pane.agent) return
      execFileSync('sh', [boot[1]], { env: SERVER_ENV, stdio: 'ignore' })
      const agent = box.started()
      if (agent) pane = booted(kind, agent)
    },
    probe: () => true
  }
  return { runner, pane: () => pane, typed: () => typed, keys: () => keys, closes: () => closes }
}

const backend = (w: World): HerdrHostMultiplexer =>
  new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner: w.runner,
    settleMs: 2000,
    sleep: (ms) => vi.advanceTimersByTime(ms),
    folderGone: () => false
  })

let boxes: Sandbox[] = []
const box = (): Sandbox => {
  const made = sandbox()
  boxes = [...boxes, made]
  return made
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const made of boxes) rmSync(made.dir, { recursive: true, force: true })
  boxes = []
})

describe("Cookrew's herdr config leaves the resume to Cookrew", () => {
  it("turns herdr's own agent resume off", () => {
    expect(herdrResumesOnRestore(HERDR_CONF)).toBe(false)
  })

  it('keeps the chrome and updater settings it already had', () => {
    for (const line of ['sidebar_collapsed_mode = "hidden"', 'pane_borders = false', 'version_check = false', 'manifest_check = false']) {
      expect(HERDR_CONF.split('\n')).toContain(line)
    }
  })

  it("reproduces 11-09 under herdr's default: the agent herdr resumes has no Cookrew env, MCP or route", () => {
    const b = box()
    const w = restartedWorld('', b, 'claude')
    backend(w).ensureSession(b.spec('claude'))
    // Cookrew leaves a live agent alone (boot-retype), so this is what stays running.
    expect(w.typed()).toEqual([])
    const agent = w.pane().agent
    expect(agent?.argv).toContain(SESSION_ID)
    expect(agent?.env.COOKREW_TERMINAL_ID).toBeUndefined()
    expect(agent?.argv).not.toContain('--mcp-config')
  })
})

posixOnly("after a herdr restart under Cookrew's config, Cookrew's boot resumes the agent", () => {
  it('claude: one boot line, and the agent has Cookrew env, the Magpie MCP config and the same session', () => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'claude')
    expect(w.pane().agent).toBeNull()

    backend(w).ensureSession(b.spec('claude'))

    expect(w.typed()).toEqual([`clear; exec sh ${path.join(b.dir, 'cli', 'boot-cookrew_abc.sh')}`])
    const agent = w.pane().agent
    expect(agent).not.toBeNull()
    expect(agent?.env.COOKREW_TERMINAL_ID).toBe('abc-123')
    expect(agent?.env.TERM_PROGRAM).toBe('Cookrew')
    expect(agent?.env.COOKREW_SOCKET).toBe('/tmp/cookrew.sock')
    expect(agent?.env.COOKREW_CLI).toBe(path.join(b.dir, 'cli', 'cookrew'))
    expect(agent?.env.PATH?.split(':')[0]).toBe(path.join(b.dir, 'bin'))
    expect(agent?.env.ANTHROPIC_BASE_URL).toBe(GATEWAY)
    expect(agent?.env.NODE_OPTIONS).toContain('--require /tmp/tsc-gate.cjs')
    // The same conversation, not a fresh one.
    const argv = agent?.argv ?? []
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', SESSION_ID])
    // The hub's --mcp-config is variadic, so it must be last.
    expect(argv.slice(-2)).toEqual(sharedMcpArgs('claude', GATEWAY))
    expect(JSON.parse(argv[argv.length - 1]).mcpServers.magpie.url).toContain('/mcp/magpie/hub/claude')
    // Started in the card's folder, where its transcript lives.
    expect(agent?.env.PWD).toBe(path.join(b.dir, 'work'))
  })

  it('codex: the same rollout, with Cookrew env and the hub', () => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'codex')
    backend(w).ensureSession(b.spec('codex'))
    expect(w.typed()).toHaveLength(1)
    const agent = w.pane().agent
    expect(agent?.env.COOKREW_TERMINAL_ID).toBe('abc-123')
    expect(agent?.argv.slice(0, 2)).toEqual(['resume', ROLLOUT_ID])
    expect(agent?.argv.slice(-2)).toEqual(sharedMcpArgs('codex', GATEWAY))
  })

  it('one boot per wake: prompts sent while it wakes share one boot line', async () => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'claude')
    const mux = backend(w)
    const session = { write: vi.fn() }
    let up = false
    const waker = new AgentWaker({
      session: () => (up ? session : undefined),
      isTerminal: () => true,
      paneAlive: () => true,
      boot: () => {
        mux.ensureSession(b.spec('claude'))
        up = true
        return true
      },
      ready: async () => true,
      sleep: { take: () => false, mark: () => undefined }
    })
    waker.hold('abc-123', 'status?\r')
    waker.hold('abc-123', 'and the release?\r')
    await vi.runAllTimersAsync()
    expect(w.typed()).toHaveLength(1)
    expect(session.write.mock.calls.map(([data]) => data)).toEqual(['status?', '\r', 'and the release?', '\r'])
  })
})

posixOnly('a running agent is never interrupted', () => {
  it.each([
    ['a Cookrew-booted agent mid-turn', () => booted('claude', { argv: ['--resume', SESSION_ID], env: { COOKREW_TERMINAL_ID: 'abc-123' } }, 'working')],
    ['an agent herdr already resumed, mid-turn', () => herdrResumed('claude', 'working')]
  ])('%s gets no keys, no boot line and no close', (_label, start) => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'claude', start())
    const before = w.pane()
    const mux = backend(w)
    mux.ensureSession(b.spec('claude'))
    expect(w.typed()).toEqual([])
    expect(w.keys()).toBe(0)
    expect(w.closes()).toBe(0)
    expect(w.pane()).toBe(before)
    expect(mux.lastBootAt('cookrew_abc')).toBeNull()
  })
})

posixOnly('a wake into a husk waits for the agent it started', () => {
  const wakeInto = (w: World, spec: AttachSpec) => {
    const mux = backend(w)
    const session = { write: vi.fn() }
    let up = false
    let open: (ok: boolean) => void = () => undefined
    const ready = vi.fn(() => new Promise<boolean>((resolve) => (open = resolve)))
    const lost = vi.fn()
    const waker = new AgentWaker({
      session: () => (up ? session : undefined),
      isTerminal: () => true,
      // herdr kept the pane: a husk is "alive" to the inventory.
      paneAlive: () => true,
      boot: () => {
        mux.ensureSession(spec)
        up = true
        return true
      },
      // Wired as index.ts wires it.
      booted: (_id, since) => (mux.lastBootAt(spec.sessionName) ?? -Infinity) >= since,
      ready,
      lost,
      sleep: { take: () => false, mark: () => undefined }
    })
    return { mux, session, ready, waker, open: (ok: boolean) => open(ok), lost }
  }

  it('holds the keys until the resumed agent takes input, though herdr kept its pane', async () => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'claude')
    const wake = wakeInto(w, b.spec('claude'))
    wake.waker.hold('abc-123', 'status?\r')
    await vi.runAllTimersAsync()
    expect(w.pane().agent?.env.COOKREW_TERMINAL_ID).toBe('abc-123')
    expect(wake.ready).toHaveBeenCalledTimes(1)
    expect(wake.session.write).not.toHaveBeenCalled()
    wake.open(true)
    await vi.runAllTimersAsync()
    expect(wake.session.write.mock.calls.map(([data]) => data)).toEqual(['status?', '\r'])
  })

  it('a husk whose agent never took input gets no keys: they are reported lost, never typed into the shell', async () => {
    const b = box()
    const w = restartedWorld(HERDR_CONF, b, 'claude')
    const wake = wakeInto(w, b.spec('claude'))
    wake.waker.hold('abc-123', 'rm -rf build; then rebuild\r')
    await vi.runAllTimersAsync()
    wake.open(false)
    await vi.runAllTimersAsync()
    expect(wake.session.write).not.toHaveBeenCalled()
    expect(wake.lost).toHaveBeenCalledWith('abc-123', ['rm -rf build; then rebuild\r'])
  })

  it('only re-attaches a pane whose agent still runs: no wait, no boot', async () => {
    const b = box()
    const live = booted('claude', { argv: ['--resume', SESSION_ID], env: { COOKREW_TERMINAL_ID: 'abc-123' } })
    const w = restartedWorld(HERDR_CONF, b, 'claude', live)
    const wake = wakeInto(w, b.spec('claude'))
    wake.waker.hold('abc-123', 'status?\r')
    await vi.runAllTimersAsync()
    expect(wake.ready).not.toHaveBeenCalled()
    expect(w.typed()).toEqual([])
    expect(wake.session.write.mock.calls.map(([data]) => data)).toEqual(['status?', '\r'])
  })
})
