import { EventEmitter } from 'node:events'
import path from 'node:path'
import { mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import pty, { IPty } from 'node-pty'
import xtermHeadless from '@xterm/headless'
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
export const TMUX_LABEL = 'cookrew'
const TMUX_AVAILABLE = detectTmux()

function detectTmux(): boolean {
  try {
    const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

/** tmux session name for a terminal id (names can't contain '.' or ':'). */
export function sessionNameFor(terminalId: string): string {
  return `cookrew_${terminalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
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

/** Kill a cookrew tmux session by NAME (best effort) — no live PTY needed. */
function killTmuxSessionByName(name: string): void {
  if (!TMUX_AVAILABLE) return
  try {
    execFileSync('tmux', ['-L', TMUX_LABEL, 'kill-session', '-t', name], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

/** Live cookrew tmux session names, or [] when no server / tmux is absent. */
function listTmuxSessionNames(): string[] {
  if (!TMUX_AVAILABLE) return []
  try {
    const out = execFileSync('tmux', ['-L', TMUX_LABEL, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8'
    })
    return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  } catch {
    return [] // no running server (no sessions)
  }
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
  private sessionName: string

  constructor(options: PtySessionOptions) {
    super()
    this.terminalId = options.terminalId
    const shell = process.env.SHELL ?? '/bin/zsh'
    const cols = options.cols ?? 100
    const rows = options.rows ?? 30
    this.usesTmux = TMUX_AVAILABLE && Boolean(options.tmuxConf)
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

    if (this.usesTmux) {
      // `new-session -A`: reattach the terminal's session if it survived a
      // restart/switch, else create it. tmux does NOT reliably propagate our
      // injected env into the pane (its server has its own environment), so
      // bake the vars into a boot script the session runs — including a full
      // PATH, since a GUI-launched app inherits a stripped one. On reattach
      // tmux ignores this command, so the original env/agent persist.
      const inner =
        options.command && options.command.trim().length > 0 ? options.command : `${shell} -l`
      const boot = [
        `export TERM_PROGRAM=Cookrew`,
        `export COOKREW_TERMINAL_ID='${options.terminalId}'`,
        `export COOKREW_SOCKET='${options.socketPath}'`,
        `export COOKREW_CLI='${path.join(options.cliDir, 'cookrew')}'`,
        `export PATH='${options.cliDir}:${process.env.PATH ?? ''}'`,
        `exec ${inner}`
      ].join('; ')
      const args = [
        '-L', TMUX_LABEL, '-f', options.tmuxConf!, 'new-session', '-A', '-s', this.sessionName,
        'sh', '-c', boot
      ]
      this.proc = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: options.cwd, env })
    } else {
      this.proc = pty.spawn(shell, ['-l', '-c', options.command || shell], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd,
        env
      })
    }

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
    try {
      execFileSync('tmux', ['-L', TMUX_LABEL, 'kill-session', '-t', this.sessionName], {
        stdio: 'ignore'
      })
    } catch {
      // session already gone — nothing to do
    }
  }

  /**
   * Scroll the pane's view to the most recent occurrence of `text` (tmux
   * copy-mode literal search). Always restarts from the live tail so
   * successive jumps land deterministically regardless of the current
   * scroll position. Best-effort no-op without tmux.
   */
  jumpToText(text: string): void {
    if (!this.usesTmux || this.disposed) return
    this.tmuxBestEffort(['send-keys', '-t', this.sessionName, '-X', 'cancel'])
    this.tmuxBestEffort(['copy-mode', '-t', this.sessionName])
    this.tmuxBestEffort(['send-keys', '-t', this.sessionName, '-X', 'search-backward', text])
  }

  /** Leave copy-mode and return the pane to the live tail. */
  exitCopyMode(): void {
    if (!this.usesTmux || this.disposed) return
    this.tmuxBestEffort(['send-keys', '-t', this.sessionName, '-X', 'cancel'])
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
    try {
      const out = execFileSync(
        'tmux',
        [
          '-L',
          TMUX_LABEL,
          'display-message',
          '-p',
          '-t',
          this.sessionName,
          '#{scroll_position}:#{history_size}'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .toString('utf8')
        .trim()
      const [rowRaw = '', historyRaw = ''] = out.split(':')
      const row = rowRaw.length === 0 ? NaN : parseInt(rowRaw, 10)
      const history = parseInt(historyRaw, 10)
      return {
        scrollRow: Number.isNaN(row) ? null : row,
        historySize: Number.isNaN(history) ? null : history
      }
    } catch {
      return { scrollRow: null, historySize: null }
    }
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

  private tmuxBestEffort(args: string[]): void {
    try {
      execFileSync('tmux', ['-L', TMUX_LABEL, ...args], { stdio: 'ignore' })
    } catch {
      // pane not in the expected mode (e.g. cancel outside copy-mode)
    }
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

export class PtyManager {
  private sessions = new Map<string, PtySession>()
  readonly runtimeDir: string
  readonly socketPath: string
  private tmuxConf: string

  constructor() {
    // Fixed (pid-independent) so a tmux session's baked-in COOKREW_SOCKET /
    // COOKREW_CLI paths stay valid across app restarts — the whole point of
    // persisting terminals in tmux.
    this.runtimeDir = path.join(tmpdir(), 'cookrew-runtime')
    mkdirSync(this.runtimeDir, { recursive: true })
    this.socketPath = path.join(this.runtimeDir, 'cookrew.sock')
    this.tmuxConf = path.join(this.runtimeDir, 'cookrew.tmux.conf')
    writeFileSync(this.tmuxConf, TMUX_CONF)
  }

  /**
   * Install the CLI next to the socket so PATH injection finds `cookrew`.
   * The entry is a shell wrapper because a bare `cookrew` file with ESM
   * `import`s would be parsed as CommonJS by node.
   */
  installCli(cliSource: string): void {
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
    if (!TMUX_AVAILABLE) return
    try {
      execFileSync('tmux', ['-L', TMUX_LABEL, 'source-file', this.tmuxConf], { stdio: 'ignore' })
    } catch {
      // server not running yet — new-session will load the config
    }
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
    session.on('exit', () => this.sessions.delete(options.terminalId))
    this.sessions.set(options.terminalId, session)
    return session
  }

  get(terminalId: string): PtySession | undefined {
    return this.sessions.get(terminalId)
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
