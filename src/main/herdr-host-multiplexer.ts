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
import { promptViaHerdr, waitForAgentState } from './herdr-agent-wait'
import {
  sanitizeAgentEnv,
  type AttachSpawn,
  type AttachSpec,
  type CommandRunner,
  type Multiplexer,
  type MultiplexerCapabilities,
  type PaneCardInfo,
  type PaneLaunch,
  type ScrollState
} from './multiplexer'

/** Cookrew's own herdr session, isolated from the user's — tmux's `-L cookrew`. */
export const HERDR_SESSION = 'cookrew'

/** Bare shells — what a restored husk runs, and what a live agent never is. */
const SHELL_NAMES = /^(sh|bash|zsh|fish|dash|ksh)$/

/** A pane herdr reports in `pane list`. Only the fields Cookrew reads. */
export interface HerdrPane {
  pane_id: string
  label?: string | null
  /** The workspace this pane lives in — herdr always answers it. */
  workspace_id?: string | null
  /** herdr's own view of which agent runs here — set by report-agent. */
  agent?: string | null
  /** herdr's current lifecycle state for this pane, when it has one. */
  agent_status?: string | null
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
  /**
   * How long to let a just-started server restore panes from disk, and a
   * just-restored pane spawn its shell, before acting on their absence.
   * Overridable so tests do not busy-wait the real grace.
   */
  settleMs?: number
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
    // MEASURED: the attach client requests mouse tracking and scrolls the
    // pane 3 lines per SGR wheel notch; Escape returns to live. PtySession
    // uses this to deliver checkpoint jumps without a copy-mode.
    wheelScrollback: true,
    // scroll.max_offset_from_bottom rises with the session (measured).
    monotonicHistory: true,
    // MEASURED: the session outlived its client being killed.
    persistsAcrossRestart: true,
    // herdr tracks agent lifecycle for the panes it hosts, so "has the agent
    // finished?" is asked rather than inferred from output silence.
    agentLifecycle: true
  }

  private readonly runner: CommandRunner
  private readonly session: string
  private readonly configPath: string
  private readonly startServer: () => void
  private readonly waitForServerMs: number
  private readonly settleMs: number
  private probed: boolean | null = null
  private serverUp = false
  /** One immutable pane-list snapshot while a synchronous attach burst runs. */
  private attachSnapshot: HerdrPane[] | null = null

  constructor(options: HerdrHostOptions) {
    // Sanitized: the server is every pane's PARENT, so whatever launched
    // Cookrew leaks straight into every agent through it — measured as the
    // transcript-saving freeze (see sanitizeAgentEnv).
    const env = sanitizeAgentEnv({
      ...process.env,
      HERDR_SESSION: options.session,
      HERDR_CONFIG_PATH: options.configPath
    })
    this.session = options.session
    this.configPath = options.configPath
    this.runner = options.runner ?? createHerdrRunner(env)
    this.startServer = options.startServer ?? (() => spawnHerdrServer(env))
    this.waitForServerMs = options.waitForServerMs ?? 5000
    this.settleMs = options.settleMs ?? 2000
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
        this.waitForRestore()
        return true
      }
    }
    return false
  }

  /**
   * Let a just-started server finish restoring panes before anyone looks.
   *
   * A fresh server answers `pane list` BEFORE it has replayed the session from
   * disk, so the first look can return an empty list — and Cookrew would then
   * create a SECOND pane wearing the label the restored original is about to
   * come back with. Waiting for panes to appear (bounded, because a genuinely
   * new session has none to restore) closes that race. Each probe is a process
   * spawn, so this loop is self-throttling rather than hot.
   */
  private waitForRestore(): void {
    const deadline = Date.now() + this.settleMs
    while (Date.now() < deadline) {
      if (this.panes().length > 0) return
    }
  }

  /**
   * Watch the server and restart it when it dies.
   *
   * tmux never needed this: its server has two decades of hardening and dies
   * only when told to. herdr's shut itself down four times in one day
   * (measured — "server shutdown initiated" with live clients attached and no
   * stop request logged), and every death kills every agent. Cookrew cannot
   * make the server durable, but it can make the OUTAGE short: with the
   * server back up, the husk-recovery path reboots each agent with --resume
   * the moment its terminal respawns, instead of every terminal staying dead
   * until the next full app launch.
   *
   * The timer unrefs so it never holds the app open.
   */
  startSupervisor(intervalMs = 15_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (this.serverRunning()) return
      this.serverUp = false
      try {
        this.ensureServer()
        console.error('herdr server died and was restarted by the supervisor')
      } catch (error) {
        console.error('herdr server died and could not be restarted:', error)
      }
    }, intervalMs)
    timer.unref?.()
    return timer
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

  /** Read every Cookrew pane from herdr, bypassing an attach-burst snapshot. */
  private readPanes(): HerdrPane[] {
    if (!this.available()) return []
    try {
      return parsePaneList(this.herdr(['pane', 'list']))
    } catch {
      // No server running is the ordinary "no sessions" case, not an error.
      return []
    }
  }

  /** Every Cookrew pane, stable across a synchronous workspace attach burst. */
  private panes(): HerdrPane[] {
    return this.attachSnapshot ?? this.readPanes()
  }

  /**
   * Share one global pane snapshot across a serial workspace reattach.
   * Herdr already returns every pane in one response; this avoids forking a
   * CLI to ask the same global question at each per-terminal lookup.
   */
  beginAttachBatch(): void {
    if (this.attachSnapshot) return
    if (!this.available() || !this.ensureServer()) return
    this.attachSnapshot = this.readPanes()
  }

  endAttachBatch(): void {
    this.attachSnapshot = null
  }

  /** Make a pane created during a batch visible to later attach steps. */
  private rememberPane(pane: HerdrPane): void {
    if (!this.attachSnapshot) return
    const index = this.attachSnapshot.findIndex((candidate) => candidate.pane_id === pane.pane_id)
    if (index === -1) this.attachSnapshot.push(pane)
    else this.attachSnapshot[index] = pane
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
   * Create the pane and start the agent — unless the pane already exists AND
   * is genuinely running one, in which case do NOTHING and let the attach
   * reattach the live agent. That early return is the persistence guarantee.
   *
   * "A pane with this label exists" is NOT that condition, though it was the
   * original check. herdr persists pane LAYOUT, not processes: when the herdr
   * server dies (reboot, crash, `herdr update`), every agent dies with it, and
   * the next server restores the pane as a fresh shell wearing the old label —
   * a HUSK. Early-returning on a husk reattached Cookrew to an empty prompt
   * while reporting the agent recovered. Under tmux the two conditions were
   * the same condition, which is exactly why the port got it wrong.
   */
  ensureSession(spec: AttachSpec): void {
    if (!this.available()) return
    if (!this.ensureServer()) throw new Error('herdr server did not come up on Cookrew\'s socket')

    const existing = this.paneFor(spec.sessionName)
    if (existing && !this.isHusk(existing, spec)) {
      // The pane is healthy — but attachability is NOT durable, and that is a
      // separate failure from the husk.
      //
      // herdr restores panes from disk across a server restart WITHOUT their
      // agent registration, while the agent process keeps running. `agent
      // attach` resolves its target through that registry, so such a pane is
      // permanently unattachable: agent_not_found, terminal never opens,
      // transcript never renders. Measured on a live session — 5 of 17 panes
      // had a running agent and no registration.
      //
      // Re-reporting is idempotent and costs one call, so it happens on every
      // attach rather than only when the pane is created. The card binding
      // re-reports for the same reason: herdr persists pane LAYOUT, not the
      // metadata a source reported.
      this.reportAgent(existing, spec)
      if (spec.card) this.reportPaneCardTo(existing, spec.card)
      return
    }

    const pane = existing ?? this.adoptOrCreate(spec)
    if (!pane?.pane_id) throw new Error(`herdr could not create a pane for '${spec.sessionName}'`)

    // Label FIRST: if the boot command fails, the pane is still findable and
    // killable by name rather than leaking as an unlabelled orphan.
    this.quiet(['pane', 'rename', pane.pane_id, spec.sessionName])
    const namedPane = { ...pane, label: spec.sessionName }
    this.rememberPane(namedPane)

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
    this.bootIntoPane(pane.pane_id, spec)

    // REQUIRED, not decorative: `agent attach` resolves its target through the
    // agent registry and fails with agent_not_found on a pane that merely runs
    // an agent. Reporting is what makes the pane attachable at all.
    //
    // It is also the orchestration seam. herdr runs its own detector on top of
    // this and will correct the state (observed: a reported state overridden
    // ~100ms later by herdr's own reading of a live claude TUI), which is the
    // signal Cookrew currently infers by scraping.
    this.reportAgent(namedPane, spec)

    // The card binding lands once the pane is labelled and booted: herdr's
    // chrome then shows Cookrew's card name and role instead of a raw shell.
    if (spec.card) this.reportPaneCardTo(namedPane, spec.card)
  }

  /**
   * The Cookrew card behind this pane, in herdr's own chrome: the pane
   * title is the card's name, the display-agent its role (or harness), and
   * the workspace/cwd ride as metadata tokens. Display-only — Cookrew's
   * control flow never reads any of it back.
   */
  reportPaneCard(name: string, card: PaneCardInfo): void {
    const pane = this.paneFor(name)
    if (!pane) return
    this.reportPaneCardTo(pane, card)
  }

  /** reportPaneCard with the pane already resolved (ensureSession's path). */
  private reportPaneCardTo(pane: HerdrPane, card: PaneCardInfo): void {
    this.quiet([
      'pane', 'report-metadata', pane.pane_id, '--source', 'cookrew',
      ...(card.title.length > 0 ? ['--title', card.title] : []),
      '--display-agent', card.agent,
      '--token', `cookrew_terminal=${card.terminalId}`,
      '--token', `cookrew_workspace=${card.workspace}`,
      '--token', `cookrew_cwd=${card.cwd}`
    ])
  }

  /**
   * The workspace half of the binding: Cookrew's one herdr workspace wears
   * the ACTIVE Cookrew workspace's name, with tokens carrying its identity.
   * Panes from every Cookrew workspace share the one herdr workspace, so
   * the label tracks which one is live — each pane keeps its OWN workspace
   * as a token (see reportPaneCard), which is where the precise binding
   * lives.
   */
  reportWorkspace(info: { label: string; tokens: Record<string, string> }): void {
    if (!this.available() || !this.serverRunning()) return
    // The workspace id comes off any pane: Cookrew's panes all live in the
    // one workspace adoptOrCreate made, and herdr reports it on each.
    const wsId = this.panes().find((pane) => pane.workspace_id)?.workspace_id
    if (!wsId) return
    try {
      const list = parseEnvelope(this.herdr(['workspace', 'list']))
      const workspaces = (list?.workspaces ?? []) as { workspace_id?: string; label?: string }[]
      const current = workspaces.find((w) => w.workspace_id === wsId)
      if (current && current.label !== info.label && info.label.length > 0) {
        this.quiet(['workspace', 'rename', wsId, info.label])
      }
      const tokens = Object.entries(info.tokens).flatMap(([key, value]) => [
        '--token',
        `${key}=${value}`
      ])
      if (tokens.length > 0) {
        this.quiet(['workspace', 'report-metadata', wsId, '--source', 'cookrew', ...tokens])
      }
    } catch {
      // Best effort by contract — the binding is chrome, never control flow.
    }
  }

  /**
   * Register the agent so `agent attach` can resolve this pane.
   *
   * The state reported is the one herdr ALREADY holds, not a fixed 'idle'.
   * Asserting idle over a working agent would be a lie for as long as it takes
   * herdr's own detector to correct it — and Cookrew now feeds that state
   * straight into turn-tracker, where a spurious idle ends the turn early and
   * mints a checkpoint from a half-written reply. `unknown` is the honest
   * fallback: the status feed maps it to "no signal" and keeps inferring.
   */
  private reportAgent(pane: HerdrPane, spec: AttachSpec): void {
    const known = pane.agent_status
    const state =
      known === 'idle' || known === 'working' || known === 'blocked' ? known : 'unknown'
    const kind = pane.agent && pane.agent.length > 0 ? pane.agent : agentKind(spec.command)
    this.quiet([
      'pane', 'report-agent', pane.pane_id,
      '--source', 'cookrew',
      // Prefer what herdr already recorded: a pane whose registration is being
      // restored keeps the agent it actually runs, even if the node's command
      // has since been edited.
      '--agent', kind,
      '--state', state
    ])
    // Release lifecycle authority IMMEDIATELY. Reporting with a source CLAIMS
    // it, and herdr's detector then stands down waiting for updates this
    // source will never send — measured: every pane stuck at 'unknown' seq 0,
    // `agent prompt --wait` stalling by definition, and one release-agent
    // flipping the pane to detector-tracked 'idle' seq 1.
    this.releaseKeepingRegistration(pane.pane_id, kind, state)
  }

  /**
   * Release authority WITHOUT losing the registration.
   *
   * "The registry entry survives the release" turned out to be true only for
   * kinds herdr's detector recognizes (claude, codex, pi, ...) — the detector
   * re-registers them the moment authority is free. A kind with NO detector
   * ('shell', any unrecognized binary) has nobody to re-register it, so the
   * release ERASES it: `agent attach` resolves nothing, the attach client
   * exits instantly, and the card renders blank — measured on every shell
   * terminal after a server restart.
   *
   * The rule is empirical rather than a hardcoded kind list: release, look,
   * and if the registration vanished, re-report and KEEP authority. For a
   * detectorless kind an un-released source costs nothing — there is no
   * detector being muzzled, and the reported state is as true as any.
   */
  private releaseKeepingRegistration(paneId: string, kind: string, state: string): void {
    this.quiet(['pane', 'release-agent', paneId, '--source', 'cookrew', '--agent', kind])
    if (this.agentResolvable(paneId)) return
    this.quiet([
      'pane', 'report-agent', paneId,
      '--source', 'cookrew',
      '--agent', kind,
      '--state', state
    ])
  }

  /**
   * A HUSK: the pane's label survived the herdr server dying, its agent did
   * not. herdr restores the pane from disk as a fresh shell — measured:
   *
   *   before server restart   label=cookrew_x  agent process pid ALIVE
   *   after  server restart   label=cookrew_x  same label, bare zsh prompt
   *
   * The verdict deliberately IGNORES `agent_status`. A restored pane initially
   * carries its PERSISTED status (e.g. 'idle') and only decays to 'unknown'
   * once herdr's detector finds nothing — so at the moment Cookrew checks, a
   * husk still claims to be a live agent. That field lying at exactly the
   * wrong instant is what sank the first attempt at this fix.
   *
   * What cannot lie is the pane's FOREGROUND PROCESS. The boot script `exec`s
   * the agent, so a live agent pane's foreground is the agent binary; when
   * that process dies with the server, the restored pane's foreground is a
   * bare login shell. Three verdicts, ordered by what they risk:
   *
   *   - process-info unanswerable  -> NOT a husk. Booting is TYPED into the
   *     pane, so misreading a live agent would paste a shell command into its
   *     prompt — worse than failing to recover. No answer, no action.
   *   - foreground is a bare shell, but an AGENT was expected -> husk.
   *   - foreground absent (shell still spawning after restore) -> husk; the
   *     boot path waits for the shell before typing.
   *
   * A terminal whose command IS a shell can't be told apart from its husk —
   * both show a shell — so it is never rebooted. It loses only env vars on
   * server death, not an agent, and wiping a live shell to fix that is the
   * wrong trade.
   */
  private isHusk(pane: HerdrPane, spec: AttachSpec): boolean {
    const expected = agentKind(spec.command)
    if (SHELL_NAMES.test(expected) || expected === 'shell') return false

    // Poll rather than peek: immediately after a server restart, process-info
    // ERRORS transiently, then reports the restored shell's RC INIT — child
    // processes like `git` from a prompt framework. A peek that treated
    // "not a shell" as "must be the agent" mistook that `git` for a live
    // agent and silently skipped recovery (measured; it flipped run to run
    // with rc timing). Only three readings end the poll, and two of them are
    // POSITIVE identifications rather than absences:
    //
    //   agent visible  -> live, leave it alone
    //   bare shell     -> husk. On an agent pane, a shell in the foreground
    //                     means the agent is not there — an rc-init flicker
    //                     only ever happens on a freshly restored shell,
    //                     which is a husk by definition
    //   window expires -> refuse to act; booting types into the pane, and
    //                     "I could not tell" is not a license to type
    const deadline = Date.now() + this.settleMs
    for (;;) {
      const seen = this.paneRuns(pane.pane_id, expected, spec.sessionName)
      if (seen === 'agent') return false
      if (seen === 'shell') return true
      // A registered DIFFERENT agent plus a non-shell root is the durable
      // command-edit/migration shape: exact reattach means preserving that live
      // process, never waiting for it to turn into the node's newer command.
      // The old per-pane settle loop compounded this known mismatch to 16.4s
      // for eight terminals. Keep polling an unregistered `other`, though: a
      // restored shell can be doing transient rc work and may still settle into
      // the positive bare-shell verdict that licenses recovery.
      if (seen === 'other' && pane.agent && pane.agent !== expected) return false
      if (Date.now() >= deadline) return false
    }
  }

  /**
   * What the pane is running, judged by its ROOT process — never by the
   * foreground group.
   *
   * The foreground group was the first design and it typed a boot command
   * into a LIVE claude (2026-08-09, twice): job control moves the foreground
   * to whatever a TUI agent's current tool is running, so a claude mid
   * Bash-tool presents a bare `sh` with no claude in the group at all —
   * indistinguishable from a husk by that witness.
   *
   * The root cannot be fooled that way. The boot script `exec`s the agent, so
   * a live pane's root IS the agent process for the pane's whole life,
   * whatever its tools are doing. Verified live: the pane whose foreground
   * read as `sh` had root argv `claude --permission-mode ... --resume ...`.
   *
   * herdr reports the root pid (`shell_pid`); its argv comes from ps. The
   * classifications, and what each licenses:
   *
   *   'agent'   — expected token in the root argv. Live; never touch.
   *   'booting' — the root is running this session's boot script. In flight;
   *               wait, never type.
   *   'shell'   — the root is a bare shell where an agent was expected: a
   *               husk, or typed keys that were dropped. The only state that
   *               licenses typing.
   *   'other'   — something unrecognized; wait.
   */
  private paneRuns(
    paneId: string,
    expected: string,
    sessionName: string
  ): 'agent' | 'booting' | 'shell' | 'other' | 'unanswerable' {
    try {
      const result = parseEnvelope(this.herdr(['pane', 'process-info', '--pane', paneId]))
      if (!result) return 'unanswerable'
      const info = result.process_info as { shell_pid?: unknown } | undefined
      const pid = info?.shell_pid
      if (typeof pid !== 'number') return 'unanswerable'
      const argv = this.runner.run('ps', ['-o', 'args=', '-p', String(pid)]).trim()
      if (argv.length === 0) return 'unanswerable'
      if (argv.includes(expected)) return 'agent'
      if (argv.includes(`boot-${sessionName}.sh`)) return 'booting'
      const head = (argv.split(/\s+/)[0] ?? '').split('/').pop()?.replace(/^-/, '') ?? ''
      if (SHELL_NAMES.test(head) && argv.split(/\s+/).length === 1) return 'shell'
      return 'other'
    } catch {
      return 'unanswerable'
    }
  }

  /**
   * The pane's foreground process name; `ok: false` when herdr could not
   * answer, `name: null` when it answered "nothing yet". Callers act on the
   * difference — see isHusk.
   */
  private foreground(paneId: string): { ok: boolean; name: string | null } {
    try {
      const result = parseEnvelope(this.herdr(['pane', 'process-info', '--pane', paneId]))
      if (!result) return { ok: false, name: null }
      const info = result.process_info as
        | { foreground_processes?: { name?: unknown; argv0?: unknown }[] }
        | undefined
      const front = info?.foreground_processes?.[0]
      if (!front) return { ok: true, name: null }
      // argv0 over name: login shells report argv0 '-zsh' but name may be the
      // underlying binary ('bash' on macOS zsh panes, observed live).
      const raw = String(front.argv0 ?? front.name ?? '').replace(/^-/, '')
      return { ok: true, name: raw.length > 0 ? raw : null }
    } catch {
      return { ok: false, name: null }
    }
  }

  /**
   * Block until the pane can receive keystrokes (its shell exists). Bounded:
   * a pane that never reports a foreground process gets typed at anyway after
   * the grace, which at worst repeats the original symptom instead of adding
   * a new failure mode.
   */
  private waitForShell(paneId: string): void {
    const deadline = Date.now() + this.settleMs
    while (Date.now() < deadline) {
      const probe = this.foreground(paneId)
      if (probe.ok && probe.name !== null) return
    }
  }

  /**
   * Type the boot command and VERIFY it took — retyping until it does.
   *
   * herdr has no "run this argv in a pane": booting arrives as keystrokes, and
   * keystrokes into a freshly created or freshly restored pane are sometimes
   * dropped even after a foreground process is visible (measured: identical
   * runs flip between booted and a bare prompt). One-shot typing therefore
   * cannot be trusted; nothing about it reports failure.
   *
   * The boot `exec`s the agent, which IS the verification signal: success
   * means the pane's foreground stops being a shell. Verified boots make both
   * first creation and husk recovery deterministic instead of timing-lucky.
   *
   * A terminal whose command is itself a shell has no such signal — its
   * foreground is a shell before and after — so it is typed once, unverified,
   * exactly as before. Retyping into it could stack boot commands in the NEW
   * shell, which is worse than the flake being guarded against.
   */
  private bootIntoPane(paneId: string, spec: AttachSpec): void {
    const bootPath = path.join(spec.cliDir, `boot-${spec.sessionName}.sh`)
    // PtyManager creates the runtime dir, but this backend must not depend on
    // the caller having done so — a missing dir would throw here and take the
    // whole terminal down.
    mkdirSync(spec.cliDir, { recursive: true })
    writeFileSync(bootPath, `${bootCommand(spec)}\n`, { mode: 0o700 })

    // ctrl+u FIRST, every time. rc-init keystrokes are not reliably dropped —
    // they can be BUFFERED and flush after init (measured 2026-08-09: a retype
    // stacked a second boot line into the input of the claude the FIRST line
    // had just booted). The kill-line clears whatever is pending, in order,
    // before this line arrives — so a retype can never stack, whichever of
    // buffered or dropped the previous attempt turned out to be.
    const type = (): void => {
      this.waitForShell(paneId)
      this.quiet(['pane', 'send-keys', paneId, 'ctrl+u'])
      this.quiet(['pane', 'send-text', paneId, `clear; exec sh ${bootPath}`])
      this.quiet(['pane', 'send-keys', paneId, 'enter'])
    }

    const expected = agentKind(spec.command)
    if (SHELL_NAMES.test(expected) || expected === 'shell') {
      type()
      return
    }

    // Retype discipline, shaped by two live failures pulling opposite ways:
    // a single type is not trusted (rc init can eat it), but retyping typed
    // junk into a live agent TWICE — once because the verifier watched the
    // foreground group, once because "dropped" keys were actually buffered.
    // So: retype ONLY while the ROOT process is still a bare shell (positive
    // evidence the boot has not begun), a full beat apart, with ctrl+u making
    // each attempt self-cleaning.
    const deadline = Date.now() + this.settleMs * 6
    type()
    let lastTypedAt = Date.now()
    for (;;) {
      const seen = this.paneRuns(paneId, expected, spec.sessionName)
      if (seen === 'agent') return
      if (seen === 'shell' && Date.now() - lastTypedAt >= this.settleMs) {
        type()
        lastTypedAt = Date.now()
      }
      if (Date.now() >= deadline) return
    }
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

    // The attach must not be able to exit INSTANTLY. `agent attach` resolves
    // its target through herdr's agent registry, and an unresolvable target
    // makes the client print agent_not_found and exit within milliseconds —
    // which is not merely a blank card: node-pty's exit callback has a known
    // native crash window for near-instant exits (Napi::Error in the
    // ThreadSafeFunction -> libc++ abort, the 2026-08-08 launch crash). The
    // registry entry is runtime state that outages can drop while the pane
    // lives on, so it is verified — and repaired — before argv is handed out.
    this.ensureAgentResolvable(pane.pane_id, spec)

    // --takeover is REQUIRED, not a convenience. Cookrew drops its client by
    // killing the PTY (workspace switch, app quit), which herdr sees as a
    // client that never detached; without takeover the next attach does not
    // get the pane and the terminal comes back blank. Cookrew is the only
    // client of its own herdr session, so there is nobody to steal from.
    return {
      file: 'herdr',
      args: ['agent', 'attach', pane.pane_id, '--takeover'],
      // Without this the attach resolves the DEFAULT socket and dies with
      // server_not_running while the pane sits healthy on Cookrew's server —
      // the e2e probe masked it by injecting the session env by hand, which
      // is why it only surfaced in the running app.
      env: { HERDR_SESSION: this.session, HERDR_CONFIG_PATH: this.configPath }
    }
  }

  /**
   * Make `agent attach <pane>` resolvable, re-reporting the agent when the
   * registry entry is missing. Idempotent and cheap when already resolvable
   * (one `agent get`). Best effort beyond that: if herdr still cannot resolve
   * after a repair, the attach will fail visibly — but that is the rare tail,
   * not the common case this closes.
   */
  private ensureAgentResolvable(paneId: string, spec: AttachSpec): void {
    if (this.agentResolvable(paneId)) return
    this.quiet([
      'pane', 'report-agent', paneId,
      '--source', 'cookrew',
      '--agent', agentKind(spec.command),
      '--state', 'idle'
    ])
    // Same discipline as reportAgent: un-muzzle the detector where one
    // exists, but never at the cost of the registration itself.
    this.releaseKeepingRegistration(paneId, agentKind(spec.command), 'idle')
    // Registration propagates asynchronously; give it a bounded moment so the
    // attach spawned right after this does not race it.
    const deadline = Date.now() + Math.min(this.settleMs, 1000)
    while (Date.now() < deadline) {
      if (this.agentResolvable(paneId)) return
    }
  }

  /** Does herdr's agent registry resolve this pane right now? */
  private agentResolvable(paneId: string): boolean {
    try {
      return parseEnvelope(this.herdr(['agent', 'get', paneId])) !== null
    } catch {
      return false
    }
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

  /** The same read, reaching `lines` rows back instead of herdr's default. */
  captureDeep(name: string, lines: number): string | null {
    const pane = this.paneFor(name)
    if (!pane) return null
    try {
      return this.herdr([
        'pane', 'read', pane.pane_id,
        '--source', 'recent-unwrapped',
        '--lines', String(Math.max(1, lines))
      ])
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

  /**
   * Ask herdr when the agent stopped working, instead of inferring it.
   *
   * Async, and deliberately NOT routed through this class's synchronous runner:
   * the wait lasts as long as the agent takes, and execFileSync would freeze
   * the main process for exactly that long.
   */
  /**
   * Report the agent's transcript path to herdr.
   *
   * The `--agent` label is REQUIRED by the CLI, and it is read back off the
   * pane rather than threaded down from the caller: herdr already stores what
   * `report-agent` declared, so the value survives an app restart where the
   * pane exists but Cookrew never re-ran ensureSession for it.
   */
  reportAgentSession(name: string, sessionPath: string): void {
    const pane = this.paneFor(name)
    if (!pane) return
    this.quiet([
      'pane', 'report-agent-session', pane.pane_id,
      '--source', 'cookrew',
      '--agent', pane.agent && pane.agent.length > 0 ? pane.agent : 'shell',
      '--agent-session-path', sessionPath
    ])
  }

  /**
   * Agent-to-agent ask, natively: herdr submits the prompt (its own paste and
   * submit handling) and blocks until the agent leaves 'working'. Replaces
   * the typed bracketed-paste + guessed-quiescence path for herdr panes.
   *
   * The registry check first: `agent prompt` fails on an unresolvable target,
   * and repairing registration is this backend's job, not the caller's.
   */
  async promptAgent(
    name: string,
    prompt: string,
    timeoutMs: number
  ): Promise<'done' | 'submitted' | 'failed'> {
    const pane = this.paneFor(name)
    if (!pane) return 'failed'
    if (!this.agentResolvable(pane.pane_id)) return 'failed'
    return promptViaHerdr({
      session: this.session,
      configPath: this.configPath,
      target: pane.pane_id,
      timeoutMs,
      prompt
    })
  }

  async waitUntilIdle(name: string, timeoutMs: number): Promise<boolean> {
    const pane = this.paneFor(name)
    if (!pane) return false
    return waitForAgentState({
      session: this.session,
      configPath: this.configPath,
      target: pane.pane_id,
      timeoutMs
    })
  }
}
