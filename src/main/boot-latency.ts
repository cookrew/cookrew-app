// terminal.booted — spawn → the agent is ACTUALLY there.
//
// WHY THIS METRIC WAS SKIPPED THE FIRST TIME
// ------------------------------------------
// The p95/p98 program shipped turn.completed and workspace.switched and
// consciously left this one out, because the only ready signal on offer was
// the fork-quiescence probe: wait for the pane to stop painting, give up after
// 25s. Both halves are unusable for a latency metric. Quiescence measures when
// an agent stopped talking, not when it became reachable — on a REATTACH it
// measures how long the previous conversation happens to stay quiet. And a
// give-up would have entered the log as a real 25000ms sample, inventing a P98
// tail out of a timeout. A fabricated tail is worse than no metric, because the
// panel gives you no way to tell them apart.
//
// THE SIGNAL USED INSTEAD
// -----------------------
// herdr tracks agent lifecycle for the panes it hosts and PUSHES every
// transition (see herdr-agent-status.ts). A freshly created pane has no agent
// state at all — Cookrew's own report-agent writes `unknown`, then releases
// authority so herdr's detector takes over. The detector cannot see an agent
// until one is running and painting, so the FIRST known state herdr reports for
// a new pane — idle, working, blocked or done, any of them — is the moment the
// agent exists. That is the ready signal: pushed, not polled, and produced by
// the thing being measured rather than inferred from silence.
//
// WHAT IS DELIBERATELY NOT RECORDED
// ---------------------------------
//   reattach — an existing pane is handed back, not booted. The caller
//              discriminates (sessionExists) and never opens a sample.
//   timeout  — the window closes and the sample is DROPPED. No event, no
//              duration, no row. The absence of a sample is the honest report.
//   exit     — a terminal that dies before it is ready never booted.
//
// Every one of those is silence rather than a number, which is the whole
// discipline this module exists to hold.

import { EventEmitter } from 'node:events'

/** One measured boot, ready to enter the log through the store choke-point. */
export interface BootSample {
  terminalId: string
  durationMs: number
}

export interface BootLatencyOptions {
  /**
   * How long a pending boot may wait for its ready signal before the sample is
   * abandoned.
   *
   * Short on purpose. The spawn path is synchronous up to the point where the
   * agent process has been exec'd, so a real ready signal lands within a beat
   * of it. A generous window would not catch slower boots so much as it would
   * catch the WRONG transition: a pane whose detector never fires would sit
   * pending until the user's first prompt flipped it to `working`, and the log
   * would then call "time until a human typed something" a boot latency.
   */
  timeoutMs?: number
  /** Injected for tests; the real clock otherwise. */
  now?: () => number
}

interface Pending {
  terminalId: string
  startedAt: number
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Is this spawn one that may be timed at all? Both halves are refusals:
 *
 *   hasReadySignal — false on a backend with no agent lifecycle (tmux,
 *     direct). Those can report that a pane EXISTS, never that the agent
 *     inside it came up, and a metric meaning different things per backend is
 *     worse than one that is honestly absent. terminal.booted is herdr-only.
 *   sessionExists — true means the multiplexer is about to hand back a pane
 *     that is already running. The agent in it booted minutes or days ago;
 *     what a sample would measure is the attach, under a name that claims it
 *     measured a boot.
 *
 * Pure, because it is the whole policy and the wiring around it (an Electron
 * main-process module) cannot be reached from a test.
 */
export function shouldTimeBoot(probe: { hasReadySignal: boolean; sessionExists: boolean }): boolean {
  return probe.hasReadySignal && !probe.sessionExists
}

/**
 * Pending cold boots, keyed by multiplexer session name — which is what the
 * status feed reports, and the only identity the two ends share.
 *
 * Emits 'booted' with a BootSample. Emits nothing else, ever: there is no
 * 'timeout' or 'failed' event, because a consumer that heard one would be
 * tempted to record it.
 */
export class BootLatency extends EventEmitter {
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(options: BootLatencyOptions = {}) {
    super()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  /** Terminals currently being timed — for tests and leak checks. */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Start the clock for a COLD spawn. The caller owns that judgement: this has
   * no way to tell a new pane from a reattached one, and guessing would be
   * exactly the failure the module exists to avoid.
   */
  begin(sessionName: string, terminalId: string): void {
    // A second begin for the same session is a second boot (killed and
    // respawned in the same breath). The earlier sample is abandoned rather
    // than resolved by whatever the new pane does.
    this.cancel(sessionName)
    const timer = setTimeout(() => {
      // Drop it. NOT a sample of `timeoutMs` — see the header.
      this.pending.delete(sessionName)
    }, this.timeoutMs)
    // Never hold the app open for a boot nobody is waiting on.
    timer.unref?.()
    this.pending.set(sessionName, { terminalId, startedAt: this.now(), timer })
  }

  /**
   * The agent is there. Emits at most once per begin(); a session with no
   * pending boot is a reattach, an unrelated pane, or a status change long
   * after the window closed — all of them silence.
   */
  ready(sessionName: string): void {
    const entry = this.pending.get(sessionName)
    if (!entry) return
    this.forget(sessionName, entry)
    const durationMs = this.now() - entry.startedAt
    // A clock that went backwards produces no event rather than a duration the
    // percentile math would have to defend itself against.
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.emit('booted', { terminalId: entry.terminalId, durationMs } satisfies BootSample)
  }

  /** Abandon a pending boot — the terminal died, or is being torn down. */
  cancel(sessionName: string): void {
    const entry = this.pending.get(sessionName)
    if (entry) this.forget(sessionName, entry)
  }

  /** Abandon everything (app quit). */
  cancelAll(): void {
    for (const [name, entry] of this.pending) this.forget(name, entry)
  }

  private forget(sessionName: string, entry: Pending): void {
    clearTimeout(entry.timer)
    this.pending.delete(sessionName)
  }
}
