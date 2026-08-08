import { describe, expect, it } from 'vitest'
import {
  HerdrHostMultiplexer,
  agentKind,
  bootCommand,
  envArgs,
  parseEnvelope,
  parsePaneList,
  toScrollState
} from '../src/main/herdr-host-multiplexer'
import { selectMultiplexers } from '../src/main/multiplexer-select'
import type { AttachSpec, CommandRunner, Multiplexer } from '../src/main/multiplexer'

/**
 * This backend reverses an earlier "herdr cannot host" verdict. The reversal
 * rests on measurements, so the tests that encode those measurements are the
 * ones that matter most here — particularly the two capabilities that were
 * previously recorded as false.
 */

const SPEC: AttachSpec = {
  sessionName: 'cookrew_abc',
  command: 'claude --permission-mode bypassPermissions',
  shell: '/bin/zsh',
  terminalId: 'abc-123',
  socketPath: '/tmp/sock',
  cliDir: '/tmp/cli',
  path: '/tmp/cli:/usr/bin',
  cwd: '/work/repo'
}

const PANE_LIST = (panes: unknown[]): string =>
  JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } })

interface Call {
  file: string
  args: string[]
}

/** Records every invocation and replies from a scripted table. */
function fakeRunner(replies: Record<string, string> = {}): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  const key = (args: string[]): string => args.slice(0, 2).join(' ')
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args })
      const reply = replies[key(args)]
      if (reply === undefined) throw new Error(`no scripted reply for ${key(args)}`)
      return reply
    },
    runQuiet: (file, args) => {
      calls.push({ file, args })
    },
    probe: (file, args) => {
      calls.push({ file, args })
      return true
    }
  }
}

const mux = (replies?: Record<string, string>): HerdrHostMultiplexer =>
  new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/tmp/cookrew/config.toml',
    runner: fakeRunner(replies)
  })

describe('capabilities — the two that were previously recorded as false', () => {
  it('CAN attach: `agent attach` is pane-scoped, echoes, and carries no chrome', () => {
    // Measured against a Cookrew-owned chrome-free config: 27ms echo latency,
    // 0 bytes over 3s idle, no other pane's content, no herdr UI words.
    expect(mux().capabilities.attach).toBe(true)
  })

  it('DOES persist across restart — the only reason to run a multiplexer', () => {
    // Measured: the herdr session outlived its client being killed.
    expect(mux().capabilities.persistsAcrossRestart).toBe(true)
  })

  it('has monotonic history — scrollback depth rises with the session', () => {
    expect(mux().capabilities.monotonicHistory).toBe(true)
  })

  it('admits it cannot search: protocol 19 has no copy-mode', () => {
    // The one thing tmux does that herdr does not. Declaring it false lets the
    // UI hide the affordance rather than silently no-op.
    expect(mux().capabilities.copyModeSearch).toBe(false)
  })
})

describe('the pane label IS the session name', () => {
  const listing = PANE_LIST([
    { pane_id: 'w1:p1', label: 'cookrew_abc' },
    { pane_id: 'w1:p2', label: null },
    { pane_id: 'w1:p3', label: 'someone_elses_pane' }
  ])

  it('finds a session by label, so no id-mapping store is needed', () => {
    expect(mux({ 'pane list': listing }).sessionExists('cookrew_abc')).toBe(true)
    expect(mux({ 'pane list': listing }).sessionExists('cookrew_nope')).toBe(false)
  })

  it('lists only LABELLED panes — an unlabelled pane is not a Cookrew session', () => {
    // pty.ts's orphan reaper filters these again by naming, but a null label
    // must never surface as a session name in the first place.
    expect(mux({ 'pane list': listing }).listSessions()).toEqual([
      'cookrew_abc',
      'someone_elses_pane'
    ])
  })

  it('kills by resolving the label to a pane id', () => {
    const runner = fakeRunner({ 'pane list': listing })
    new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner
    }).killSession('cookrew_abc')
    expect(runner.calls.at(-1)).toEqual({ file: 'herdr', args: ['pane', 'close', 'w1:p1'] })
  })

  it('kills NOTHING when the label is absent — never closes a stranger pane', () => {
    const runner = fakeRunner({ 'pane list': listing })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).killSession('cookrew_x')
    expect(runner.calls.some((c) => c.args[0] === 'pane' && c.args[1] === 'close')).toBe(false)
  })
})

describe('ensureSession — idempotence IS the persistence guarantee', () => {
  it('does NOTHING when the pane already exists, so a live agent is reattached', () => {
    // The load-bearing assertion of this file: re-running the boot command on
    // an existing pane would kill and restart the user's agent on every app
    // launch, which is the exact opposite of what persistence means.
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc' }]),
      // The pane must LOOK live: ensureSession now verifies the agent is
      // actually running before trusting the label (the husk fix).
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const mutating = runner.calls.filter((c) => ['split', 'send-text', 'send-keys'].includes(c.args[1]))
    expect(mutating).toEqual([])
  })

  it('creates, LABELS, then boots — in that order', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_other' }]),
      'pane split': JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }),
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    // Only the MUTATIONS are asserted, and only their order. Reads are an
    // implementation detail (adoption looks at the pane list again), and
    // pinning them would make this test fail for changes that break nothing.
    const mutations = runner.calls
      .map((c) => c.args[1])
      .filter((verb) => ['split', 'rename', 'send-text', 'send-keys'].includes(verb))
    expect(mutations).toEqual(['split', 'rename', 'send-text', 'send-keys'])
  })

  it('labels BEFORE booting so a failed boot leaves a findable pane, not an orphan', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_other' }]),
      'pane split': JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }),
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const rename = runner.calls.findIndex((c) => c.args[1] === 'rename')
    const boot = runner.calls.findIndex((c) => c.args[1] === 'send-text')
    expect(rename).toBeLessThan(boot)
  })

  it('passes the cwd to herdr — the SERVER creates the pane, not node-pty', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_other' }]),
      'pane split': JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }),
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const split = runner.calls.find((c) => c.args[1] === 'split')!
    expect(split.args).toContain('--cwd')
    expect(split.args[split.args.indexOf('--cwd') + 1]).toBe('/work/repo')
  })

  it('creates a WORKSPACE for the first terminal — split needs something to split', () => {
    // An isolated herdr session starts with zero panes, and `pane split` there
    // fails with pane_not_found. Measured against a real server; without this
    // branch the very first Cookrew terminal could never start.
    const runner = fakeRunner({
      'pane list': PANE_LIST([]),
      'workspace create': JSON.stringify({ result: { root_pane: { pane_id: 'w1:p1' } } }),
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    expect(runner.calls.some((c) => c.args[0] === 'workspace' && c.args[1] === 'create')).toBe(true)
    expect(runner.calls.some((c) => c.args[1] === 'split')).toBe(false)
  })

  it('REPORTS the agent — without it `agent attach` fails with agent_not_found', () => {
    // Measured: attaching to a pane that merely runs an agent is rejected;
    // herdr resolves attach targets through its agent registry. This is also
    // the seam herdr's own detector corrects on top of.
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_other' }]),
      'pane split': JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }),
      'pane process-info': JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }] } }
    })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const report = runner.calls.find((c) => c.args[1] === 'report-agent')
    expect(report?.args).toContain('--agent')
    expect(report?.args[report.args.indexOf('--agent') + 1]).toBe('claude')
  })

  it('throws when herdr returns no pane, rather than attaching to nothing', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_other' }]),
      'pane split': JSON.stringify({ error: { code: 'nope' } })
    })
    expect(() =>
      new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    ).toThrow(/could not create a pane/)
  })
})

describe('attachSpawn', () => {
  it('attaches to the AGENT, not the session — session attach returns the TUI', () => {
    const m = mux({ 'pane list': PANE_LIST([{ pane_id: 'w1:p7', label: 'cookrew_abc' }]), 'agent get': JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'w1:p7' } } }) })
    expect(m.attachSpawn(SPEC)).toEqual({
      file: 'herdr',
      args: ['agent', 'attach', 'w1:p7', '--takeover'],
      env: { HERDR_SESSION: 'cookrewtest', HERDR_CONFIG_PATH: '/tmp/cookrew/config.toml' }
    })
  })

  it('TAKES OVER, because Cookrew drops its client by killing the PTY', () => {
    // Measured: a workspace switch or quit SIGKILLs the client, which herdr
    // sees as a client that never detached. Without takeover the next attach
    // does not get the pane and the terminal comes back blank.
    const m = mux({ 'pane list': PANE_LIST([{ pane_id: 'w1:p7', label: 'cookrew_abc' }]), 'agent get': JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'w1:p7' } } }) })
    expect(m.attachSpawn(SPEC).args).toContain('--takeover')
  })

  it('carries the session env — an env-less attach talks to the WRONG server', () => {
    // Measured in the running app: panes healthy on Cookrew's server, every
    // terminal blank, because the attach resolved the user's default socket
    // (stopped) — HERDR_SESSION selects the server and only the backend
    // knows it. tmux never needed this; its target rides in the argv.
    const m = mux({ 'pane list': PANE_LIST([{ pane_id: 'w1:p7', label: 'cookrew_abc' }]), 'agent get': JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'w1:p7' } } }) })
    expect(m.attachSpawn(SPEC).env?.HERDR_SESSION).toBe('cookrewtest')
  })

  it('refuses to guess when the pane is missing', () => {
    expect(() => mux({ 'pane list': PANE_LIST([]) }).attachSpawn(SPEC)).toThrow(/ensureSession/)
  })
})

describe('boot command and env', () => {
  it('EXECs the agent so the pane pid IS the agent pid', () => {
    // codex rollout binding resolves the agent by pane pid via lsof; without
    // exec the pid would be the shell's and the binding would find nothing.
    expect(bootCommand(SPEC)).toContain('exec claude --permission-mode bypassPermissions')
    expect(bootCommand(SPEC).endsWith('exec claude --permission-mode bypassPermissions')).toBe(true)
  })

  it('exports the env itself, because an ADOPTED pane cannot be given one', () => {
    // The server's idle starter pane already exists with the server's
    // environment; `pane split --env` can only help panes Cookrew creates.
    // One boot command has to be correct for both paths.
    const boot = bootCommand(SPEC)
    expect(boot).toContain("export COOKREW_TERMINAL_ID='abc-123'")
    expect(boot).toContain("export COOKREW_CLI='/tmp/cli/cookrew'")
    expect(boot).toContain("export PATH='/tmp/cli:/usr/bin'")
  })

  it('falls back to a login shell when there is no command', () => {
    expect(bootCommand({ ...SPEC, command: '   ' }).endsWith('exec /bin/zsh -l')).toBe(true)
  })

  it('passes env as real herdr env pairs, not an exported-vars shell script', () => {
    const args = envArgs(SPEC)
    expect(args).toContain('COOKREW_TERMINAL_ID=abc-123')
    expect(args).toContain('COOKREW_SOCKET=/tmp/sock')
    expect(args).toContain('COOKREW_CLI=/tmp/cli/cookrew')
    expect(args.filter((a) => a === '--env')).toHaveLength(5)
  })
})

describe('scroll — and the counter that only LOOKS monotonic', () => {
  it('uses max_offset_from_bottom as history: it rises with the session', () => {
    expect(toScrollState({ pane_id: 'p', scroll: { offset_from_bottom: 0, max_offset_from_bottom: 141 } }))
      .toEqual({ scrollRow: null, historySize: 141 })
  })

  it('maps a live pane (offset 0) to NULL, matching tmux', () => {
    // Callers read null as "live". herdr has no copy-mode, so tmux's literal
    // 0 ("at the bottom but browsing") is a state that cannot occur here.
    expect(
      toScrollState({ pane_id: 'p', scroll: { offset_from_bottom: 0, max_offset_from_bottom: 10 } })
        .scrollRow
    ).toBeNull()
  })

  it('reports a real scroll offset when the pane IS scrolled up', () => {
    expect(
      toScrollState({ pane_id: 'p', scroll: { offset_from_bottom: 12, max_offset_from_bottom: 90 } })
        .scrollRow
    ).toBe(12)
  })

  it('ignores `revision` entirely — measured flat at 1 across four bursts', () => {
    // Regression guard for a trap: `revision` reads like an output counter and
    // is not one. Anchoring checkpoints on it would resurrect the degenerate
    // scrollLine bug, so a pane carrying ONLY a revision must yield no history.
    expect(toScrollState({ pane_id: 'p', revision: 7 })).toEqual({
      scrollRow: null,
      historySize: null
    })
  })

  it('answers "no signal" for an unknown session rather than zeros', () => {
    expect(mux({ 'pane list': PANE_LIST([]) }).scrollState('cookrew_gone')).toEqual({
      scrollRow: null,
      historySize: null
    })
  })
})

describe('parsing herdr envelopes', () => {
  it('reads the result out of a success envelope', () => {
    expect(parseEnvelope('{"id":"x","result":{"ok":1}}')).toEqual({ ok: 1 })
  })

  it('treats an error envelope as no signal', () => {
    expect(parseEnvelope('{"id":"x","error":{"code":"server_not_running"}}')).toBeNull()
  })

  it('survives non-JSON output instead of throwing into a call site', () => {
    expect(parseEnvelope('no herdr server is running')).toBeNull()
    expect(parsePaneList('garbage')).toEqual([])
  })
})

describe('selection', () => {
  const unavailableTmux = {
    id: 'tmux',
    capabilities: {
      attach: true,
      copyModeSearch: true,
      monotonicHistory: true,
      persistsAcrossRestart: true
    },
    available: () => false
  } as unknown as Multiplexer

  it('can host — so Windows gets persistence, which `direct` cannot give it', () => {
    const roles = selectMultiplexers({ candidates: [unavailableTmux, mux()] })
    expect(roles.host.id).toBe('herdr')
    expect(roles.host.capabilities.persistsAcrossRestart).toBe(true)
  })
})

describe('agentKind — the label reported to herdr', () => {
  it('is the command binary — herdr kinds share the agent binary names', () => {
    expect(agentKind('claude --permission-mode bypassPermissions')).toBe('claude')
    expect(agentKind('/opt/homebrew/bin/codex resume')).toBe('codex')
    expect(agentKind('opencode')).toBe('opencode')
  })

  it('never reports an empty label — report-agent requires one', () => {
    expect(agentKind('   ')).toBe('shell')
    expect(agentKind('')).toBe('shell')
  })
})

describe('panePid', () => {
  it('passes the pane as a FLAG — positionally herdr answers "unknown option"', () => {
    // This returned null for every pane until it was measured live, which
    // would have silently broken codex rollout binding (resolved by pane pid).
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc' }]),
      'pane process-info': JSON.stringify({
        result: { process_info: { shell_pid: 4242, foreground_processes: [{ pid: 99 }] } }
      })
    })
    const m = new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner })
    expect(m.panePid('cookrew_abc')).toBe(4242)
    const call = runner.calls.find((c) => c.args[1] === 'process-info')!
    expect(call.args).toContain('--pane')
  })

  it('is null for an unknown session rather than a wrong pid', () => {
    expect(mux({ 'pane list': PANE_LIST([]) }).panePid('cookrew_gone')).toBeNull()
  })
})

describe('husk recovery — a restored label is not a recovered agent', () => {
  // herdr persists pane LAYOUT, not processes: when its server dies, agents
  // die with it, and the next server restores each pane as a fresh shell
  // wearing the old label. Measured live; scratchpad/herdr-server-restart-probe
  // is the end-to-end version of these tests.
  const husk = (processInfo: string | undefined): ReturnType<typeof fakeRunner> =>
    fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc' }]),
      ...(processInfo === undefined ? {} : { 'pane process-info': processInfo })
    })
  const shellInfo = JSON.stringify({
    result: {
      process_info: {
        shell_pid: 9,
        foreground_processes: [{ argv: ['-zsh'], argv0: 'zsh', name: 'zsh', pid: 9 }]
      }
    }
  })

  it('REBOOTS the existing pane when its foreground is a bare shell', () => {
    const runner = husk(shellInfo)
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .ensureSession(SPEC)
    // Into the SAME pane — no split, no new workspace, and the typed boot.
    expect(runner.calls.some((c) => c.args[1] === 'send-text' && c.args[2] === 'w1:p1')).toBe(true)
    expect(runner.calls.some((c) => c.args[1] === 'split')).toBe(false)
    expect(runner.calls.some((c) => c.args[0] === 'workspace')).toBe(false)
  })

  it('re-REPORTS the agent after a husk reboot — registration died with the server', () => {
    const runner = husk(shellInfo)
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .ensureSession(SPEC)
    expect(runner.calls.some((c) => c.args[1] === 'report-agent')).toBe(true)
  })

  it('does NOT reboot when the expected agent is visible in the pane argv', () => {
    // argv containment, not argv0 equality: script-wrapper agents exec through
    // an interpreter, so a live claude pane can report argv0 `node`.
    const live = husk(
      JSON.stringify({
        result: {
          process_info: {
            shell_pid: 7,
            foreground_processes: [
              { argv: ['node', '/usr/local/bin/claude'], argv0: 'node', name: 'node', pid: 7 }
            ]
          }
        }
      })
    )
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner: live, settleMs: 10 })
      .ensureSession(SPEC)
    expect(live.calls.some((c) => c.args[1] === 'send-text')).toBe(false)
  })

  it('does NOT mistake an rc-init child process for a husk OR a live agent', () => {
    // The restored shell's rc runs children like `git` (prompt frameworks).
    // "Not a shell" once meant "must be the agent" and silently skipped
    // recovery; the fix polls for a POSITIVE identification and, absent one,
    // refuses to type. Typing needs a license, and ambiguity is not one.
    const rcInit = husk(
      JSON.stringify({
        result: {
          process_info: {
            shell_pid: 9,
            foreground_processes: [{ argv: ['git', 'status'], argv0: 'git', name: 'git', pid: 11 }]
          }
        }
      })
    )
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner: rcInit, settleMs: 10 })
      .ensureSession(SPEC)
    expect(rcInit.calls.some((c) => c.args[1] === 'send-text')).toBe(false)
  })

  it('refuses to act when process-info is unanswerable', () => {
    // The fake runner throws on unscripted `run` calls, which is exactly the
    // shape of a transiently erroring process-info after a server restart.
    const runner = husk(undefined)
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .ensureSession(SPEC)
    expect(runner.calls.some((c) => c.args[1] === 'send-text')).toBe(false)
  })

  it('never reboots a terminal whose command IS a shell — its husk is indistinguishable', () => {
    const runner = husk(shellInfo)
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .ensureSession({ ...SPEC, command: '' })
    expect(runner.calls.some((c) => c.args[1] === 'send-text')).toBe(false)
  })
})

describe('attachSpawn never hands out an argv that exits instantly', () => {
  // `agent attach` on an unresolvable target prints agent_not_found and exits
  // within milliseconds — and near-instant PTY exits land in node-pty's known
  // native crash window (Napi::Error in the exit ThreadSafeFunction, libc++
  // abort). This is the 2026-08-08 launch crash, so the registry entry is
  // verified — and repaired — before the argv leaves the backend.
  it('re-reports the agent when the registry no longer resolves the pane', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p7', label: 'cookrew_abc' }])
      // 'agent get' deliberately unscripted: the throw IS the unresolvable case.
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .attachSpawn(SPEC)
    const report = runner.calls.find((c) => c.args[1] === 'report-agent')
    expect(report?.args[2]).toBe('w1:p7')
  })

  it('does NOT re-report when the agent already resolves', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p7', label: 'cookrew_abc' }]),
      'agent get': JSON.stringify({ result: { agent: { agent: 'claude' } } })
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner, settleMs: 10 })
      .attachSpawn(SPEC)
    expect(runner.calls.some((c) => c.args[1] === 'report-agent')).toBe(false)
  })
})

describe('attachability is re-established on EVERY attach', () => {
  const HEALTHY = JSON.stringify({
    result: {
      process_info: {
        shell_pid: 7,
        foreground_processes: [{ argv: ['claude'], argv0: 'claude', name: 'claude', pid: 7 }]
      }
    }
  })

  it('re-reports the agent for a healthy EXISTING pane', () => {
    // The bug this guards: herdr restores panes from disk across a server
    // restart WITHOUT their agent registration, while the process keeps
    // running. `agent attach` resolves through that registry, so the pane
    // becomes permanently unattachable — terminal never opens, transcript
    // never renders. Measured live: 5 of 17 panes in that state.
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc', agent: 'claude' }]),
      'pane process-info': HEALTHY
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    expect(runner.calls.some((c) => c.args[1] === 'report-agent')).toBe(true)
  })

  it('still does NOT reboot the agent while re-reporting', () => {
    // Re-registering must not become a second way to restart a live agent.
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc', agent: 'claude' }]),
      'pane process-info': HEALTHY
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const mutating = runner.calls.filter((c) => ['split', 'send-text', 'send-keys'].includes(c.args[1]))
    expect(mutating).toEqual([])
  })

  it('preserves the state herdr already holds instead of asserting idle', () => {
    // Cookrew feeds this state into turn-tracker now. Claiming `idle` over a
    // working agent would end the turn early and mint a checkpoint from a
    // half-written reply.
    const runner = fakeRunner({
      'pane list': PANE_LIST([
        { pane_id: 'w1:p1', label: 'cookrew_abc', agent: 'claude', agent_status: 'working' }
      ]),
      'pane process-info': HEALTHY
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const report = runner.calls.find((c) => c.args[1] === 'report-agent')!
    expect(report.args[report.args.indexOf('--state') + 1]).toBe('working')
  })

  it('falls back to `unknown`, never a guessed idle', () => {
    const runner = fakeRunner({
      'pane list': PANE_LIST([
        { pane_id: 'w1:p1', label: 'cookrew_abc', agent: 'claude', agent_status: 'unknown' }
      ]),
      'pane process-info': HEALTHY
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession(SPEC)
    const report = runner.calls.find((c) => c.args[1] === 'report-agent')!
    expect(report.args[report.args.indexOf('--state') + 1]).toBe('unknown')
  })

  it('keeps the agent herdr recorded over one derived from the command', () => {
    // A node whose command was edited must not have its restored registration
    // relabelled to something the pane is not running.
    const runner = fakeRunner({
      'pane list': PANE_LIST([{ pane_id: 'w1:p1', label: 'cookrew_abc', agent: 'codex' }]),
      'pane process-info': HEALTHY
    })
    new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner }).ensureSession({
      ...SPEC,
      command: 'claude --permission-mode bypassPermissions'
    })
    const report = runner.calls.find((c) => c.args[1] === 'report-agent')!
    expect(report.args[report.args.indexOf('--agent') + 1]).toBe('codex')
  })
})
