import { describe, expect, it } from 'vitest'
import {
  bootScript,
  parsePaneLaunch,
  parseScrollState,
  sessionNameFor,
  TmuxMultiplexer,
  TMUX_LABEL
} from '../src/main/tmux-multiplexer'
import type { AttachSpec, CommandRunner } from '../src/main/multiplexer'

/**
 * P0 characterisation tests: these pin what tmux ALREADY does, so the seam
 * extraction is provably behaviour-preserving and any future backend has an
 * executable definition of "correct" rather than a prose one.
 */

interface Recorded {
  calls: string[][]
  runner: CommandRunner
}

function fakeRunner(responses: Record<string, string> = {}, fails = new Set<string>()): Recorded {
  const calls: string[][] = []
  const key = (args: string[]): string => args.join(' ')
  return {
    calls,
    runner: {
      run: (_file, args) => {
        calls.push(args)
        const match = Object.keys(responses).find((k) => key(args).includes(k))
        if (match === undefined) throw new Error(`no stub for: ${key(args)}`)
        return responses[match]
      },
      runQuiet: (_file, args) => {
        calls.push(args)
      },
      probe: (_file, args) => {
        calls.push(args)
        return !fails.has(key(args))
      }
    }
  }
}

const SPEC: AttachSpec = {
  sessionName: 'cookrew_abc',
  command: 'claude --permission-mode bypassPermissions',
  shell: '/bin/zsh',
  terminalId: 'abc-123',
  socketPath: '/tmp/sock',
  cliDir: '/tmp/cli',
  path: '/tmp/cli:/usr/bin',
  cwd: '/tmp/work'
}

describe('sessionNameFor', () => {
  it('strips characters tmux cannot put in a session name', () => {
    expect(sessionNameFor('abc-123.def:ghi')).toBe('cookrew_abc123defghi')
  })

  it('caps the id so the name stays workable', () => {
    expect(sessionNameFor('a'.repeat(80))).toBe(`cookrew_${'a'.repeat(24)}`)
  })
})

describe('parseScrollState', () => {
  it('reads the packed scroll_position:history_size round-trip', () => {
    expect(parseScrollState('12:3400\n')).toEqual({ scrollRow: 12, historySize: 3400 })
  })

  it('reports a LIVE pane as null rather than zero', () => {
    // tmux emits an empty scroll_position when the pane is not in copy-mode.
    // Zero means "browsing, at the bottom" — a different state entirely, and
    // conflating them would make a live pane look scrolled.
    expect(parseScrollState(':3400')).toEqual({ scrollRow: null, historySize: 3400 })
  })

  it('survives junk without throwing', () => {
    expect(parseScrollState('')).toEqual({ scrollRow: null, historySize: null })
    expect(parseScrollState('garbage')).toEqual({ scrollRow: null, historySize: null })
  })
})

describe('parsePaneLaunch', () => {
  it('splits the created timestamp from the command and converts to ms', () => {
    expect(parsePaneLaunch('1786073186\tsh -c exec claude\n')).toEqual({
      command: 'sh -c exec claude',
      startedAtMs: 1786073186000
    })
  })

  it('keeps tabs inside the command itself', () => {
    expect(parsePaneLaunch('1\ta\tb')?.command).toBe('a\tb')
  })

  it('is null when there is no command — an empty pane is not a launch', () => {
    expect(parsePaneLaunch('1786073186\t')).toBeNull()
    expect(parsePaneLaunch('')).toBeNull()
  })
})

describe('bootScript', () => {
  it('exports the CLI bridge vars and execs the agent command', () => {
    const script = bootScript(SPEC)
    expect(script).toContain("export COOKREW_TERMINAL_ID='abc-123'")
    expect(script).toContain("export COOKREW_SOCKET='/tmp/sock'")
    expect(script).toContain("export COOKREW_CLI='/tmp/cli/cookrew'")
    expect(script).toContain('export TERM_PROGRAM=Cookrew')
    expect(script).toContain('exec claude --permission-mode bypassPermissions')
  })

  it('falls back to a LOGIN shell when there is no command', () => {
    // -l matters: a GUI-launched app inherits a stripped environment.
    expect(bootScript({ ...SPEC, command: '' })).toContain('exec /bin/zsh -l')
    expect(bootScript({ ...SPEC, command: '   ' })).toContain('exec /bin/zsh -l')
  })
})

describe('TmuxMultiplexer', () => {
  const mux = (r: Recorded): TmuxMultiplexer =>
    new TmuxMultiplexer({ configFile: '/tmp/cookrew.tmux.conf', runner: r.runner })

  it('always targets Cookrew’s own server, never the user’s', () => {
    const r = fakeRunner({ 'capture-pane': 'hello' })
    mux(r).capture('cookrew_abc')
    for (const call of r.calls) expect(call.slice(0, 2)).toEqual(['-L', TMUX_LABEL])
  })

  it('reattaches with new-session -A so a restart keeps the running agent', () => {
    const spawn = mux(fakeRunner()).attachSpawn(SPEC)
    expect(spawn.file).toBe('tmux')
    expect(spawn.args).toContain('new-session')
    expect(spawn.args).toContain('-A')
    expect(spawn.args).toContain('cookrew_abc')
    expect(spawn.args.join(' ')).toContain('-f /tmp/cookrew.tmux.conf')
  })

  it('lists only Cookrew sessions — the reaper must not touch foreign ones', () => {
    const r = fakeRunner({ 'list-sessions': 'cookrew_abc\nmy-own-work\ncookrew_def\n' })
    expect(mux(r).listSessions()).toEqual(['cookrew_abc', 'cookrew_def'])
  })

  it('treats "no tmux server" as no sessions, not as an error', () => {
    const r = fakeRunner() // every run() throws
    expect(mux(r).listSessions()).toEqual([])
  })

  it('probes availability once and caches it', () => {
    const r = fakeRunner()
    const m = mux(r)
    m.available()
    m.available()
    m.available()
    expect(r.calls.filter((c) => c[0] === '-V')).toHaveLength(1)
  })

  it('reports unavailable tmux without throwing, and degrades every read', () => {
    const r = fakeRunner({}, new Set(['-V']))
    const m = mux(r)
    expect(m.available()).toBe(false)
    expect(m.listSessions()).toEqual([])
    expect(m.panePid('cookrew_abc')).toBeNull()
    expect(m.paneLaunch('cookrew_abc')).toBeNull()
  })

  it('returns null capture for a session that is gone', () => {
    expect(mux(fakeRunner()).capture('cookrew_gone')).toBeNull()
  })

  it('takes the FIRST pane pid when a session somehow has several', () => {
    const r = fakeRunner({ '-V': '', 'list-panes': '4242\n4243\n' })
    expect(mux(r).panePid('cookrew_abc')).toBe(4242)
  })

  it('restarts copy-mode from the tail so repeated jumps are deterministic', () => {
    const r = fakeRunner()
    mux(r).jumpToText('cookrew_abc', 'needle')
    const sent = r.calls.map((c) => c.join(' '))
    expect(sent[0]).toContain('-X cancel')
    expect(sent[1]).toContain('copy-mode')
    expect(sent[2]).toContain('search-backward needle')
  })

  it('declares the capabilities a replacement has to match', () => {
    expect(mux(fakeRunner()).capabilities).toEqual({
      attach: true,
      copyModeSearch: true,
      // tmux scrolls via copy-mode COMMANDS, not by consuming wheel input.
      wheelScrollback: false,
      monotonicHistory: true,
      persistsAcrossRestart: true,
      // tmux knows nothing about agents — it multiplexes terminals. This is
      // the one capability the herdr backend has that tmux does not, and it
      // is why `cookrew ask` still infers quiescence here.
      agentLifecycle: false
    })
  })
})
