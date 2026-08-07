// The tmux backend — today's behaviour, extracted verbatim.
//
// Nothing here is new. Every command, flag and parse is what pty.ts and
// board-index.ts already ran; moving it behind the Multiplexer interface is
// the whole change. Where a comment explains WHY a flag is there, it came
// across with the code, because that reasoning is the expensive part.

import { execFileSync, spawnSync } from 'node:child_process'
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

/** Cookrew's own tmux server, isolated from the user's. */
export const TMUX_LABEL = 'cookrew'

/** Our session naming, so the reaper never touches foreign sessions. */
export const COOKREW_SESSION_RE = /^cookrew_[A-Za-z0-9]+$/

/** tmux session name for a terminal id (names can't contain '.' or ':'). */
export function sessionNameFor(terminalId: string): string {
  return `cookrew_${terminalId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
}

export const execRunner: CommandRunner = {
  run: (file, args) =>
    execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  runQuiet: (file, args) => {
    try {
      execFileSync(file, args, { stdio: 'ignore' })
    } catch {
      // Best effort by contract — see CommandRunner.
    }
  },
  probe: (file, args) => {
    try {
      return spawnSync(file, args, { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  }
}

/**
 * The boot script a tmux pane runs.
 *
 * tmux does NOT reliably propagate injected env into a pane — its server has
 * its own environment — so the vars are baked into a script the session runs.
 * On REATTACH tmux ignores this command entirely, which is what makes a
 * restart preserve the original env and the running agent.
 */
export function bootScript(spec: AttachSpec): string {
  const inner = spec.command && spec.command.trim().length > 0 ? spec.command : `${spec.shell} -l`
  return [
    `export TERM_PROGRAM=Cookrew`,
    `export COOKREW_TERMINAL_ID='${spec.terminalId}'`,
    `export COOKREW_SOCKET='${spec.socketPath}'`,
    `export COOKREW_CLI='${path.join(spec.cliDir, 'cookrew')}'`,
    `export PATH='${spec.path}'`,
    `exec ${inner}`
  ].join('; ')
}

export interface TmuxOptions {
  /** Path to the generated cookrew.tmux.conf. */
  configFile: string
  runner?: CommandRunner
}

export class TmuxMultiplexer implements Multiplexer {
  readonly id = 'tmux'

  readonly capabilities: MultiplexerCapabilities = {
    copyModeSearch: true,
    monotonicHistory: true
  }

  private readonly runner: CommandRunner
  private readonly configFile: string
  private probed: boolean | null = null

  constructor(options: TmuxOptions) {
    this.configFile = options.configFile
    this.runner = options.runner ?? execRunner
  }

  /** Probed once — the answer cannot change while the app runs. */
  available(): boolean {
    if (this.probed === null) this.probed = this.runner.probe('tmux', ['-V'])
    return this.probed
  }

  private tmux(args: string[]): string {
    return this.runner.run('tmux', ['-L', TMUX_LABEL, ...args])
  }

  private quiet(args: string[]): void {
    this.runner.runQuiet('tmux', ['-L', TMUX_LABEL, ...args])
  }

  sessionExists(name: string): boolean {
    return this.runner.probe('tmux', ['-L', TMUX_LABEL, 'has-session', '-t', name])
  }

  listSessions(): string[] {
    if (!this.available()) return []
    try {
      return this.tmux(['list-sessions', '-F', '#{session_name}'])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => COOKREW_SESSION_RE.test(line))
    } catch {
      // No server running is the ordinary "no sessions" case, not an error.
      return []
    }
  }

  killSession(name: string): void {
    if (!this.available()) return
    this.quiet(['kill-session', '-t', name])
  }

  /**
   * `new-session -A`: reattach the terminal's session if it survived a
   * restart/switch, else create it.
   */
  attachSpawn(spec: AttachSpec): AttachSpawn {
    return {
      file: 'tmux',
      args: [
        '-L', TMUX_LABEL,
        '-f', this.configFile,
        'new-session', '-A', '-s', spec.sessionName,
        'sh', '-c', bootScript(spec)
      ]
    }
  }

  capture(name: string): string | null {
    try {
      return this.tmux(['capture-pane', '-p', '-t', name])
    } catch {
      return null
    }
  }

  scrollState(name: string): ScrollState {
    try {
      const out = this.tmux(['display-message', '-p', '-t', name, '#{scroll_position}:#{history_size}'])
      return parseScrollState(out)
    } catch {
      return { scrollRow: null, historySize: null }
    }
  }

  panePid(name: string): number | null {
    if (!this.available()) return null
    try {
      const first = this.tmux(['list-panes', '-t', name, '-F', '#{pane_pid}'])
        .toString()
        .trim()
        .split('\n')[0]
      const pid = parseInt(first, 10)
      return Number.isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  paneLaunch(name: string): PaneLaunch | null {
    if (!this.available()) return null
    try {
      return parsePaneLaunch(
        this.tmux(['display-message', '-p', '-t', name, '#{session_created}\t#{pane_start_command}'])
      )
    } catch {
      return null
    }
  }

  /**
   * Always restarts from the live tail so successive jumps land
   * deterministically regardless of the current scroll position.
   */
  jumpToText(name: string, text: string): void {
    this.quiet(['send-keys', '-t', name, '-X', 'cancel'])
    this.quiet(['copy-mode', '-t', name])
    this.quiet(['send-keys', '-t', name, '-X', 'search-backward', text])
  }

  exitCopyMode(name: string): void {
    this.quiet(['send-keys', '-t', name, '-X', 'cancel'])
  }

  reloadConfig(): void {
    if (!this.available()) return
    this.quiet(['source-file', this.configFile])
  }
}

/** `#{scroll_position}:#{history_size}` — either side may be empty. */
export function parseScrollState(raw: string): ScrollState {
  const [rawRow, rawHistory] = raw.trim().split(':')
  const row = parseInt(rawRow, 10)
  const history = parseInt(rawHistory, 10)
  return {
    scrollRow: Number.isNaN(row) ? null : row,
    historySize: Number.isNaN(history) ? null : history
  }
}

/** `#{session_created}\t#{pane_start_command}` — seconds, then the command. */
export function parsePaneLaunch(raw: string): PaneLaunch | null {
  const [created, ...rest] = raw.replace(/\n$/, '').split('\t')
  const command = rest.join('\t')
  if (!command) return null
  const seconds = parseInt(created, 10)
  return {
    command,
    startedAtMs: Number.isNaN(seconds) ? null : seconds * 1000
  }
}
