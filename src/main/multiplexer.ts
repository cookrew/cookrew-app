// The terminal multiplexer Cookrew runs agents inside, as an interface.
//
// WHY A SEAM
// ----------
// Cookrew had twelve tmux invocations spread across pty.ts and board-index.ts,
// each encoding the contract as a format string at the call site. That is a
// liability on its own: a tmux behaviour change is discovered at runtime, in
// production, by a scraper returning something unexpected.
//
// This interface names the twelve things Cookrew actually needs. It is
// deliberately NOT "everything tmux can do" — it is the smallest surface that
// keeps today's features working, which is also the smallest surface a
// replacement has to satisfy.
//
// The capability shape mirrors harness.ts (`turns: 'file' | 'scrape'`): call
// sites ask what a multiplexer CAN do rather than branching on which one it
// is, so a half-migrated configuration is supported rather than broken.

/** What node-pty should spawn to create-or-reattach a session. */
export interface AttachSpawn {
  file: string
  args: string[]
}

/** Everything needed to build that argv. */
export interface AttachSpec {
  sessionName: string
  /** The agent command; empty means an interactive login shell. */
  command: string
  shell: string
  terminalId: string
  socketPath: string
  cliDir: string
  /** PATH the pane should run with (a GUI-launched app inherits a stripped one). */
  path: string
}

/**
 * Pane scroll state, in ONE round-trip.
 *
 * - `scrollRow`: lines scrolled UP from the live bottom while browsing
 *   (0 = at the bottom but still in a browsing mode); null when live.
 * - `historySize`: lines that have scrolled into scrollback since the session
 *   started. This RISES with the session and survives Cookrew's reattaches,
 *   which is why checkpoint ordering uses it instead of the screen buffer —
 *   a TUI repaints in place, so screen-derived counts saturate at pane rows.
 */
export interface ScrollState {
  scrollRow: number | null
  historySize: number | null
}

/**
 * How the LIVE pane was actually launched. Both fields survive restarts,
 * because reattaching silently ignores the command we would pass today — so
 * this, not the node's stored command, is what the running agent obeys.
 */
export interface PaneLaunch {
  command: string
  startedAtMs: number | null
}

/**
 * Capabilities a multiplexer may not have. Call sites degrade instead of
 * branching on `id`, so adding a backend does not mean editing every caller.
 *
 * `copyModeSearch` is the one real asymmetry found so far: tmux can scroll a
 * pane to the last occurrence of a string (copy-mode search), which drives
 * checkpoint jumps. A backend without it must report false rather than
 * pretend, so the UI can hide the affordance instead of silently no-opping.
 */
export interface MultiplexerCapabilities {
  /**
   * Can node-pty attach to a session and get a TRANSPARENT byte stream — the
   * pane's own output, with nothing of the multiplexer's own UI in it?
   *
   * This is the hard requirement for hosting agents, and it is not a given.
   * Measured: `tmux attach` yields 2,090 bytes and echoes typed input back;
   * `herdr session attach` yields 97,553 bytes of TUI repaint for the same
   * pane and never echoes the input at all. A backend that cannot do this can
   * still serve READS (see the board probe) but must never host a terminal,
   * so the flag is declared rather than assumed.
   */
  attach: boolean
  copyModeSearch: boolean
  /** Scrollback depth that rises monotonically — checkpoint ordering needs it. */
  monotonicHistory: boolean
}

export interface Multiplexer {
  readonly id: string
  readonly capabilities: MultiplexerCapabilities

  /** Is the backend installed and answering? Probed once at startup. */
  available(): boolean

  sessionExists(name: string): boolean
  /** Session names this backend owns — never foreign ones. */
  listSessions(): string[]
  killSession(name: string): void

  attachSpawn(spec: AttachSpec): AttachSpawn

  /** Full scrollback as text, or null when the session is gone. */
  capture(name: string): string | null
  scrollState(name: string): ScrollState
  panePid(name: string): number | null
  paneLaunch(name: string): PaneLaunch | null

  /** Scroll the pane to the most recent occurrence of `text`. */
  jumpToText(name: string, text: string): void
  /** Return the pane to the live tail. */
  exitCopyMode(name: string): void

  /** Re-read backend configuration, if it has any. */
  reloadConfig(): void
}

/**
 * Process execution, injected so a multiplexer is testable without the real
 * binary. Three shapes, because the call sites genuinely differ:
 *
 *   run      — need the output; throws when the command fails
 *   runQuiet — fire-and-forget; a failure is an expected outcome (e.g.
 *              cancelling copy-mode when the pane is not in copy-mode)
 *   probe    — only the exit status matters
 */
export interface CommandRunner {
  run: (file: string, args: string[]) => string
  runQuiet: (file: string, args: string[]) => void
  probe: (file: string, args: string[]) => boolean
}
