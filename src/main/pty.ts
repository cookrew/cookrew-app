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
function sessionNameFor(terminalId: string): string {
  return `cookrew_${terminalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
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

    this.proc.onData((data) => {
      this.lastOutputAt = Date.now()
      this.screen.write(data)
      this.emit('data', data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.emit('exit', exitCode)
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

  /** Plain-text rendering of the current viewport (like `maestri check`). */
  viewportText(): string {
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

  /** App quit: detach everything so sessions survive for the next launch. */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }
}
