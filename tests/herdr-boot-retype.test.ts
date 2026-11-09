import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrHostMultiplexer, classifyPaneRun } from '../src/main/herdr-host-multiplexer'
import { AgentWaker } from '../src/main/agent-wake'
import type { AttachSpec, CommandRunner } from '../src/main/multiplexer'

// 2026-11-09, card "Roaster": herdr restarted at 11:19:54, restored the pane as
// a login shell and relaunched `claude --resume <id>` itself, as a CHILD of
// that shell. The pane's root stayed `-zsh`, with claude in the foreground. At
// 11:49:25 a wake read the root alone, took the pane for a husk, typed
// `clear; exec sh <boot>`, and kept retyping for its whole window because the
// root never stops being `-zsh`. The live claude got the line four times.

const SPEC: AttachSpec = {
  sessionName: 'cookrew_abc',
  command: 'claude --permission-mode bypassPermissions --resume 523d324b',
  shell: '/bin/zsh',
  terminalId: 'abc-123',
  socketPath: '/tmp/sock',
  cliDir: '/tmp/cli',
  path: '/tmp/cli:/usr/bin',
  cwd: '/work/repo'
}

const BOOT = '/tmp/cli/boot-cookrew_abc.sh'
const SHELL_PID = 2775

interface Proc {
  pid?: number
  name?: string
  argv0?: string
  argv?: string[]
  cmdline?: string
}

/** What the pane holds right now, the way herdr and ps would answer for it. */
interface Pane {
  root: string
  foreground: Proc[]
  group?: number
  screen: string
}

const bareShell = (): Pane => ({
  root: '-zsh',
  foreground: [{ pid: SHELL_PID, name: 'zsh', argv0: 'zsh', argv: ['-zsh'], cmdline: '-zsh' }],
  group: SHELL_PID,
  screen: 'Last login: Mon Nov  9 11:19:57\n%'
})

/** The measured Roaster pane: process-info listed Pinky first, then claude.exe. */
const claudeUnderShell = (claude: Proc = {}): Pane => ({
  root: '-zsh',
  foreground: [
    { pid: 4144, name: 'Pinky', argv0: 'Pinky', argv: ['/Applications/Pinky.app/Contents/MacOS/Pinky', 'mcp'] },
    {
      pid: 3373,
      name: 'claude.exe',
      argv0: 'claude',
      argv: ['claude', '--dangerously-skip-permissions', '--resume', '523d324b'],
      cmdline: 'claude --dangerously-skip-permissions --resume 523d324b',
      ...claude
    }
  ],
  group: 3373,
  screen: '╭───╮\n│ > │\n╰───╯\n  ? for shortcuts'
})

const exec = (root: string): Pane => ({
  root,
  foreground: [{ pid: SHELL_PID, name: 'claude.exe', argv0: 'claude', argv: root.split(' ') }],
  group: SHELL_PID,
  screen: '│ > │'
})

interface World {
  runner: CommandRunner
  /** Boot lines typed into the pane. */
  typed: () => number
  /** ctrl+u / enter, which also reach whatever runs in the pane. */
  keys: () => number
  renamed: () => boolean
}

/**
 * A fake herdr that holds ONE labelled pane (or none, `fresh`) whose state a
 * test moves: `onRead` sees each process-info read, `onType` each typed line.
 */
function world(
  start: Pane | null,
  hooks: { onType?: (n: number, pane: Pane) => Pane; onRead?: (n: number, pane: Pane) => Pane } = {},
  /** 'labelled' (default with a pane), 'idle' (the server's unlabelled starter), 'none' (empty server). */
  shape: 'labelled' | 'idle' | 'none' = start === null ? 'idle' : 'labelled'
): World {
  let pane: Pane = start ?? bareShell()
  let labelled = shape === 'labelled'
  let exists = shape !== 'none'
  let typed = 0
  let keys = 0
  let reads = 0
  let renamed = false
  const runner: CommandRunner = {
    run: (file, args) => {
      if (file === 'ps') return `${pane.root}\n`
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') {
        const panes = exists ? [{ pane_id: 'w2:pXE', label: labelled ? 'cookrew_abc' : null }] : []
        return JSON.stringify({ result: { type: 'pane_list', panes } })
      }
      if (key === 'workspace create') {
        exists = true
        return JSON.stringify({ result: { root_pane: { pane_id: 'w2:pXE', label: null } } })
      }
      if (key === 'pane process-info') {
        pane = hooks.onRead?.(++reads, pane) ?? pane
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'w2:pXE',
              shell_pid: SHELL_PID,
              ...(pane.group === undefined ? {} : { foreground_process_group_id: pane.group }),
              foreground_processes: pane.foreground
            }
          }
        })
      }
      if (key === 'pane read') return pane.screen
      if (key === 'agent get') return JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'w2:pXE' } } })
      throw new Error(`no scripted reply for ${file} ${key}`)
    },
    runQuiet: (_file, args) => {
      if (args[0] !== 'pane') return
      if (args[1] === 'rename') {
        renamed = true
        labelled = true
      }
      if (args[1] === 'send-keys') keys++
      if (args[1] === 'send-text') {
        typed++
        pane = hooks.onType?.(typed, pane) ?? pane
      }
    },
    probe: () => true
  }
  return { runner, typed: () => typed, keys: () => keys, renamed: () => renamed }
}

// The real settle window: 2 s to judge a pane, 12 s for the boot to take.
// The fake clock makes it instant and the counts exact.
const backend = (w: World): HerdrHostMultiplexer =>
  new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner: w.runner,
    settleMs: 2000,
    sleep: (ms) => vi.advanceTimersByTime(ms),
    folderGone: () => false
  })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a wake never types into an agent that is already running', () => {
  it('reproduces Roaster: herdr relaunched claude under the restored shell, and the wake leaves it alone', async () => {
    const w = world(claudeUnderShell())
    const mux = backend(w)
    const session = { write: vi.fn() }
    let booted = false
    const waker = new AgentWaker({
      session: () => (booted ? session : undefined),
      isTerminal: () => true,
      paneAlive: () => true,
      boot: () => {
        mux.ensureSession(SPEC)
        booted = true
        return true
      },
      ready: async () => true,
      sleep: { take: () => true, mark: () => undefined }
    })
    // A prompt to the asleep card is what woke it; it must reach claude as typed, alone.
    waker.hold('7c80ca8b', 'status?\r')
    await vi.runAllTimersAsync()
    expect(session.write.mock.calls.map(([data]) => data)).toEqual(['status?', '\r'])
    expect(w.typed()).toBe(0)
    expect(w.keys()).toBe(0)
    // The husk branch (rename, then type) never ran.
    expect(w.renamed()).toBe(false)
  })

  it.each([
    ['claude', { name: 'claude', argv0: 'claude' }],
    ['claude.exe (the native binary)', { name: 'claude.exe', argv0: 'claude' }],
    ['claude.exe reached by its real path', {
      name: 'claude.exe',
      argv0: 'claude.exe',
      argv: ['/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', '--resume', 'x'],
      cmdline: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --resume x'
    }],
    ['node running the npm claude', {
      name: 'node',
      argv0: 'node',
      argv: ['node', '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--resume', 'x'],
      cmdline: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume x'
    }],
    ['/opt/homebrew/bin/claude', {
      name: 'claude',
      argv0: '/opt/homebrew/bin/claude',
      argv: ['/opt/homebrew/bin/claude', '--resume', 'x'],
      cmdline: '/opt/homebrew/bin/claude --resume x'
    }],
    // Not recognised as claude, and not the bare shell either: it waits out the window.
    ['a node with no argv to tell what it runs', { name: 'node', argv0: 'node', argv: ['node'], cmdline: 'node' }]
  ])('types nothing when the shell\'s foreground is %s', (_label, claude) => {
    const w = world(claudeUnderShell(claude as Proc))
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
    expect(w.keys()).toBe(0)
  })

  it('types nothing while that claude runs a Bash tool: a SHELL in front is not the bare root', () => {
    // The tool's `zsh -c` holds the foreground. Its name is a shell's, but it
    // is not the pane's root shell, so it is no evidence of a bare prompt.
    const w = world({
      root: '-zsh',
      foreground: [{ pid: 5100, name: 'zsh', argv0: '/bin/zsh', argv: ['/bin/zsh', '-c', 'git status'] }],
      group: 5100,
      screen: '⏺ Bash(git status)'
    })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })

  it.each([
    ['claude --permission-mode bypassPermissions --resume 523d324b'],
    ['/opt/homebrew/bin/claude --resume 523d324b'],
    ['claude.exe --resume 523d324b']
  ])('types nothing when the pane root is the agent itself (%s)', (root) => {
    const w = world(exec(root))
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })

  it('types nothing when the foreground cannot be read: no reading, no license', () => {
    const w = world({ root: '-zsh', foreground: [], screen: '%' })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })
})

describe('one wake, at most one boot line — plus a retry only for a line positively dropped', () => {
  it('reproduces the repeat: the line booted claude under the shell, and is never typed again', () => {
    // A true husk, whose first line landed. The root stays `-zsh` whenever the
    // agent ends up as the shell's child; the root-only check retyped into it
    // every beat for the rest of the window.
    const w = world(bareShell(), { onType: () => claudeUnderShell() })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })

  it('types nothing when herdr relaunches the agent between the husk verdict and the first type', () => {
    // 11-09: herdr restored the shell at 11:19:57 and started claude at
    // 11:19:58. A look in between sees a genuine bare shell.
    const w = world(bareShell(), { onRead: (n, pane) => (n === 1 ? pane : claudeUnderShell()) })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })

  it('types nothing when herdr resumes the agent a second after the shell first reads bare', () => {
    // Both the husk verdict and the re-read can land inside that second, on a
    // genuine bare prompt. Only a shell that HOLDS through a settle window
    // licenses the first line into an existing pane.
    const t0 = Date.now()
    const w = world(bareShell(), { onRead: (_n, pane) => (Date.now() - t0 >= 1000 ? claudeUnderShell() : pane) })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })

  it('still recovers a husk whose rc init ran `claude completion zsh` in front for a moment', () => {
    // That child is in the shell's group but leads nothing; it is no live agent.
    const completion: Pane = {
      ...bareShell(),
      foreground: [...bareShell().foreground, { pid: 5200, name: 'claude', argv0: 'claude', argv: ['claude', 'completion', 'zsh'] }]
    }
    const w = world(completion, {
      onRead: (n, pane) => (n > 3 && w.typed() === 0 ? bareShell() : pane),
      onType: () => exec(`sh ${BOOT}`)
    })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })

  it('stops once the pane turns from shell to agent between retries', () => {
    // First line dropped; the second look still shows the bare prompt; then
    // herdr's own resume starts claude before the next retry is due.
    let reads = 0
    const w = world(bareShell(), {
      onType: (_n, pane) => {
        reads = 0
        return pane
      },
      onRead: (_n, pane) => (++reads > 2 && w.typed() === 1 ? claudeUnderShell() : pane)
    })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })

  it('still retries a dropped first line once, and stops when the second one takes', () => {
    const w = world(bareShell(), {
      onType: (n, pane) => (n === 1 ? pane : exec(`sh ${BOOT}`))
    })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(2)
  })

  it('every type is ctrl+u, the line, then enter', () => {
    const w = world(bareShell(), { onType: () => exec(`sh ${BOOT}`) })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
    expect(w.keys()).toBe(2)
  })

  it('a line still queued behind a slow rc init is not retyped', () => {
    const w = world({ ...bareShell(), screen: `Last login: Mon Nov  9\n% clear; exec sh ${BOOT}\n` })
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })
})

describe('a pane this call created boots as before', () => {
  it('types at once into a created pane, and retries a dropped first line once', () => {
    const w = world(null, { onType: (n, pane) => (n === 1 ? pane : exec(`sh ${BOOT}`)) }, 'none')
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(2)
  })

  it('reads an ADOPTED pane before typing: an agent in the idle starter pane is left alone', () => {
    const w = world(claudeUnderShell(), {}, 'idle')
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(0)
  })

  it('boots an adopted bare pane once its shell holds', () => {
    const w = world(bareShell(), { onType: () => exec(`sh ${BOOT}`) }, 'idle')
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })

  it('types once into a fresh pane even when process-info cannot answer (no ps, Windows)', () => {
    const w = world(null)
    const runner = w.runner
    const run = runner.run
    runner.run = (file, args) => {
      if (args[0] === 'pane' && args[1] === 'process-info') throw new Error('process-info unavailable')
      return run(file, args)
    }
    backend(w).ensureSession(SPEC)
    expect(w.typed()).toBe(1)
  })
})

describe('classifyPaneRun — the reading that licenses typing', () => {
  const zsh = { pid: SHELL_PID, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }
  const read = (foreground: unknown[], group: number | null = SHELL_PID, rootArgv = '-zsh', kind = 'claude') =>
    classifyPaneRun({ rootPid: SHELL_PID, rootArgv, foreground, foregroundGroup: group }, kind, 'cookrew_abc')

  it('is a shell only with the root shell alone in front', () => {
    expect(read([zsh])).toBe('shell')
    expect(read([zsh], null)).toBe('shell')
    expect(read([zsh], 4000)).toBe('other')
    expect(read([zsh, { pid: 4000, name: 'git', argv: ['git', 'status'] }])).toBe('other')
    expect(read([{ name: 'zsh', argv0: 'zsh' }])).toBe('other')
    expect(read([])).toBe('other')
    expect(read(['garbage'])).toBe('other')
  })

  it('matches the kind by word, so a short kind is not found inside a path', () => {
    const pinky = { pid: 4144, name: 'Pinky', argv: ['/Applications/Pinky.app/Contents/MacOS/Pinky', 'mcp'] }
    expect(read([pinky], 4144, '-zsh', 'pi')).toBe('other')
    expect(read([{ pid: 4200, name: 'pi', argv: ['pi'] }], 4200, '-zsh', 'pi')).toBe('agent')
  })

  it('knows a native codex binary and a login-dashed name', () => {
    const codex = { pid: 3329, name: 'codex-aarch64-apple-darwin', argv: ['codex', 'resume', 'x'] }
    expect(read([codex], 3329, '-zsh', 'codex')).toBe('agent')
    expect(read([{ pid: 3373, argv0: '-claude' }], 3373)).toBe('agent')
  })

  it('sees this session\'s boot script in front as booting, never as a shell', () => {
    const sh = { pid: SHELL_PID, name: 'sh', argv: ['sh', BOOT] }
    expect(read([sh])).toBe('booting')
  })
})
