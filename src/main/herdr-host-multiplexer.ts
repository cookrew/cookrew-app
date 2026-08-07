// herdr as the HOST backend — the tmux replacement.
//
// THIS REVERSES AN EARLIER VERDICT, SO THE EVIDENCE IS RECORDED HERE
// ------------------------------------------------------------------
// herdr-multiplexer.ts (read-only) states that herdr cannot host a terminal:
// `session attach` returned 97,553 bytes of TUI repaint against tmux's 2,090,
// and typed input was never echoed. Both measurements were real; both were the
// WRONG EXPERIMENT, and the conclusion drawn from them was wrong:
//
//   1. They ran against the user's own herdr config, with the sidebar, tab bar,
//      pane borders and scrollbars on. That chrome IS the 97KB — it is not
//      inherent to attaching.
//   2. Input was pushed over the SOCKET (`pane send-text`) while the stream was
//      read from an attached client. The client never saw a keystroke, so of
//      course nothing echoed. Cookrew types into the client's stdin.
//
// Re-measured with a Cookrew-owned config (chrome off) and input written to the
// PTY, `herdr agent attach <pane>` gives:
//
//   boot paint            56 KB, once
//   idle bytes over 3s    0          <- the stream genuinely goes quiet
//   echo latency          27 ms, cursor drawn by the host terminal
//   other panes' content  absent     <- attach is pane-scoped
//   herdr chrome          absent
//   session vs client     session survived the client being killed
//
// The last row is the one that matters most: it is `persistsAcrossRestart`,
// which is the only reason Cookrew runs a multiplexer at all.
//
// WHY THE PANE LABEL IS THE SESSION NAME
// --------------------------------------
// Cookrew addresses terminals by a session name (`cookrew_<terminalId>`), and
// pty.ts's reaper, orphan detection and kill paths are all built on that. herdr
// addresses panes by id (`w1:p3`), which is assigned by herdr and means nothing
// to Cookrew. Rather than introduce a second identity and a store to map
// between them, this backend writes the session name into the pane's LABEL —
// which herdr persists and returns in `pane list`. Lookup is therefore
// stateless and every existing call site keeps working untouched.
//
// WHY THE CLI AND NOT THE SOCKET
// ------------------------------
// The Multiplexer interface is synchronous, and herdr's protocol is a
// line-delimited JSON socket that closes after each reply. Making the interface
// async would ripple through pty.ts and every caller for no user-visible gain,
// so the sync path shells out to `herdr` exactly as the tmux backend shells out
// to `tmux` — the same CommandRunner seam, the same per-call process cost.
// The PUSH path (agent status) is a different concern and does not come through
// this interface; it holds a socket open, because that is what it needs.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AttachSpawn,
  AttachSpec,
  CommandRunner,
  Multiplexer,
  MultiplexerCapabilities,
  PaneLaunch,
  ScrollState
} from './multiplexer'

/** Cookrew's own herdr session, isolated from the user's — tmux's `-L cookrew`. */
export const HERDR_SESSION = 'cookrew'

/** A pane herdr reports in `pane list`. Only the fields Cookrew reads. */
export interface HerdrPane {
  pane_id: string
  label?: string | null
  terminal_id?: string | null
  cwd?: string | null
  revision?: number
  scroll?: {
    offset_from_bottom?: number
    max_offset_from_bottom?: number
    viewport_rows?: number
  }
}

/**
 * `{"id":...,"result":{...}}` or `{"id":...,"error":{...}}`.
 * Returns null for an error envelope or unparseable output, because every
 * caller here already has a "no signal" branch and none of them can act on the
 * distinction.
 */
export function parseEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const msg = JSON.parse(raw.trim()) as { result?: unknown; error?: unknown }
    if (!msg || typeof msg !== 'object' || msg.error) return null
    return (msg.result as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

/** Panes out of a `pane list` envelope, or [] when herdr said anything else. */
export function parsePaneList(raw: string): HerdrPane[] {
  const result = parseEnvelope(raw)
  const panes = result?.panes
  return Array.isArray(panes) ? (panes as HerdrPane[]) : []
}

/**
 * herdr scroll -> Cookrew scroll.
 *
 * `max_offset_from_bottom` is the scrollback depth, and it RISES with the
 * session (measured: 0 -> 18 -> 59 -> 100 -> 141 across four output bursts).
 * That makes it the faithful stand-in for tmux's history_size, which is what
 * checkpoint ordering anchors on.
 *
 * `revision` is NOT that counter, despite looking like one: it stayed at 1
 * across all four bursts. It versions pane metadata, not output. Using it for
 * ordering would have reintroduced the degenerate-scrollLine bug in a new
 * disguise, so it is deliberately unused.
 *
 * `offset_from_bottom` is 0 for a live pane. tmux reports null when the pane is
 * not being browsed, and callers treat null as "live", so 0 maps to null rather
 * than to 0 — herdr has no copy-mode, so "at the bottom but browsing" (tmux's
 * literal 0) is a state that cannot occur here.
 */
export function toScrollState(pane: HerdrPane | null): ScrollState {
  const scroll = pane?.scroll
  if (!scroll) return { scrollRow: null, historySize: null }
  const offset = scroll.offset_from_bottom
  const max = scroll.max_offset_from_bottom
  return {
    scrollRow: typeof offset === 'number' && offset > 0 ? offset : null,
    historySize: typeof max === 'number' ? max : null
  }
}

/**
 * The boot script's contents.
 *
 * herdr DOES accept a real env map on `pane split`, which would make the
 * exports unnecessary — but only for panes Cookrew creates. An ADOPTED pane
 * (the workspace's root pane) already exists with the server's environment, and
 * no split option can retrofit it. Exporting here makes one boot path correct
 * for both.
 *
 * The `exec` is load-bearing: it replaces the pane's shell with the agent, so
 * the pane pid IS the agent pid — which is how codex rollouts are bound by
 * lsof. The single quotes are the same containment tmux's boot script uses.
 */
export function bootCommand(spec: AttachSpec): string {
  const inner = spec.command && spec.command.trim().length > 0 ? spec.command : `${spec.shell} -l`
  return [
    `export TERM_PROGRAM=Cookrew`,
    `export COOKREW_TERMINAL_ID='${spec.terminalId}'`,
    `export COOKREW_SOCKET='${spec.socketPath}'`,
    // path.posix for the same reason the tmux boot script uses it: this string
    // is read by the pane's POSIX shell, so backslashes would be escapes.
    `export COOKREW_CLI='${path.posix.join(spec.cliDir, 'cookrew')}'`,
    `export PATH='${spec.path}'`,
    `exec ${inner}`
  ].join('; ')
}

/** Env every Cookrew pane needs, as herdr `--env KEY=VALUE` arguments. */
export function envArgs(spec: AttachSpec): string[] {
  return [
    ['TERM_PROGRAM', 'Cookrew'],
    ['COOKREW_TERMINAL_ID', spec.terminalId],
    ['COOKREW_SOCKET', spec.socketPath],
    // path.posix for the same reason the tmux boot script uses it: this is a
    // value the pane's POSIX shell will see, not a host filesystem path.
    ['COOKREW_CLI', path.posix.join(spec.cliDir, 'cookrew')],
    ['PATH', spec.path]
  ].flatMap(([key, value]) => ['--env', `${key}=${value}`])
}

/**
 * A runner that points every `herdr` invocation at COOKREW's session.
 *
 * The env is baked into the RUNNER rather than added as a CommandRunner
 * parameter on purpose: only this backend needs it, and widening the shared
 * interface would make every tmux call site carry an argument it can never use.
 * This is the same isolation tmux gets from `-L cookrew` — without it, Cookrew
 * would create panes in whatever herdr session the user happens to be running.
 */
export function createHerdrRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return {
    run: (file, args) =>
      execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }),
    runQuiet: (file, args) => {
      try {
        execFileSync(file, args, { stdio: 'ignore', env })
      } catch {
        // Best effort by contract — see CommandRunner.
      }
    },
    probe: (file, args) => {
      try {
        return spawnSync(file, args, { stdio: 'ignore', env }).status === 0
      } catch {
        return false
      }
    }
  }
}

/**
 * The agent kind Cookrew reports for a pane.
 *
 * herdr's kinds (claude, codex, opencode, gemini, ...) are the same names the
 * agent binaries have, so the first token of the boot command is the answer
 * without a lookup table that would drift from the harness registry.
 */
export function agentKind(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return base.length > 0 ? base : 'shell'
}

export interface HerdrHostOptions {
  /**
   * Cookrew's herdr SESSION name — the isolation boundary, and tmux's
   * `-L cookrew`.
   *
   * It must be a session and not merely a socket path. `HERDR_SOCKET_PATH`
   * alone moves the socket but NOT the state directory: a server started that
   * way came up holding the user's own workspace and panes, which Cookrew
   * would then have adopted and renamed. `HERDR_SESSION` gives a private
   * directory and a private socket, and its pane list starts empty.
   */
  session: string
  /** Cookrew's herdr config — the chrome-off one that makes attach transparent. */
  configPath: string
  runner?: CommandRunner
  /**
   * Start Cookrew's herdr server. Injected so the backend is testable without
   * spawning a daemon, and so the wait strategy lives in one place.
   */
  startServer?: () => void
  /** Overridable for tests; real waits are a poll against the socket. */
  waitForServerMs?: number
}

/**
 * Start a detached `herdr server` on Cookrew's socket.
 *
 * `detached` + `unref` is the point: the server has to OUTLIVE Cookrew, because
 * outliving Cookrew is the entire feature. A child that dies with the app would
 * make `persistsAcrossRestart` a lie.
 */
export function spawnHerdrServer(env: NodeJS.ProcessEnv): void {
  const child = spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env })
  child.unref()
}

export class HerdrHostMultiplexer implements Multiplexer {
  readonly id = 'herdr'

  readonly capabilities: MultiplexerCapabilities = {
    // MEASURED, not assumed — see the header. `agent attach` against a
    // chrome-free config echoes at 27ms and leaks neither chrome nor other
    // panes.
    attach: true,
    // Protocol 19 has no pane search: there is no copy-mode to drive and no
    // scroll-to-match method. Declared false so the UI hides the affordance
    // instead of silently no-opping. This is the one capability tmux has and
    // herdr does not.
    copyModeSearch: false,
    // scroll.max_offset_from_bottom rises with the session (measured).
    monotonicHistory: true,
    // MEASURED: the session outlived its client being killed.
    persistsAcrossRestart: true
  }

  private readonly runner: CommandRunner
  private readonly startServer: () => void
  private readonly waitForServerMs: number
  private probed: boolean | null = null
  private serverUp = false

  constructor(options: HerdrHostOptions) {
    const env = {
      ...process.env,
      HERDR_SESSION: options.session,
      HERDR_CONFIG_PATH: options.configPath
    }
    this.runner = options.runner ?? createHerdrRunner(env)
    this.startServer = options.startServer ?? (() => spawnHerdrServer(env))
    this.waitForServerMs = options.waitForServerMs ?? 5000
  }

  /**
   * Cookrew's herdr server, started on demand.
   *
   * `herdr --version` succeeds whether or not a server is running, so probing
   * the binary is NOT enough: without this, Cookrew would happily select herdr
   * as its host and then fail to create a single pane. The wait is a busy poll
   * because the interface is synchronous and this runs once per app launch.
   */
  private ensureServer(): boolean {
    if (this.serverUp) return true
    if (this.serverRunning()) {
      this.serverUp = true
      return true
    }
    this.startServer()
    const deadline = Date.now() + this.waitForServerMs
    while (Date.now() < deadline) {
      if (this.serverRunning()) {
        this.serverUp = true
        return true
      }
    }
    return false
  }

  /**
   * Liveness, probed with a command that actually needs the server.
   *
   * NOT `herdr status server`: it exits 0 and prints "status: not running" when
   * there is no server, so probing it reports success for a dead socket and
   * Cookrew then tries to create panes on nothing. `pane list` exits 1, which
   * is the difference between a check and a check that means something.
   */
  private serverRunning(): boolean {
    return this.runner.probe('herdr', ['pane', 'list'])
  }

  available(): boolean {
    if (this.probed === null) this.probed = this.runner.probe('herdr', ['--version'])
    return this.probed
  }

  private herdr(args: string[]): string {
    return this.runner.run('herdr', args)
  }

  private quiet(args: string[]): void {
    this.runner.runQuiet('herdr', args)
  }

  /** Every Cookrew pane, by label. */
  private panes(): HerdrPane[] {
    if (!this.available()) return []
    try {
      return parsePaneList(this.herdr(['pane', 'list']))
    } catch {
      // No server running is the ordinary "no sessions" case, not an error.
      return []
    }
  }

  private paneFor(name: string): HerdrPane | null {
    return this.panes().find((pane) => pane.label === name) ?? null
  }

  sessionExists(name: string): boolean {
    return this.paneFor(name) !== null
  }

  listSessions(): string[] {
    return this.panes()
      .map((pane) => pane.label)
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
  }

  killSession(name: string): void {
    const pane = this.paneFor(name)
    if (!pane) return
    this.quiet(['pane', 'close', pane.pane_id])
  }

  /**
   * Create the pane and start the agent — unless the pane is already there,
   * in which case do NOTHING and let the attach reattach a running agent.
   * That early return is the whole persistence guarantee.
   */
  ensureSession(spec: AttachSpec): void {
    if (!this.available()) return
    if (!this.ensureServer()) throw new Error('herdr server did not come up on Cookrew\'s socket')
    if (this.paneFor(spec.sessionName)) return

    const pane = this.adoptOrCreate(spec)
    if (!pane?.pane_id) throw new Error(`herdr could not create a pane for '${spec.sessionName}'`)

    // Label FIRST: if the boot command fails, the pane is still findable and
    // killable by name rather than leaking as an unlabelled orphan.
    this.quiet(['pane', 'rename', pane.pane_id, spec.sessionName])

    // Boot from a FILE, not by typing the script.
    //
    // herdr has no "run this argv in a new pane" — a pane always starts a
    // shell — so the boot has to arrive as keystrokes. Typing the script
    // itself put ~2KB of exports on screen: at 100 columns that wraps to about
    // 24 rows, twice (the shell echoes it), which pushed the agent's own first
    // output off a 30-row pane entirely. tmux never shows this because it
    // passes the script as argv.
    //
    // Sourcing a file keeps the typed line to one short command, and sidesteps
    // shell-quoting hazards in the agent command as a side benefit.
    const bootPath = path.join(spec.cliDir, `boot-${spec.sessionName}.sh`)
    // PtyManager creates the runtime dir, but this backend must not depend on
    // the caller having done so — a missing dir would throw here and take the
    // whole terminal down.
    mkdirSync(spec.cliDir, { recursive: true })
    writeFileSync(bootPath, `${bootCommand(spec)}\n`, { mode: 0o700 })
    this.quiet(['pane', 'send-text', pane.pane_id, `clear; exec sh ${bootPath}`])
    this.quiet(['pane', 'send-keys', pane.pane_id, 'enter'])

    // REQUIRED, not decorative: `agent attach` resolves its target through the
    // agent registry and fails with agent_not_found on a pane that merely runs
    // an agent. Reporting is what makes the pane attachable at all.
    //
    // It is also the orchestration seam. herdr runs its own detector on top of
    // this and will correct the state (observed: a reported state overridden
    // ~100ms later by herdr's own reading of a live claude TUI), which is the
    // signal Cookrew currently infers by scraping.
    this.quiet([
      'pane', 'report-agent', pane.pane_id,
      '--source', 'cookrew',
      '--agent', agentKind(spec.command),
      '--state', 'idle'
    ])
  }

  /**
   * Take over the server's idle starter pane, or split a new one.
   *
   * A freshly started herdr server already has one unlabelled shell pane. If
   * Cookrew always split, that pane would sit in every workspace forever as a
   * stray shell that belongs to no terminal node — visible in herdr, owned by
   * nobody, and skipped by the reaper because it has no Cookrew label.
   *
   * Adoption is safe ONLY because this is Cookrew's own isolated server: an
   * unlabelled pane here cannot be a pane the user is working in. Note the
   * adopted pane keeps the SERVER's env rather than this spec's, so the boot
   * command exports what the agent needs instead of relying on the split.
   */
  private adoptOrCreate(spec: AttachSpec): HerdrPane | null {
    const panes = this.panes()
    const idle = panes.find((pane) => !pane.label)
    if (idle) return idle

    // An isolated herdr session starts with NO panes at all, and `pane split`
    // fails with pane_not_found when there is nothing to split. The first
    // terminal therefore creates the workspace that every later pane splits
    // from — which is also the shape the product wants: one herdr workspace
    // holding one pane per Cookrew agent.
    if (panes.length === 0) {
      const created = parseEnvelope(this.herdr(['workspace', 'create', '--cwd', spec.cwd]))
      return (created?.root_pane ?? null) as HerdrPane | null
    }

    const split = parseEnvelope(
      this.herdr(['pane', 'split', '--direction', 'right', '--cwd', spec.cwd, ...envArgs(spec)])
    )
    return (split?.pane ?? null) as HerdrPane | null
  }

  /**
   * `agent attach` and not `session attach`: attach is pane-scoped, so this
   * streams ONE pane with no chrome and no other pane's content.
   */
  attachSpawn(spec: AttachSpec): AttachSpawn {
    const pane = this.paneFor(spec.sessionName)
    if (!pane) throw new Error(`no herdr pane labelled '${spec.sessionName}' — ensureSession first`)
    // --takeover is REQUIRED, not a convenience. Cookrew drops its client by
    // killing the PTY (workspace switch, app quit), which herdr sees as a
    // client that never detached; without takeover the next attach does not
    // get the pane and the terminal comes back blank. Cookrew is the only
    // client of its own herdr session, so there is nobody to steal from.
    return { file: 'herdr', args: ['agent', 'attach', pane.pane_id, '--takeover'] }
  }

  capture(name: string): string | null {
    const pane = this.paneFor(name)
    if (!pane) return null
    try {
      // recent-unwrapped: scrollback with herdr's soft wrapping undone, which
      // is what a scraper wants and what `capture-pane -p` approximates.
      return this.herdr(['pane', 'read', pane.pane_id, '--source', 'recent-unwrapped'])
    } catch {
      return null
    }
  }

  scrollState(name: string): ScrollState {
    return toScrollState(this.paneFor(name))
  }

  /**
   * The pid of the process running INSIDE the pane.
   *
   * `--pane` is a FLAG here, not a positional argument — passing the id
   * positionally makes herdr answer "unknown option" and this returned null for
   * every pane, which would silently break codex rollout binding (it resolves
   * the agent by pane pid via lsof).
   *
   * `shell_pid` is the right field: the boot script `exec`s the agent, so the
   * pane's shell process IS the agent process.
   */
  panePid(name: string): number | null {
    const pane = this.paneFor(name)
    if (!pane) return null
    try {
      const result = parseEnvelope(this.herdr(['pane', 'process-info', '--pane', pane.pane_id]))
      const info = result?.process_info as
        | { shell_pid?: unknown; foreground_processes?: { pid?: unknown }[] }
        | undefined
      const pid = info?.shell_pid ?? info?.foreground_processes?.[0]?.pid
      return typeof pid === 'number' ? pid : null
    } catch {
      return null
    }
  }

  /**
   * herdr does not report a pane's start command or start time, so this is
   * null rather than a guess. Callers use it to bind a pre-existing pane to a
   * session file; with herdr the binding is reported the other way round (via
   * `pane report-agent-session`), so the missing answer costs nothing.
   */
  paneLaunch(): PaneLaunch | null {
    return null
  }

  jumpToText(): void {
    // capabilities.copyModeSearch is false; callers check it.
  }

  exitCopyMode(): void {
    // No copy-mode to leave.
  }

  reloadConfig(): void {
    if (!this.available()) return
    this.quiet(['server', 'reload-config'])
  }
}
