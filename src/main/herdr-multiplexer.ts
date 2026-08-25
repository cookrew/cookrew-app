// The herdr backend — READS ONLY, and that is a measured conclusion.
//
// WHAT IT CAN DO
// --------------
// herdr's socket API is better than tmux at the one thing Cookrew's scraper
// fights hardest. `pane read --source recent-unwrapped` returns LOGICAL lines;
// tmux's capture-pane returns physical rows, so a wrapped agent reply arrives
// split at the pane edge and has to be reassembled. Measured on a pane
// emitting 120 long lines: 100 logical lines vs 199 physical rows. It also
// emits no status bar, so there is no chrome to strip — the job TMUX_STATUS_RE
// does, and once did wrongly in production.
//
// WHAT IT CANNOT DO, AND WHY THIS IS NOT A DRAFT
// ----------------------------------------------
// It cannot host a terminal. node-pty needs a TRANSPARENT attach: the pane's
// bytes and nothing else. Measured against a `tmux attach` baseline on the
// same kind of pane:
//
//     tmux attach          2,090 bytes    193 escapes   typed input echoed back
//     herdr session attach 97,553 bytes 6,968 escapes   input never echoed
//
// `session attach` hands back herdr's full TUI — colour negotiation, sidebar,
// continuous repaint. `agent attach`, the only candidate for a raw single-pane
// attach, could not resolve any target form (agent label, pane id, terminal
// id) even for an agent that `agent list` was reporting at that moment.
//
// THE OTHER ARCHITECTURE, ALSO CLOSED
// -----------------------------------
// Attaching a PTY is not the only way this could work. The inverse — herdr
// OWNS the pane, and Cookrew drives it entirely over the socket API — needs no
// attach at all, and it was tested separately:
//
//   input   `pane send-text` / `send-keys`  WORKS (verified: keystrokes land)
//   state   `agent_status`, `state_change_seq`                        WORKS
//   output  no subscribable event carries pane bytes                  FAILS
//
// `events.subscribe` accepts pane.updated, pane.output_matched,
// pane.agent_status_changed and pane.scroll_changed. A subscription starts
// cleanly and then delivers NOTHING across repeated real output: pane.updated
// does not fire for output. The event that would carry it,
// `pane_output_changed`, exists in the schema's event enum but is absent from
// the Subscription union — the server emits it internally and no client can
// subscribe.
//
// Hosting a terminal that way would therefore mean polling full-screen
// snapshots. That is lossy by construction (anything that scrolls past between
// polls is gone) and incompatible with feeding an incremental ANSI parser, so
// it is worse than what Cookrew has rather than a migration.
//
// THE REFRAME THAT CHANGES THE VERDICT
// ------------------------------------
// Both findings above answer "can herdr replace the BYTE STREAM?". That is the
// wrong question. The byte stream is not a requirement — it is an artefact of
// tmux being dumb about agents, which is why a scraper had to exist at all.
//
// Ask instead what the scraper INFERS, and where that data really lives:
//
//   turn boundaries, replies, tools -> the agent's own session file, already
//                                      the source of truth (turns: 'file')
//   phase / attention               -> pane.agent_status_changed (streams;
//                                      verified, and herdr's OWN detector
//                                      corrected a real claude TUI ~100ms
//                                      after our reported state)
//   quiescence for `cookrew ask`    -> agent wait --status idle (~10ms)
//   the screen                      -> ANSI snapshot poll, DISPLAY ONLY
//
// That dissolves the fidelity objection. Snapshot polling looks lossy only if
// the scraper runs on it. Move parsing to the session file and state to
// herdr's protocol, and the snapshot only has to be good enough to LOOK at —
// a terminal display is a screen, and a screen is what herdr returns.
//
// So the path to hosting is real, and it runs through DELETING the scraper
// rather than through finding a byte stream to feed it. What remains for
// `opencode` alone is scrape-only by declaration (no session file), which is
// exactly the harness capability the registry already models.
//
// AND THEN IT WAS REOPENED — SEE herdr-host-multiplexer.ts
// --------------------------------------------------------
// The paragraph above used to end "both routes are closed in 0.8.0; reopening
// either needs a change upstream, not another attempt here." That was wrong,
// and nothing upstream changed. A THIRD route was never tried: `agent attach`
// against a Cookrew-owned config with herdr's chrome switched off, typing into
// the client's stdin rather than pushing over the socket. It is pane-scoped,
// echoes at 27ms, emits 0 bytes when idle, and its session survives the client
// being killed.
//
// Both measurements in this header remain true. The conclusion drawn from them
// did not survive, because both experiments held herdr's UI configuration
// fixed and only one of them fed input the way Cookrew does.
//
// So: `capabilities.attach` is false FOR THIS BACKEND, `attachSpawn` throws,
// and the selector will not make it primary. It is a read-side accelerator.
// HerdrHostMultiplexer is the tmux replacement.

import { execFileSync, spawnSync } from 'node:child_process'
import type {
  AttachSpawn,
  CommandRunner,
  Multiplexer,
  MultiplexerCapabilities,
  PaneLaunch,
  ScrollState
} from './multiplexer'

/** Wire protocol this module was written against (`herdr api schema`). */
export const HERDR_PROTOCOL = 19

/**
 * A workspace switch fires a BURST of herdr calls (PTY teardown + spawn per
 * terminal). Under that burst the client socket can return EAGAIN — "Resource
 * temporarily unavailable (os error 35)" — which the CLI surfaces as "lost
 * connection to server" even though the server is healthy and the pane is alive.
 * It is transient contention, not a dead server, so the right answer is to
 * retry the call, not to tear down the attach. Anything else is caught here too
 * (a real failure) and rethrown after the last attempt.
 */
const TRANSIENT = /os error 35|temporarily unavailable|resource temporarily|\beagain\b/i

export function isTransientHerdrError(err: unknown): boolean {
  const e = err as { code?: string; stderr?: unknown; message?: unknown } | null
  if (e?.code === 'EAGAIN') return true
  return TRANSIENT.test(`${String(e?.stderr ?? '')} ${String(e?.message ?? '')}`)
}

/** Synchronous sleep — execFileSync is sync, so the backoff must be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `exec`, retrying ONLY a transient EAGAIN with a short growing backoff.
 * A non-transient failure throws immediately; a transient one that never clears
 * throws after the last attempt, so a genuinely dead server still surfaces.
 */
export function runWithHerdrRetry<T>(exec: () => T, attempts = 4): T {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return exec()
    } catch (err) {
      last = err
      if (i === attempts - 1 || !isTransientHerdrError(err)) throw err
      sleepSync(25 * (i + 1))
    }
  }
  throw last
}

export const herdrRunner: CommandRunner = {
  run: (file, args) =>
    runWithHerdrRetry(() =>
      execFileSync(file, args, {
        encoding: 'utf8',
        // stderr PIPED (was ignored) so a thrown error carries the herdr
        // message, and the EAGAIN retry above can see it.
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000
      })
    ),
  runQuiet: (file, args) => {
    try {
      execFileSync(file, args, { stdio: 'ignore', timeout: 2000 })
    } catch {
      // best effort by contract
    }
  },
  probe: (file, args) => {
    // Retried too: a transient EAGAIN here would report herdr UNAVAILABLE and
    // trip the tmux fallback — the exact wrong outcome under switch contention.
    try {
      return runWithHerdrRetry(() => {
        const r = spawnSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 2000 })
        if (r.error) throw r.error
        // A non-zero exit with an EAGAIN message is transient; surface it so the
        // retry catches it rather than reporting a clean "unavailable".
        if (r.status !== 0 && isTransientHerdrError({ stderr: r.stderr })) {
          throw Object.assign(new Error('herdr probe transient'), { stderr: r.stderr })
        }
        return r.status === 0
      })
    } catch {
      return false
    }
  }
}

interface HerdrScroll {
  offset_from_bottom?: number
  max_offset_from_bottom?: number
  viewport_rows?: number
}

interface HerdrPane {
  pane_id?: string
  terminal_id?: string
  agent?: string
  agent_status?: string
  cwd?: string
  scroll?: HerdrScroll | null
}

/** Every CLI response is `{ id, result }` or `{ id, error }`. */
function resultOf<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const body = parsed as { result?: unknown; error?: unknown }
    if (body.error !== undefined || body.result === undefined) return null
    return body.result as T
  } catch {
    return null
  }
}

/**
 * herdr's scroll model → Cookrew's.
 *
 * `offset_from_bottom` is lines scrolled UP from the live tail, which is
 * exactly tmux's scroll_position. `max_offset_from_bottom` is how far up it
 * COULD go, i.e. the scrollback depth beyond the viewport — the closest
 * analogue of history_size, and the signal checkpoint ordering depends on.
 *
 * The +viewport_rows term matters: tmux's history_size counts lines that have
 * scrolled OUT of the viewport, so the comparable total includes the rows
 * currently on screen. Verified live: a pane holding 120 wrapped lines
 * reported max_offset_from_bottom 194 with 47 viewport rows.
 */
export function toScrollState(scroll: HerdrScroll | null | undefined): ScrollState {
  if (!scroll || typeof scroll.max_offset_from_bottom !== 'number') {
    return { scrollRow: null, historySize: null }
  }
  const offset = scroll.offset_from_bottom
  return {
    // 0 means "at the bottom"; Cookrew reserves null for "not browsing at
    // all", which herdr does not distinguish — so a live pane reads as 0.
    scrollRow: typeof offset === 'number' ? offset : null,
    historySize: scroll.max_offset_from_bottom + (scroll.viewport_rows ?? 0)
  }
}

export interface HerdrOptions {
  runner?: CommandRunner
  /** Binary name/path; overridable for tests and unusual installs. */
  bin?: string
}

export class HerdrMultiplexer implements Multiplexer {
  readonly id = 'herdr'

  readonly capabilities: MultiplexerCapabilities = {
    // Measured, not assumed — see the header.
    attach: false,
    // No copy-mode search in the socket API. `wait output --match` searches
    // for text but does not SCROLL the pane to it, which is what the
    // checkpoint jump needs.
    copyModeSearch: false,
    // Read-only backend: it holds no PTY to write wheel events into.
    wheelScrollback: false,
    monotonicHistory: true,
    // herdr's server does own its panes across restarts — but it cannot host
    // a Cookrew terminal, so this never applies in practice.
    persistsAcrossRestart: true,
    // Reads only; it never hosts, so it has no agent to report a state for.
    agentLifecycle: false
  }

  private readonly runner: CommandRunner
  private readonly bin: string
  private probed: boolean | null = null

  constructor(options: HerdrOptions = {}) {
    this.runner = options.runner ?? herdrRunner
    this.bin = options.bin ?? 'herdr'
  }

  available(): boolean {
    if (this.probed === null) {
      // `status` needs no server; it reports whether one is running. A herdr
      // that is installed but has no server is still unusable for reads, so
      // both conditions are checked together.
      const raw = this.tryRun(['status'])
      this.probed = raw !== null && /status:\s*running/.test(raw)
    }
    return this.probed
  }

  private tryRun(args: string[]): string | null {
    try {
      return this.runner.run(this.bin, args)
    } catch {
      return null
    }
  }

  private panes(): HerdrPane[] {
    const raw = this.tryRun(['pane', 'list'])
    if (raw === null) return []
    return resultOf<{ panes?: HerdrPane[] }>(raw)?.panes ?? []
  }

  /**
   * Cookrew addresses sessions by NAME; herdr addresses panes by id. A pane is
   * matched on its terminal_id, which is the stable identity herdr exposes.
   */
  private paneFor(name: string): HerdrPane | null {
    return this.panes().find((p) => p.terminal_id === name || p.pane_id === name) ?? null
  }

  sessionExists(name: string): boolean {
    return this.paneFor(name) !== null
  }

  listSessions(): string[] {
    return this.panes()
      .map((p) => p.terminal_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }

  killSession(name: string): void {
    const pane = this.paneFor(name)
    if (pane?.pane_id) this.runner.runQuiet(this.bin, ['pane', 'close', pane.pane_id])
  }

  /** Never hosts, so there is never a session of its own to create. */
  ensureSession(): void {}

  attachSpawn(): AttachSpawn {
    // Deliberately fatal rather than degraded. A silent fallback here would
    // hand node-pty a TUI stream and the failure would surface much later, as
    // a scraper producing nonsense.
    //
    // NOTE: this backend reads with `session attach`, which really does return
    // the TUI. It is NOT the last word on herdr hosting — see
    // herdr-host-multiplexer.ts, where `agent attach` against a chrome-free
    // config was measured to be pane-scoped, echoing and quiet. Use that one to
    // host; this one only reads.
    throw new Error(
      'this herdr backend is read-only: use HerdrHostMultiplexer to host a terminal. ' +
        'Check capabilities.attach before selecting a backend.'
    )
  }

  /**
   * `recent-unwrapped` is the point of this backend: LOGICAL lines rather than
   * physical rows, so a wrapped reply arrives whole.
   */
  capture(name: string): string | null {
    const pane = this.paneFor(name)
    if (!pane?.pane_id) return null
    // `pane read` is the ONE command that does not use the {id,result} JSON
    // envelope — it writes the pane text straight to stdout. Parsing it as
    // JSON silently yielded null for every capture, which reads downstream as
    // "the pane is empty" rather than as a failure.
    const raw = this.tryRun([
      'pane', 'read', pane.pane_id,
      '--source', 'recent-unwrapped',
      '--lines', '200',
      '--format', 'text'
    ])
    // An empty pane legitimately returns zero bytes; '' is data, not absence.
    return raw
  }

  scrollState(name: string): ScrollState {
    return toScrollState(this.paneFor(name)?.scroll)
  }

  panePid(): number | null {
    // `pane process-info` exists but was not verified against a real agent
    // pane; returning null is honest and callers already degrade.
    return null
  }

  paneLaunch(): PaneLaunch | null {
    return null
  }

  jumpToText(): void {
    // capabilities.copyModeSearch is false; callers must check it. A no-op
    // here is correct — it never pretends to have scrolled.
  }

  exitCopyMode(): void {
    // Nothing to leave: herdr has no copy-mode.
  }

  reloadConfig(): void {
    this.runner.runQuiet(this.bin, ['server', 'reload-config'])
  }
}
