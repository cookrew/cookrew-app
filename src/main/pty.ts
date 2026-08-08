import { EventEmitter } from 'node:events'
import path from 'node:path'
import { mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import pty, { IPty } from 'node-pty'
import xtermHeadless from '@xterm/headless'
import type { Multiplexer } from './multiplexer'
import { TmuxMultiplexer, sessionNameFor as tmuxSessionNameFor, TMUX_LABEL as TMUX_LABEL_CONST } from './tmux-multiplexer'
import { HerdrHostMultiplexer, HERDR_SESSION } from './herdr-host-multiplexer'
import { HerdrStatusFeed, setStatusFeed, statusFeed } from './herdr-agent-status'
import { DirectMultiplexer } from './direct-multiplexer'
import { selectMultiplexers } from './multiplexer-select'
import type { Terminal as HeadlessTerminalType } from '@xterm/headless'

const { Terminal: HeadlessTerminal } = xtermHeadless as unknown as {
  Terminal: typeof HeadlessTerminalType
}

/**
 * Cookrew runs every terminal inside its own tmux server (socket label "cookrew",
 * isolated from the user's tmux). A tmux session per terminal means the
 * process survives Cookrew restarts and workspace switches: reopening does
 * `new-session -A` which reattaches the live session with its scrollback and
 * running agent intact. Only an explicit close (⌘W / dismiss) kills it.
 */
// Re-exported so existing importers keep their path; the tmux specifics now
// live in tmux-multiplexer.ts behind the Multiplexer interface.
export const TMUX_LABEL = TMUX_LABEL_CONST

/** Stable per-user dir; the socket pointer lives here for the PATH-installed CLI. */
const COOKREW_HOME = path.join(homedir(), '.cookrew')

/**
 * The process-wide multiplexer. Set once by PtyManager (which owns the config
 * file the backend needs); module-level helpers below use it so the session
 * reaper keeps working without threading an instance through every call.
 */
let activeMux: Multiplexer | null = null

export function setMultiplexer(mux: Multiplexer): void {
  activeMux = mux
}

/** The active backend, or null before PtyManager has constructed one. */
export function multiplexer(): Multiplexer | null {
  return activeMux
}

/** True while a session with this name still exists. */
function tmuxSessionExists(name: string): boolean {
  return activeMux?.sessionExists(name) ?? false
}

/** tmux session name for a terminal id (names can't contain '.' or ':'). */
export function sessionNameFor(terminalId: string): string {
  return tmuxSessionNameFor(terminalId)
}

/** Our tmux session naming, so the reaper never touches foreign sessions. */
const COOKREW_SESSION_RE = /^cookrew_[A-Za-z0-9]+$/

/**
 * tmux session names that belong to NO terminal node — leaked agents from a
 * crash or (until now) a workspace delete that never killed its terminals.
 * Pure: only sessions matching our naming AND not owned by a live node are
 * returned, so a foreign tmux session on the same server is never reaped.
 */
export function orphanSessionNames(
  tmuxNames: string[],
  ownedTerminalIds: Iterable<string>
): string[] {
  const owned = new Set<string>()
  for (const id of ownedTerminalIds) owned.add(sessionNameFor(id))
  return tmuxNames.filter((name) => COOKREW_SESSION_RE.test(name) && !owned.has(name))
}

/**
 * Poll until a tmux session is gone; THROW when it survives the deadline
 * (H5). Extracted from PtyManager.killAndWait with an injectable liveness
 * check so the timeout path is unit-testable without a real tmux server.
 */
export async function waitForTmuxDeath(
  name: string,
  timeoutMs: number,
  exists: (name: string) => boolean = tmuxSessionExists
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!exists(name)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!exists(name)) return // one last look at the deadline boundary
  throw new Error(`tmux session '${name}' survived the ${timeoutMs}ms kill deadline`)
}

/** Kill a cookrew tmux session by NAME (best effort) — no live PTY needed. */
function killTmuxSessionByName(name: string): void {
  activeMux?.killSession(name)
}

/** Live cookrew tmux session names, or [] when no server / tmux is absent. */
function listTmuxSessionNames(): string[] {
  return activeMux?.listSessions() ?? []
}

export interface PtySessionOptions {
  terminalId: string
  command: string
  cwd: string
  cols?: number
  rows?: number
  socketPath: string
  cliDir: string
  /** Path to the cookrew tmux config; when set (and tmux exists), sessions run in tmux. */
  tmuxConf?: string
}

/**
 * One PTY per terminal node. A headless xterm mirrors the screen so the
 * main process can answer `cookrew check` (current viewport text) and detect
 * quiescence for `cookrew ask` without involving the renderer.
 */
export class PtySession extends EventEmitter {
  readonly terminalId: string
  private proc: IPty
  private screen: HeadlessTerminalType
  private lastOutputAt = 0
  private disposed = false

  readonly usesTmux: boolean
  /**
   * The multiplexer session this terminal lives in. Public because callers
   * that ask the backend about this terminal — `cookrew ask` waiting for the
   * agent to go idle — need to name it.
   */
  readonly sessionName: string

  constructor(options: PtySessionOptions) {
    super()
    this.terminalId = options.terminalId
    const shell = process.env.SHELL ?? '/bin/zsh'
    const cols = options.cols ?? 100
    const rows = options.rows ?? 30
    // Now a CAPABILITY question, not an identity one: "does my session
    // outlive the app?" rather than "am I tmux?". The direct backend answers
    // false and everything downstream degrades on that fact.
    this.usesTmux = activeMux?.capabilities.persistsAcrossRestart ?? false
    this.sessionName = sessionNameFor(options.terminalId)

    this.screen = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true })

    const env = {
      ...process.env,
      TERM_PROGRAM: 'Cookrew',
      COOKREW_TERMINAL_ID: options.terminalId,
      COOKREW_SOCKET: options.socketPath,
      COOKREW_CLI: path.join(options.cliDir, 'cookrew'),
      PATH: `${options.cliDir}:${process.env.PATH ?? ''}`
    }

    // One path for every backend. The direct backend returns a plain login
    // shell here, which is exactly what the old `else` branch spawned by hand.
    const attachSpec = {
      sessionName: this.sessionName,
      command: options.command,
      shell,
      terminalId: options.terminalId,
      socketPath: options.socketPath,
      cliDir: options.cliDir,
      path: `${options.cliDir}:${process.env.PATH ?? ''}`,
      cwd: options.cwd
    }
    // Idempotent, and a no-op for tmux (whose `new-session -A` does it inside
    // the attach). Backends that cannot create-and-attach in one step — herdr,
    // where the server owns the pane — need the pane to exist first.
    activeMux!.ensureSession(attachSpec)
    const spawnSpec = activeMux!.attachSpawn(attachSpec)
    this.proc = pty.spawn(spawnSpec.file, spawnSpec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      // The backend's own env last: it knows which server the attach must
      // talk to (herdr's HERDR_SESSION), and nothing else does.
      env: { ...env, ...spawnSpec.env }
    })

    // A JS exception escaping these callbacks crosses back into node-pty's
    // NAPI thread-safe function, becomes a C++ exception and ABORTS the whole
    // app (SIGABRT) — nothing here may throw. Late chunks routinely arrive
    // after dispose() (node-pty drains its queue), when the headless screen
    // is already disposed and would throw on write.
    this.proc.onData((data) => {
      if (this.disposed) return
      try {
        this.lastOutputAt = Date.now()
        this.screen.write(data)
        this.emit('data', data)
      } catch (error) {
        console.error('PTY data handling failed:', error)
      }
    })
    this.proc.onExit(({ exitCode }) => {
      try {
        this.emit('exit', exitCode)
      } catch (error) {
        console.error('PTY exit handling failed:', error)
      }
    })
  }

  write(data: string): void {
    this.proc.write(data)
    // Every input path (renderer keystrokes, `cookrew ask`, routines) funnels
    // through here, so turn tracking can observe prompts uniformly.
    this.emit('input', data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(cols, rows)
      this.screen.resize(cols, rows)
    } catch (error) {
      console.error('PTY resize failed:', error)
    }
  }

  /** Current screen width in columns (viewportText lines never exceed it). */
  get cols(): number {
    return this.screen.cols
  }

  /** Current screen height in rows. */
  get rows(): number {
    return this.screen.rows
  }

  /** Milliseconds since the process last produced output. */
  idleFor(): number {
    return this.lastOutputAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastOutputAt
  }

  /** Plain-text rendering of the current viewport (what `cookrew check` returns). */
  viewportText(): string {
    if (this.disposed) return ''
    const buffer = this.screen.buffer.active
    const lines: string[] = []
    const start = Math.max(0, buffer.length - this.screen.rows)
    for (let i = start; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    return lines.join('\n').replace(/\n+$/g, '')
  }

  /** Full scrollback + viewport text, used to diff before/after an `ask`. */
  fullText(): string {
    if (this.disposed) return ''
    const buffer = this.screen.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    return lines.join('\n').replace(/\n+$/g, '')
  }

  /**
   * Drop the PTY (the tmux client) without ending the tmux session — the
   * session detaches and keeps running for the next attach. Used on workspace
   * switch and app quit so terminals persist.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.proc.kill()
    } catch (error) {
      console.error('PTY kill failed:', error)
    }
    this.screen.dispose()
  }

  /**
   * True when dispose() (detach) initiated the client exit — a workspace
   * switch or app quit, NOT the agent dying. Exit listeners use this to
   * ignore detaches (e.g. the agent registry only deactivates real exits).
   */
  get wasDisposed(): boolean {
    return this.disposed
  }

  /** Terminate the tmux session for good (explicit close: ⌘W / dismiss). */
  killSession(): void {
    if (!this.usesTmux) return
    activeMux?.killSession(this.sessionName)
  }

  /**
   * Scroll the pane's view to the most recent occurrence of `text` (tmux
   * copy-mode literal search). Always restarts from the live tail so
   * successive jumps land deterministically regardless of the current
   * scroll position. Best-effort no-op without tmux.
   */
  jumpToText(text: string): void {
    if (!this.usesTmux || this.disposed) return
    activeMux?.jumpToText(this.sessionName, text)
  }

  /** Leave copy-mode and return the pane to the live tail. */
  exitCopyMode(): void {
    if (!this.usesTmux || this.disposed) return
    activeMux?.exitCopyMode(this.sessionName)
  }

  /**
   * Pane scroll state in ONE tmux round-trip (checkpoint-ux item 2):
   * - scrollRow: tmux scroll_position — lines scrolled UP from the live
   *   bottom while in copy-mode (0 = pinned to bottom but browsing); null
   *   when the pane is live or tmux is unavailable.
   * - historySize: tmux history_size — lines scrolled into scrollback since
   *   the tmux session started. Rises with the session (survives our
   *   reattaches) and so orders checkpoints reliably, UNLIKE the in-pane
   *   screen buffer: TUIs repaint in place, so screen-derived counts saturate
   *   at pane rows (the Magpie E2 degenerate-scrollLine bug). It is not
   *   unbounded, though — history_size caps at the 50k history-limit, past
   *   which the oldest lines trim and pre-window anchors go stale (clamp).
   */
  paneScrollState(): { scrollRow: number | null; historySize: number | null } {
    if (!this.usesTmux || this.disposed) return { scrollRow: null, historySize: null }
    return activeMux?.scrollState(this.sessionName) ?? { scrollRow: null, historySize: null }
  }

  /** Live scroll position only (see paneScrollState). */
  scrollRow(): number | null {
    return this.paneScrollState().scrollRow
  }

  /** Checkpoint anchor: history_size now — rises with the session, caps at the
   *  50k history-limit (null without tmux). */
  scrollAnchor(): number | null {
    return this.paneScrollState().historySize
  }

}

// Terminals are visibly tmux: the status bar is ON so window/pane management
// and the prefix key are discoverable. The status bar is deliberately STATIC
// (no clock, status-interval 0) — a per-second clock would keep the PTY
// emitting and break `cookrew ask`'s output-quiescence detection.
const TMUX_CONF = [
  'set -g status on',
  'set -g status-interval 0',
  'set -g status-justify left',
  "set -g status-left '#[bold] cookrew · #S #[nobold] '",
  "set -g status-right ''",
  'set -g status-style "bg=#2d2a20,fg=#e9b949"',
  'set -g window-status-current-style "bg=#ffd600,fg=#2d2a20,bold"',
  'set -g window-status-style "fg=#a8a29e"',
  'set -g mouse on',
  // Mouse-drag copies must land on the system clipboard, not just tmux's
  // buffer: emit OSC 52 to the attached client (xterm's clipboard addon
  // applies it). The Ms override declares the capability for xterm-256color.
  'set -g set-clipboard on',
  "set -ga terminal-overrides ',xterm-256color:Ms=\\E]52;%p1%s;%p2%s\\007'",
  'set -g history-limit 50000',
  'set -sg escape-time 0',
  'set -g base-index 1',
  'set -g destroy-unattached off',
  'set -g default-terminal "xterm-256color"'
].join('\n')

/**
 * Cookrew's herdr config — and it is not cosmetic.
 *
 * herdr's chrome (sidebar, tab bar, pane borders, scrollbars) is what made an
 * earlier attach measure 97KB of TUI and get written off as unhostable. With
 * the chrome off, `agent attach` streams the pane and nothing else: measured at
 * 27ms echo, 0 bytes over 3s idle, no chrome words in the stream.
 *
 * `host_cursor = "native"` matters too — Cookrew renders into xterm.js, which
 * draws its own cursor from the escape stream, so herdr must not paint a
 * second one as cell content.
 */
const HERDR_CONF = [
  '# Generated by Cookrew. Chrome is off so `agent attach` is a transparent',
  '# pane stream rather than a terminal UI.',
  'onboarding = false',
  '',
  '[ui]',
  'sidebar_start_collapsed = true',
  'sidebar_collapsed_mode = "hidden"',
  'hide_tab_bar_when_single_tab = true',
  'pane_borders = false',
  'pane_scrollbars = false',
  'pane_gaps = false',
  'host_cursor = "native"',
  'confirm_close = false',
  'prompt_new_tab_name = false',
  'prompt_new_workspace_name = false',
  '',
  // The cookrew herdr server died four times on 2026-08-08/09, killing every
  // agent each time; one death followed an update check within minutes and
  // none logged a stop request. The background updater is the one lifecycle
  // actor Cookrew can switch off, so it is off — Cookrew's agents must never
  // be collateral of a version check.
  '[update]',
  'version_check = false',
  'manifest_check = false'
].join('\n')

/**
 * Backends in preference order.
 *
 * herdr is preferred where it exists because it is the only backend that gives
 * persistence on EVERY platform — tmux does not exist on Windows, and `direct`
 * loses the agent when the app closes. `COOKREW_MULTIPLEXER` forces one
 * explicitly, which is the escape hatch for a machine where herdr misbehaves.
 */
export function multiplexerOrder(
  preference: string | undefined,
  candidates: Multiplexer[]
): Multiplexer[] {
  if (!preference) return candidates
  const chosen = candidates.filter((m) => m.id === preference)
  // An unknown name falls through to the default order rather than leaving
  // Cookrew with no host at all.
  return chosen.length > 0 ? [...chosen, ...candidates.filter((m) => m.id !== preference)] : candidates
}

export class PtyManager {
  private sessions = new Map<string, PtySession>()
  readonly runtimeDir: string
  readonly socketPath: string
  private tmuxConf: string
  private herdrConf: string

  constructor() {
    // Fixed (pid-independent) so a tmux session's baked-in COOKREW_SOCKET /
    // COOKREW_CLI paths stay valid across app restarts — the whole point of
    // persisting terminals in tmux.
    this.runtimeDir = path.join(tmpdir(), 'cookrew-runtime')
    mkdirSync(this.runtimeDir, { recursive: true })
    this.socketPath = path.join(this.runtimeDir, 'cookrew.sock')
    this.tmuxConf = path.join(this.runtimeDir, 'cookrew.tmux.conf')
    writeFileSync(this.tmuxConf, TMUX_CONF)
    this.herdrConf = path.join(this.runtimeDir, 'cookrew.herdr.toml')
    writeFileSync(this.herdrConf, HERDR_CONF)
    // The backend is chosen here because this is where the config file it
    // needs is written. Published module-wide so the session reaper and every
    // PtySession share ONE instance (and one availability probe).
    // Selection, not assumption: tmux when it is there, the direct backend
    // otherwise. On Windows tmux does not exist and herdr cannot host a
    // terminal, so `direct` is what the release actually runs on.
    const roles = selectMultiplexers({
      candidates: multiplexerOrder(process.env.COOKREW_MULTIPLEXER, [
        new HerdrHostMultiplexer({ session: HERDR_SESSION, configPath: this.herdrConf }),
        new TmuxMultiplexer({ configFile: this.tmuxConf }),
        new DirectMultiplexer()
      ])
    })
    setMultiplexer(roles.host)
    // A dead herdr server means every agent is dead until it returns; the
    // supervisor turns that from "until the next app launch" into ~15s.
    if (roles.host instanceof HerdrHostMultiplexer) roles.host.startSupervisor()

    // Push-fed agent state, when the backend has it. Subscriptions are
    // per-pane, so the feed is refreshed whenever the terminal set changes —
    // see spawn()/kill(); a pane created after the subscription would
    // otherwise never be reported on.
    if (roles.host.capabilities.agentLifecycle) {
      const feed = new HerdrStatusFeed({ session: HERDR_SESSION, configPath: this.herdrConf })
      setStatusFeed(feed)
      feed.start()
    }
  }

  /**
   * Install the CLI next to the socket so PATH injection finds `cookrew`.
   * The entry is a shell wrapper because a bare `cookrew` file with ESM
   * `import`s would be parsed as CommonJS by node.
   */
  installCli(cliSource: string): void {
    // Publish the socket at a STABLE path so a `cookrew` on the system PATH can
    // find it without guessing.
    //
    // The runtime dir lives under the OS temp dir, and that is NOT derivable
    // from another process: on macOS TMPDIR is per-user
    // (/var/folders/.../T), and a shell without TMPDIR makes os.tmpdir()
    // answer '/tmp' instead — a different, wrong socket. Measured from an
    // `env -i` shell. ~/.cookrew is stable for every process this user runs.
    try {
      mkdirSync(COOKREW_HOME, { recursive: true })
      writeFileSync(path.join(COOKREW_HOME, 'socket'), this.socketPath)
    } catch (error) {
      // A missing pointer only costs the PATH-installed CLI its default; panes
      // still get COOKREW_SOCKET injected directly.
      console.error('Publishing the socket pointer failed:', error)
    }
    const script = path.join(this.runtimeDir, 'cookrew.mjs')
    copyFileSync(cliSource, script)
    const wrapper = path.join(this.runtimeDir, 'cookrew')
    writeFileSync(wrapper, `#!/bin/sh\nexec node "${script}" "$@"\n`)
    chmodSync(wrapper, 0o755)
  }

  /**
   * Apply the tmux config to an already-running cookrew server, so sessions that
   * survived a restart pick up config changes (e.g. the status bar) without a
   * server kill. No-op if the server isn't up yet — the next `new-session -f`
   * loads it.
   */
  reloadTmuxConfig(): void {
    activeMux?.reloadConfig()
  }

  spawn(options: Omit<PtySessionOptions, 'socketPath' | 'cliDir' | 'tmuxConf'>): PtySession {
    const existing = this.sessions.get(options.terminalId)
    if (existing) return existing
    const session = new PtySession({
      ...options,
      socketPath: this.socketPath,
      cliDir: this.runtimeDir,
      tmuxConf: this.tmuxConf
    })
    // Delete only when the map still points at THIS session: node-pty drains
    // 'exit' late (see the onData note above), so a killed predecessor's exit
    // can land AFTER its replacement registered — an instance-blind delete
    // would clobber the live session from the map (the restore "running
    // flag" bug: pane alive, ptys.get() undefined, kill() then no-ops).
    session.on('exit', () => {
      if (this.sessions.get(options.terminalId) === session) {
        this.sessions.delete(options.terminalId)
      }
    })
    this.sessions.set(options.terminalId, session)
    // A pane created after the subscription was made is not covered by it.
    statusFeed()?.refresh()
    return session
  }

  get(terminalId: string): PtySession | undefined {
    return this.sessions.get(terminalId)
  }

  /**
   * The pid of the process running INSIDE a terminal's tmux pane. Because the
   * boot command `exec`s the agent (claude/codex/...), the pane pid IS the
   * agent process — used to deterministically bind codex rollouts by lsof.
   * Null when there is no live tmux session.
   */
  panePid(terminalId: string): number | null {
    return activeMux?.panePid(sessionNameFor(terminalId)) ?? null
  }

  /**
   * How the LIVE pane was actually launched: the command tmux ran and when it
   * ran it. Both survive restarts, because `new-session -A` reattaches the
   * existing session and silently ignores the command we would pass today —
   * so this, not the node's stored command, is what the running agent obeys.
   * Used to bind a Pi session that a pre-exclusive-dir pane still writes to.
   * Null when there is no live tmux session.
   */
  paneLaunch(terminalId: string): { command: string; startedAtMs: number | null } | null {
    return activeMux?.paneLaunch(sessionNameFor(terminalId)) ?? null
  }

  /** Detach: drop the PTY but keep the tmux session alive for reattach. */
  detach(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (session) {
      session.dispose()
      this.sessions.delete(terminalId)
    }
  }

  /** Close for good: end the tmux session, then drop the PTY. */
  kill(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (session) {
      session.killSession()
      session.dispose()
      this.sessions.delete(terminalId)
    }
  }

  /**
   * Kill a terminal for good even when it has NO live PTY — a detached,
   * parked-workspace terminal whose tmux session is still running. Workspace
   * DELETE uses this: `kill` alone would no-op for inactive terminals and
   * strand their tmux sessions (claude CLIs) forever.
   */
  /**
   * Kill a terminal and WAIT until its tmux session is actually gone.
   *
   * `kill()` returns before tmux has torn the session down, so an immediate
   * respawn races it: `new-session -A` attaches to the dying session and the
   * teardown lands last, leaving the agent dead. Endpoint restore rebinds a
   * session and reboots in one motion, so it must await the death first.
   *
   * THROWS when the session survives the deadline (H5): resolving silently
   * let restore rebind + respawn onto a session that was never killed —
   * `new-session -A` reattached the survivor, ignored the boot command, and
   * left the node pointing at a session id no process was running.
   */
  async killAndWait(terminalId: string, timeoutMs = 5000): Promise<void> {
    // killDetached (not kill): restore/undo MUST end the tmux session even
    // when the terminal has no tracked PTY — `kill` alone no-ops there and
    // the respawn would reattach to the old session instead of rebooting.
    this.killDetached(terminalId)
    await waitForTmuxDeath(sessionNameFor(terminalId), timeoutMs)
  }

  killDetached(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (session) {
      session.killSession()
      session.dispose()
      this.sessions.delete(terminalId)
      return
    }
    killTmuxSessionByName(sessionNameFor(terminalId))
  }

  /**
   * Startup reaper: kill every cookrew tmux session not owned by a terminal
   * node (past workspace-delete leaks, crash-stranded agents). Returns the
   * reaped names. Foreign tmux sessions are never touched (naming guard).
   */
  reapOrphanSessions(ownedTerminalIds: Iterable<string>): string[] {
    const orphans = orphanSessionNames(listTmuxSessionNames(), ownedTerminalIds)
    for (const name of orphans) killTmuxSessionByName(name)
    return orphans
  }

  /** App quit: detach everything so sessions survive for the next launch. */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }
}
