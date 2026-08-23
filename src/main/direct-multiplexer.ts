// No multiplexer at all: node-pty talks to the shell directly.
//
// WHY THIS IS A BACKEND AND NOT AN `else`
// ---------------------------------------
// pty.ts already had this path — a bare `pty.spawn(shell, …)` in the branch
// taken when tmux is missing. It was reachable, untested, and invisible: the
// only signal was a boolean `usesTmux`, so every call site that wanted to know
// "does history survive a restart?" had to ask "is this tmux?" instead.
//
// That mattered the moment Windows became a target. tmux does not exist there
// and herdr cannot host a terminal, so this path IS the Windows runtime — the
// thing the release actually ships — and it deserves the same treatment as the
// backend it replaces: a name, declared capabilities, and tests.
//
// WHAT IT COSTS, STATED IN THE CAPABILITIES
// -----------------------------------------
// Persistence is the whole reason Cookrew runs agents inside a multiplexer:
// closing the app leaves tmux holding the session, and reopening reattaches a
// still-running agent. Here the PTY is a child of the app, so quitting ends
// the agents. `persistsAcrossRestart: false` says so, once, where callers can
// act on it — rather than each of them re-deriving it from the backend's name.

import type {
  AttachSpawn,
  AttachSpec,
  Multiplexer,
  MultiplexerCapabilities,
  PaneLaunch,
  ScrollState
} from './multiplexer'

export class DirectMultiplexer implements Multiplexer {
  readonly id = 'direct'

  readonly capabilities: MultiplexerCapabilities = {
    // node-pty owns the process, so the stream is the pane's bytes by
    // construction. This is the one backend that cannot fail transparency.
    attach: true,
    // No scrollback server to search: the headless xterm mirror is all there
    // is, and it cannot be scrolled from outside.
    copyModeSearch: false,
    // No out-of-process scrollback for a wheel event to scroll.
    wheelScrollback: false,
    // No history counter that survives anything, so checkpoint ordering must
    // fall back to its screen-derived path.
    monotonicHistory: false,
    persistsAcrossRestart: false,
    // No agent lifecycle: quiescence has to be inferred from output silence.
    agentLifecycle: false
  }

  /** Always: node-pty is a dependency, not an external program. */
  available(): boolean {
    return true
  }

  /**
   * There is no session registry. A terminal exists exactly as long as its
   * PtySession object does, and PtyManager already tracks those — so answering
   * "yes" here would claim knowledge this backend does not have.
   */
  sessionExists(): boolean {
    return false
  }

  listSessions(): string[] {
    return []
  }

  killSession(): void {
    // Disposing the PtySession kills the child. Nothing survives it to clean
    // up, which is the same fact as persistsAcrossRestart: false.
  }

  /** Nothing to create: the spawn IS the session. */
  ensureSession(): void {}

  /**
   * A login shell running the command, with the CLI bridge in the environment.
   *
   * `-l` matters: a GUI-launched app inherits a stripped PATH, and the agent
   * needs the user's real one. The env vars ride on the spawn options rather
   * than a boot script — there is no server in between to lose them, which is
   * the one thing this backend has that tmux does not.
   */
  attachSpawn(spec: AttachSpec): AttachSpawn {
    const command = spec.command && spec.command.trim().length > 0 ? spec.command : spec.shell
    return { file: spec.shell, args: ['-l', '-c', command] }
  }

  /**
   * Null, not '' — the distinction is load-bearing. The board probe treats ''
   * as "the pane is empty" and null as "no signal", and this backend genuinely
   * has no out-of-process view of the screen.
   */
  capture(_name: string): string | null {
    return null
  }

  /**
   * Null depth, ALWAYS — this backend has no out-of-process view of a pane, so
   * there is no scrollback counter to read.
   *
   * The name parameter is declared even though nothing reads it. TypeScript
   * accepts a shorter signature against the interface, so `scrollState()`
   * compiled fine while every caller passed a session name — and a future body
   * that started returning real state would have had a name in scope it was
   * not using, which is exactly how one terminal's answer gets derived from
   * another's output. Naming the argument makes ignoring it a decision.
   *
   * Consequence worth stating: on this backend the delivery contract's wedge
   * check can never fire and `promptInBox` is always unknown, so an
   * unconfirmed delivery reports `unverifiable`. That is the fail-closed
   * direction, and ask-delivery counts it (see blindDeliveryCount) so an inert
   * feature is visible rather than silent.
   */
  scrollState(_name: string): ScrollState {
    return { scrollRow: null, historySize: null }
  }

  panePid(): number | null {
    return null
  }

  paneLaunch(): PaneLaunch | null {
    return null
  }

  jumpToText(): void {
    // capabilities.copyModeSearch is false; callers check it.
  }

  exitCopyMode(): void {
    // Nothing to leave.
  }

  reloadConfig(): void {
    // No configuration to reload.
  }
}
