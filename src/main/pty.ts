import { EventEmitter } from 'node:events'
import path from 'node:path'
import { mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import pty, { IPty } from 'node-pty'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { sanitizeAgentEnv } from './multiplexer'
import type { Multiplexer, PaneCardInfo } from './multiplexer'
import { TmuxMultiplexer, sessionNameFor as tmuxSessionNameFor, TMUX_LABEL as TMUX_LABEL_CONST } from './tmux-multiplexer'
import { HerdrHostMultiplexer, HERDR_SESSION } from './herdr-host-multiplexer'
import { HerdrStatusFeed, setStatusFeed, statusFeed } from './herdr-agent-status'
import { DirectMultiplexer } from './direct-multiplexer'
import { selectMultiplexers } from './multiplexer-select'
import { harnessFor } from './harness'
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
 * Erase screen + scrollback + home the cursor. Every replay starts here so a
 * reattach REPLACES what the viewer was showing instead of appending under it.
 */
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/**
 * Build the replay frame for a mirror. Split out of PtySession so it can be
 * exercised against a real headless terminal without spawning a PTY — the
 * fidelity claim is the whole point of this change, so it needs a test that
 * actually round-trips a frame rather than one that mocks the answer.
 *
 * Scrollback is bounded to one screenful: the mirror keeps 5000 lines and a
 * phone on SSE should not receive a megabyte to render one screen.
 *
 * MODES travel with the frame, because serialize() captures only buffer
 * content. A viewer that joins mid-session never saw the pane's init
 * sequences — under tmux it always did (every attach spawned a fresh client
 * that re-emitted them), which is why this was never needed before. Without
 * the mouse-tracking replay the viewer's xterm never enters mouse mode, its
 * wheel/touch handling stays local against a one-screen buffer, and the LIVE
 * pane simply cannot be scrolled — the exact herdr-mode symptom reported.
 */
export function buildReplayFrame(
  screen: Pick<HeadlessTerminalType, 'rows' | 'modes'>,
  serializer: Pick<SerializeAddon, 'serialize'>
): string {
  return CLEAR_SCREEN + serializer.serialize({ scrollback: screen.rows }) + modeReplay(screen.modes)
}

/** DECSET replay for the modes a mid-session viewer must adopt. */
export function modeReplay(modes: HeadlessTerminalType['modes']): string {
  let out = ''
  const tracking: Record<string, string> = {
    x10: '\x1b[?9h',
    vt200: '\x1b[?1000h',
    drag: '\x1b[?1002h',
    any: '\x1b[?1003h'
  }
  if (modes.mouseTrackingMode !== 'none') {
    // SGR encoding rides along: it is what herdr negotiates, and the widths
    // of a modern pane overflow the legacy X10 byte encoding anyway.
    out += tracking[modes.mouseTrackingMode] + '\x1b[?1006h'
  }
  if (modes.bracketedPasteMode) out += '\x1b[?2004h'
  // Arrow keys: a TUI in application-cursor mode expects SS3 arrows; a viewer
  // that missed the init would send CSI arrows and the agent would see junk.
  if (modes.applicationCursorKeysMode) out += '\x1b[?1h'
  return out
}

/**
 * The process-wide multiplexer. Set once by PtyManager (which owns the config
 * file the backend needs); module-level helpers below use it so the session
 * reaper keeps working without threading an instance through every call.
 */
let activeMux: Multiplexer | null = null

/**
 * Every constructed backend, host or not. The migration check needs to ask
 * the NON-host backends whether they still hold a live session — the fork
 * that produced two populations of the same agents happened precisely because
 * each backend only ever looked at its own namespace.
 */
let allBackends: Multiplexer[] = []

export function setMultiplexer(mux: Multiplexer): void {
  activeMux = mux
}

export function setBackends(backends: Multiplexer[]): void {
  allBackends = backends
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

/** One physical mirror row, as the wheel-jump planner needs it. */
export interface BufferRow {
  text: string
  /** True when this row is the continuation of the previous logical line. */
  wrapped: boolean
}

/**
 * herdr wheel granularity: SGR wheel events scroll 3 lines per notch (herdr's
 * mouse_scroll_lines default — measured: 5 notches moved offset_from_bottom by
 * exactly 15).
 */
const WHEEL_LINES = 3
/** SGR mouse: button 64 = wheel up, at an arbitrary in-pane cell. */
const WHEEL_UP = '\x1b[<64;10;10M'

/**
 * How many wheel notches scroll the LAST occurrence of `needle` into view.
 *
 * Wrapped rows are joined into logical lines before matching — a long prompt
 * spans physical rows, and matching row-by-row would never find it. The jump
 * lands the match at (or up to WHEEL_LINES-1 rows below) the top of the
 * viewport. Null when the text is absent or blank; 0 when it is already on
 * the live screen.
 */
export function planWheelJump(rows: BufferRow[], viewportRows: number, text: string): number | null {
  const needle = text.trim()
  if (needle.length === 0) return null

  let matchRow: number | null = null
  let logicalStart = 0
  let logical = ''
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].wrapped && logical.length > 0) {
      if (logical.includes(needle)) matchRow = logicalStart
      logicalStart = i
      logical = ''
    }
    logical += rows[i].text
  }
  if (logical.includes(needle)) matchRow = logicalStart
  if (matchRow === null) return null

  // Rows between the match and the bottom of the buffer, minus one viewport:
  // scrolling that far up puts the match at the top row.
  const target = Math.max(0, rows.length - matchRow - viewportRows)
  return Math.ceil(target / WHEEL_LINES)
}

/**
 * ONE live process per terminal, across ALL multiplexers — enforced, not
 * guarded.
 *
 * Switching hosts (tmux <-> herdr) used to FORK the agent population: each
 * backend booted its own copy under the same session name, both wrote the
 * same conversation, and the rail froze on whichever binding lost. The fix
 * follows from what each layer actually stores: a multiplexer hosts only a
 * PROCESS; the conversation lives in the harness session file. So a process
 * found in a non-host backend is killed there and resumed here — a
 * migration, because `--resume` rebuilds it from the source of truth.
 *
 * The one honest exception: a harness with `turns: 'scrape'` has no session
 * file, so for it the conversation IS the process. Killing it would destroy
 * real state, so it stays where it lives and the skip is said out loud.
 * Plain shells (no harness) are also left: they hold unresumable state
 * (jobs, history) and are not agents.
 *
 * Returns what happened so the decision is testable and loggable.
 */
export function migrateForeignSession(
  spec: { sessionName: string; command: string },
  host: Multiplexer,
  others: Multiplexer[],
  turnsFor: (command: string) => 'file' | 'scrape' | null,
  waitMs = 3000
): 'none' | 'migrated' | 'left-unresumable' {
  const holder = others.find(
    (backend) => backend !== host && backend.available() && backend.sessionExists(spec.sessionName)
  )
  if (!holder) return 'none'

  if (turnsFor(spec.command) !== 'file') {
    console.error(
      `terminal ${spec.sessionName} is alive under '${holder.id}' but cannot be resumed ` +
        `(no session file) — leaving it there; the '${host.id}' host will run a separate instance`
    )
    return 'left-unresumable'
  }

  holder.killSession(spec.sessionName)
  // The kill is asynchronous on the other side; booting here while the old
  // process still holds the session file's tail invites interleaved writes.
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && holder.sessionExists(spec.sessionName)) {
    // Each probe is a process spawn — self-throttling.
  }
  console.error(
    `terminal ${spec.sessionName}: migrated from '${holder.id}' to '${host.id}' ` +
      '(process killed there, conversation resumes here from its session file)'
  )
  return 'migrated'
}

/**
 * Verdict for one owner write at a possibly-armed terminal (Sol r4 P0-1).
 * 'preempt-failed' means the armed dispatch's interrupt row could NOT commit
 * durably (ledger down, intent parked fail-closed) — the owner's bytes are
 * REFUSED rather than delivered, because delivering them would open a second
 * producer's turn beside a reservation that is still live.
 */
export type OwnerInputVerdict = 'allow' | 'preempt-failed'

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
  /**
   * The Cookrew card behind this terminal, for backends that bind display
   * metadata into their own UI (herdr's pane title/tokens). Ignored by
   * backends with no UI of their own.
   */
  card?: PaneCardInfo
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
  /** Turns the mirror back into ANSI for replayFrame(); see it for why. */
  private serializer: SerializeAddon
  private lastOutputAt = 0
  private disposed = false

  readonly usesTmux: boolean
  /**
   * The multiplexer session this terminal lives in. Public because callers
   * that ask the backend about this terminal — `cookrew ask` waiting for the
   * agent to go idle — need to name it.
   */
  readonly sessionName: string

  /**
   * The local-producer guard (Sol r4 P0-1a), consulted BEFORE proc.write —
   * which is the only place a guard can actually stop a competing submission;
   * a hook that fires after delivery only changes bookkeeping. Wired by the
   * conductor to the tracker's preemption (TurnTracker.guardOwnerInput): when
   * the write would submit a NEW prompt into a terminal carrying an armed
   * dispatch, the guard preempts the dispatch synchronously-durably first.
   * 'preempt-failed' (the interrupt row could not commit) REFUSES the write,
   * fail-closed: the bytes never reach the child and no input event fires.
   * Null (unwired) allows everything — the plain write path of tests and
   * shells.
   */
  beforeOwnerInput: ((terminalId: string, data: string) => OwnerInputVerdict) | null = null

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
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)

    const env = {
      // Sanitized: under tmux/direct the pane (or the tmux SERVER on its
      // first start) inherits this env, and a launcher-session marker turns
      // off the agent's transcript saving (see sanitizeAgentEnv).
      ...sanitizeAgentEnv(process.env),
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
      cwd: options.cwd,
      card: options.card
    }
    // One live process per terminal across ALL backends: a copy of this
    // agent alive under a non-host multiplexer is killed there first and
    // resumed here — see migrateForeignSession. Without this, switching
    // hosts forked the whole agent population.
    migrateForeignSession(attachSpec, activeMux!, allBackends, (c) => harnessFor(c)?.turns ?? null)
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
    // The producer guard runs BEFORE the bytes reach the child (Sol r4 P0-1a):
    // preemption after proc.write cannot stop a competing submission, only
    // relabel it. A refused write delivers nothing and announces nothing.
    if (this.beforeOwnerInput?.(this.terminalId, data) === 'preempt-failed') return
    this.proc.write(data)
    // Every input path (renderer keystrokes, `cookrew ask`, routines) funnels
    // through here, so turn tracking can observe prompts uniformly.
    this.emit('input', data)
  }

  /**
   * The dispatch engine's OWN delivery through this PTY — the reattach
   * fallback, and nothing else (Sol r4 P0-1a/b). Bypasses the owner guard
   * (the dispatch must not preempt itself) and tags the input event with its
   * source, so the tracker's fallback exemption keys on PROVENANCE, never on
   * byte equality — an owner typing the identical bytes is still an owner.
   */
  writeFromDispatch(data: string): void {
    this.proc.write(data)
    this.emit('input', data, 'dispatch')
  }

  /**
   * Announce input that reached the agent WITHOUT passing through write —
   * a herdr-native ask submits the prompt server-side, so the only way turn
   * tracking hears about it is this. Same event, same payload shape.
   */
  noteExternalInput(data: string): void {
    this.emit('input', data)
  }

  resize(cols: number, rows: number): void {
    const changed = cols !== this.screen.cols || rows !== this.screen.rows
    try {
      this.proc.resize(cols, rows)
      this.screen.resize(cols, rows)
    } catch (error) {
      console.error('PTY resize failed:', error)
      return
    }
    // A geometry change invalidates every viewer's screen, because herdr's
    // deltas address the cursor ABSOLUTELY against the pane geometry (see
    // replayFrame). Re-serialize at the NEW size and push it to viewers so
    // nobody keeps applying fresh deltas onto stale addressing — this is what
    // tmux gave away for free by fully repainting on every attach and resize.
    //
    // Emitted as 'replay', NOT 'data': the turn tracker listens on 'data' to
    // decide whether the agent is producing output, and a synthetic
    // full-screen repaint there reads as agent activity — it would reset
    // quiescence and mint phantom checkpoints. Only viewers subscribe here.
    if (changed && !this.disposed) this.emit('replay', this.replayFrame())
  }

  /**
   * A faithful ANSI repaint of the mirror at its CURRENT geometry — the
   * baseline a viewer must apply BEFORE any live delta.
   *
   * The old baseline was `viewportText()`, plain text with the escapes
   * stripped. Under tmux that was survivable: tmux fully repaints on every
   * attach and resize, so a viewer that started from an approximation was
   * corrected within one frame. herdr does not — its chrome-off client
   * optimizes to dirty-region repaints with ABSOLUTE cursor addressing bound
   * to the pane geometry (measured: 0 idle bytes). Apply those to a screen
   * that was seeded with unstyled, unwrapped text at a different width and
   * the addresses land in the wrong cells: doubled line spacing and blocks out
   * of order — the scrambled transcripts users only ever saw in herdr mode.
   *
   * Serializing the headless mirror instead reproduces colours, attributes,
   * wrapping and cursor position, so the viewer's grid matches the mirror cell
   * for cell and the absolute addresses in later deltas mean what they say.
   *
   * The leading clear resets both screen and scrollback: a reattach must not
   * append this frame under whatever the viewer was showing before.
   */
  replayFrame(): string {
    if (this.disposed) return ''
    try {
      return buildReplayFrame(this.screen, this.serializer)
    } catch (error) {
      // Never let a serialize failure take down an attach: fall back to the
      // pre-existing plain-text baseline rather than showing nothing.
      console.error('PTY replay serialize failed, falling back to text:', error)
      return CLEAR_SCREEN + this.viewportText() + '\r\n'
    }
  }

  /**
   * The geometry a viewer must adopt before applying `replayFrame()`. Sent
   * first in an attach so the client's xterm is built at the mirror's size:
   * the frame's wrapping is baked in at these columns, and a client that
   * paints it at its own width re-wraps every long line.
   */
  geometry(): { cols: number; rows: number } {
    return { cols: this.screen.cols, rows: this.screen.rows }
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
   * Scroll the pane's view to the most recent occurrence of `text`. Always
   * restarts from the live tail so successive jumps land deterministically
   * regardless of the current scroll position.
   *
   * Two mechanisms, chosen by capability:
   * - copyModeSearch (tmux): the backend searches its own scrollback.
   * - wheelScrollback (herdr): there is no copy-mode to command, but the
   *   attach client scrolls the pane on wheel input — so the MIRROR is the
   *   search index and the jump is delivered as wheel events written into
   *   the PTY this session already owns. Same user-visible behaviour,
   *   through the input channel instead of a control channel.
   *
   * Without either capability this is a no-op — which under herdr it used to
   * be by accident, and "cannot scroll transcripts" was the user-visible bug.
   */
  jumpToText(text: string): void {
    if (this.disposed) return
    const mux = activeMux
    if (!mux) return
    if (mux.capabilities.copyModeSearch) {
      mux.jumpToText(this.sessionName, text)
      return
    }
    if (mux.capabilities.wheelScrollback) this.wheelJumpTo(text)
  }

  /** Leave scrollback browsing and return the pane to the live tail. */
  exitCopyMode(): void {
    if (this.disposed) return
    const mux = activeMux
    if (!mux) return
    if (mux.capabilities.copyModeSearch) {
      mux.exitCopyMode(this.sessionName)
      return
    }
    if (mux.capabilities.wheelScrollback) this.wheelExitScrollback()
  }

  /**
   * Escape returns a scrolled pane to live (measured: offset 74 -> 0). It is
   * ONLY safe while actually scrolled — at the live tail herdr forwards the
   * Escape to the agent, where it lands as an interrupt in a TUI's input.
   */
  private wheelExitScrollback(): void {
    const offset = activeMux?.scrollState(this.sessionName).scrollRow ?? null
    if (offset !== null && offset > 0) this.proc.write('\x1b')
  }

  /**
   * The wheel-event jump: find the last occurrence of `text` in the mirror,
   * compute how far above the live tail it sits, and scroll there.
   *
   * The mirror is the honest search index here — it is fed by the same
   * transparent attach stream the pane renders, at the same width, so its
   * line offsets and herdr's scrollback offsets agree. Wrapped rows are
   * joined into logical lines before matching (a long prompt spans physical
   * rows; matching row-by-row would never find it). Granularity is the wheel
   * notch, so the landing can be up to WHEEL_LINES-1 rows shy — the target
   * stays in the viewport, which is what a jump promises.
   */
  private wheelJumpTo(text: string): void {
    const rows: BufferRow[] = []
    const buffer = this.screen.buffer.active
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)
      rows.push({ text: line ? line.translateToString(true) : '', wrapped: line?.isWrapped ?? false })
    }
    const notches = planWheelJump(rows, this.screen.rows, text)
    if (notches === null) return
    this.wheelExitScrollback()
    for (let i = 0; i < notches; i += 1) this.proc.write(WHEEL_UP)
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

  /**
   * Backend death fan-out (Sol r1 P1): the supervisor's detection must reach
   * the dispatch plane so every open record its panes hosted is stamped
   * interrupted — never left to the ten-minute sweep. Late-bound because the
   * dispatch service is constructed after the manager; called only long
   * after both exist.
   */
  onBackendDeath: ((why: string) => void) | null = null

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
    const candidates = multiplexerOrder(process.env.COOKREW_MULTIPLEXER, [
      new HerdrHostMultiplexer({ session: HERDR_SESSION, configPath: this.herdrConf }),
      new TmuxMultiplexer({ configFile: this.tmuxConf }),
      new DirectMultiplexer()
    ])
    const roles = selectMultiplexers({ candidates })
    setMultiplexer(roles.host)
    setBackends(candidates)
    // A dead herdr server means every agent is dead until it returns; the
    // supervisor turns that from "until the next app launch" into ~15s.
    if (roles.host instanceof HerdrHostMultiplexer) {
      roles.host.startSupervisor(undefined, (why) => this.onBackendDeath?.(why))
    }

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
    // A workspace switch spawns every terminal synchronously, so collapse that
    // burst to one subscription rebuild after the last pane exists.
    statusFeed()?.refreshSoon()
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
