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

/**
 * Strip the spawning Claude Code session's own markers from an env that will
 * reach an AGENT.
 *
 * Cookrew (or its herdr server) is sometimes launched from inside a Claude
 * Code session — a dev shell, an orchestrator agent. That session's env
 * carries markers like CLAUDE_CODE_CHILD_SESSION, and a claude that inherits
 * them believes it is a nested child session and SWITCHES OFF its transcript
 * saving. Measured live: every pane's claude carried the marker, every
 * session file froze, and file-backed checkpoints stopped advancing — the
 * ledger silently gapped for hours.
 *
 * The leak path is parenthood, not the boot script: panes are children of the
 * multiplexer server, and the server inherited the launcher's env. So this is
 * applied wherever Cookrew hands an env to a server or a pane process.
 */
export function sanitizeAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue
    if (key.startsWith('CLAUDE_CODE_')) continue
    clean[key] = value
  }
  return clean
}

/** What node-pty should spawn to create-or-reattach a session. */
export interface AttachSpawn {
  file: string
  args: string[]
  /**
   * Env the ATTACHING PROCESS itself needs, merged over the terminal's env.
   *
   * tmux never needed this — its target is in the argv (`-L cookrew`). herdr
   * selects its server via HERDR_SESSION in the environment, and an attach
   * spawned without it talks to the user's DEFAULT socket instead: the panes
   * are healthy on Cookrew's server, the attach fails instantly on the wrong
   * one, and every terminal renders blank. The backend that knows the env is
   * the one that returns the argv, so it rides along here.
   */
  env?: Record<string, string>
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
  /**
   * Working directory for the pane.
   *
   * tmux and the direct backend never needed this in the spec: node-pty spawns
   * the attaching process and `cwd` is a spawn option, so the pane inherits it.
   * herdr's SERVER creates the pane, in its own process with its own cwd, so it
   * has to be told — otherwise every agent starts in the server's directory.
   */
  cwd: string
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
  /**
   * Scrollback that the ATTACH CLIENT scrolls on mouse-wheel input.
   *
   * herdr has no copy-mode to command from outside, but its client requests
   * mouse tracking and scrolls the pane's server-side scrollback on wheel
   * events (measured: 3 lines per SGR wheel notch, deterministic; Escape
   * returns to live). A backend declaring this lets PtySession implement
   * checkpoint jumps by WRITING wheel events into the PTY it already owns —
   * the same user-visible behaviour tmux's copy-mode search delivers, through
   * the input channel instead of a control channel.
   */
  wheelScrollback: boolean
  /** Scrollback depth that rises monotonically — checkpoint ordering needs it. */
  monotonicHistory: boolean
  /**
   * Does an agent survive the app closing?
   *
   * This is Cookrew's headline behaviour, not a detail: tmux keeps the session
   * so reopening reattaches a still-running agent. A backend without it still
   * works — it is what Windows ships, since tmux does not exist there and
   * herdr cannot host a terminal — but "your agents die on quit" is something
   * the product has to be able to say out loud, so it is declared here rather
   * than re-derived from the backend's name at each call site.
   */
  persistsAcrossRestart: boolean
  /**
   * Does the backend KNOW when an agent is working, blocked or idle?
   *
   * When false, "has the agent finished?" has to be inferred from output
   * quiescence — silence for N ms — which reports a mid-turn pause as finished
   * and taxes every fast reply by N ms. When true, `waitUntilIdle` answers it
   * directly and the heuristic is not used at all.
   */
  agentLifecycle: boolean
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

  /**
   * Make sure the session exists and is running the agent, BEFORE attaching.
   *
   * tmux folds create-or-reattach into the attach itself (`new-session -A`),
   * so this is a no-op there — which is exactly why it was never a method.
   * herdr cannot: a pane must exist before anything can attach to it, and the
   * pane is created over the socket rather than by the attaching process.
   *
   * Idempotent by contract. Calling it for a session that already exists must
   * do NOTHING — in particular it must not re-run the agent command, because
   * reattaching a surviving agent is the behaviour this whole layer protects.
   */
  ensureSession(spec: AttachSpec): void

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

  /**
   * Wait until the agent in this session stops working.
   *
   * ASYNC and optional, unlike everything else here. Async because the wait can
   * legitimately last minutes and a synchronous one would freeze the main
   * process; optional because only a backend with `agentLifecycle` can answer
   * it at all. Resolves false when the answer is unavailable, so callers fall
   * back to inferring it rather than failing.
   */
  waitUntilIdle?(name: string, timeoutMs: number): Promise<boolean>

  /**
   * Submit a prompt to the agent in this session and wait for it to finish.
   *
   * This is agent-to-agent communication as a MULTIPLEXER primitive — the
   * reason herdr was chosen over tmux. `cookrew ask` otherwise has to type
   * the prompt into the PTY (bracketed paste, tuned submit delays, the
   * swallowed-Enter hazard) and then GUESS at completion; a backend that
   * models agents does both natively, with its own submission handling and a
   * real lifecycle answer.
   *
   * Same contract as waitUntilIdle: async, optional, resolves false whenever
   * the backend cannot do it — callers keep the typed path as the fallback,
   * so a half-working protocol degrades instead of breaking the ask.
   */
  promptAgent?(
    name: string,
    prompt: string,
    timeoutMs: number
  ): Promise<'done' | 'submitted' | 'failed'>

  /**
   * Tell the backend where this agent's session transcript lives.
   *
   * Cookrew's harness registry already resolves this path to build turn
   * history; handing it to the multiplexer lets the backend's own agent
   * detection use the transcript instead of guessing from the screen, and it
   * makes the binding visible to anything else attached to the same server.
   * Optional: only a backend that models agents has anywhere to put it.
   */
  reportAgentSession?(name: string, sessionPath: string): void
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
