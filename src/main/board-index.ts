// Activity Board collectors (main side of docs/briefs/agent-activity-board-design.html).
//
// src/shared/board.ts owns the MERGE RULES and stays pure. This module owns
// the three-layer COLLECTION that feeds it, plus the request-path concerns
// the merge must not know about: window parsing and change debouncing.
//
//   L1 live   TurnTracker.list()          active workspace, full fidelity
//   L2 probe  tmux capture-pane sampling  PHASE ONLY — P4 wires it; empty here
//   L3 ledger TurnStore.loadAll()         every terminal ever, cached
//
// Sources are declared as narrow function bags rather than the concrete
// TurnTracker/TurnStore/AgentRegistry classes so the board can be exercised
// with plain fakes — no Electron, no filesystem, no tmux.

import {
  BOARD_WINDOW_MS,
  BOARD_WINDOW_WIDE_MS,
  mergeBoard,
  summarizeBoard,
  type BoardAgentMeta,
  type BoardPhase,
  type BoardRow,
  type BoardSummary
} from '../shared/board'
import { performance } from 'node:perf_hooks'
import { detectAttention, detectLiveWork } from '../shared/turn'
import type { TerminalActivity, TurnRecord } from '../shared/turn'
import { agentStatus, type HerdrStatus } from './herdr-agent-status'
import { multiplexer, sessionNameFor } from './pty'

/** What GET /api/board returns, and what the SSE 'board' event carries. */
export interface BoardSnapshot {
  rows: BoardRow[]
  summary: BoardSummary
  activeWorkspaceId: string
}

/** The three layers plus identity, each read lazily at snapshot time. */
export interface BoardSources {
  /** Workspace currently loaded — marks rows `workspace.active`. */
  activeWorkspaceId: () => string
  /** L1: TurnTracker.list(). */
  live: () => TerminalActivity[]
  /** L3: the whole persisted ledger, terminalId → history. */
  ledger: () => Map<string, TurnRecord[]>
  /** Every known agent, across all workspaces. */
  registry: () => BoardAgentMeta[]
  /**
   * L2: terminalId → phase from sampling detached panes. Optional on purpose —
   * P4 owns the tmux sampler; until then the board is live+ledger only, which
   * degrades a detached-but-working agent to its last known task rather than
   * inventing a phase.
   */
  probe?: () => Map<string, BoardPhase>
  /** Injectable clock so windowing is testable. */
  now?: () => number
}

/** Query values accepted by GET /api/board?window=. */
export type BoardWindow = '24h' | '7d'

/** Window in ms for a `?window=` value; anything unrecognized → the default. */
export function boardWindowMs(window?: string | null): number {
  return window === '7d' ? BOARD_WINDOW_WIDE_MS : BOARD_WINDOW_MS
}

/** How long board changes coalesce before an SSE push. */
export const BOARD_EVENT_DEBOUNCE_MS = 500

/**
 * Assemble the board from its sources. One place so the HTTP route and the
 * SSE push can never drift into computing it differently.
 */
export function buildBoard(sources: BoardSources, windowMs = BOARD_WINDOW_MS): BoardSnapshot {
  const activeWorkspaceId = sources.activeWorkspaceId()
  const rows = mergeBoard({
    live: sources.live(),
    probe: sources.probe?.() ?? new Map<string, BoardPhase>(),
    ledger: sources.ledger(),
    registry: sources.registry(),
    activeWorkspaceId,
    now: sources.now?.() ?? Date.now(),
    windowMs
  })
  return { rows, summary: summarizeBoard(rows), activeWorkspaceId }
}

/** Minimal shapes of the main-process singletons the adapter needs. */
export interface BoardRuntime {
  store: { readonly focusedId: string }
  turns: { list: () => TerminalActivity[] }
  turnStore: { loadAll: () => Map<string, TurnRecord[]> }
  agents: { list: () => readonly BoardAgentMeta[] }
  probe?: () => Map<string, BoardPhase>
}

/**
 * Adapt the live main-process objects to BoardSources. AgentRegistryEntry is
 * a structural superset of BoardAgentMeta; the projection is explicit so the
 * registry can grow fields without silently widening the board contract.
 */
export function boardSourcesFrom(runtime: BoardRuntime): BoardSources {
  return {
    activeWorkspaceId: () => runtime.store.focusedId,
    live: () => runtime.turns.list(),
    ledger: () => runtime.turnStore.loadAll(),
    registry: () =>
      runtime.agents.list().map((entry) => ({
        id: entry.id,
        name: entry.name,
        preset: entry.preset,
        role: entry.role,
        cwd: entry.cwd,
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        orch: entry.orch,
        active: entry.active
      })),
    ...(runtime.probe ? { probe: runtime.probe } : {})
  }
}

// ---------------------------------------------------------------------------
// L2 probe — phase for panes the TurnTracker cannot see.
//
// A workspace switch detaches its terminals, so TurnTracker (and /api/activity)
// only ever covers the ACTIVE workspace. Without this layer an inactive
// workspace shows history only, and the wall cannot answer the one question it
// exists for: who is stuck RIGHT NOW.
//
// Cost discipline: only DETACHED sessions are captured (attached ones are
// already L1), the sampler is single-flight, and it stops itself when nothing
// is detached. The inventory is read ONCE per tick and, where the backend has
// an async runner, every read of a tick is awaited rather than forked inline:
// the 2026-09-06 baseline (perf/tempo) was 2 + N synchronous herdr children
// per tick on Electron main, N = 38 detached panes without a herdr status,
// each 30-300 ms under load — the stall behind the program's 3 s API p95.
// ---------------------------------------------------------------------------

/** Sampling period. 107 ms per full scan / 3 s ⇒ well under a 5% duty cycle. */
export const PROBE_INTERVAL_MS = 3000

export interface ProbeDeps {
  /** Live tmux session names under the cookrew socket. */
  listSessions: () => string[]
  /** Visible pane text for a session name; '' when it cannot be read. */
  capturePane: (sessionName: string) => string
  /**
   * The same two reads OFF the main thread. When both are present the
   * sampler's periodic tick awaits them instead of forking inline: on the
   * live machine every tick was two synchronous `herdr pane list` children
   * plus one `pane read` per detached pane without a herdr status (38 of 56
   * panes, 2026-09-06), and each child under load held Electron main for
   * 30-300 ms — the stalls the perf program measured as a 3 s API p95.
   * Absent (tmux, direct), the sync reads stay exactly as before.
   */
  listSessionsAsync?: () => Promise<string[]>
  capturePaneAsync?: (sessionName: string) => Promise<string>
  /** Terminal ids worth probing (the registry's agents). */
  knownTerminalIds: () => string[]
  /** True when a live pty already covers this terminal — L1 wins, skip it. */
  isAttached: (terminalId: string) => boolean
  /** terminalId → tmux session name. */
  sessionNameFor: (terminalId: string) => string
  /** Phase classifiers (src/shared/turn.ts), injected so this stays testable. */
  detectWorking: (chunk: string) => boolean
  detectWaiting: (lines: string[]) => boolean
  /**
   * herdr's pushed agent state for this terminal, or null for "no signal".
   * Optional because only a backend with `agentLifecycle` can answer; when
   * absent (or null) the pane scrape below keeps deciding, exactly as before.
   */
  askedStatus?: (terminalId: string) => HerdrStatus | null
}

/** One terminal the probe will look at: a live pane with no pty over it. */
export interface DetachedTerminal {
  terminalId: string
  session: string
}

/**
 * THE PROBE'S REACH: the detached set, computed once from one inventory.
 *
 * Every known terminal is considered, but only the ones with a live pane and
 * no pty survive — attached terminals are L1's, paneless ones the ledger's.
 * The walk is in-memory set lookups; what this function pins is that the
 * inventory (`live`) is read ONCE per pass and shared with the self-stop
 * check, where before each tick listed the panes twice.
 */
export function detachedTerminals(deps: ProbeDeps, live: ReadonlySet<string>): DetachedTerminal[] {
  if (live.size === 0) return []
  const out: DetachedTerminal[] = []
  for (const terminalId of deps.knownTerminalIds()) {
    if (deps.isAttached(terminalId)) continue // L1 already has full fidelity
    const session = deps.sessionNameFor(terminalId)
    if (!live.has(session)) continue // no pane at all → a ledger row
    out.push({ terminalId, session })
  }
  return out
}

/**
 * herdr's answer as a probe phase. `null` = no signal (scrape decides);
 * `undefined` = herdr said idle/done, which sets nothing AND suppresses the
 * scrape — a detached pane's last painted frame can hold a stale spinner
 * forever, and frozen pixels must not overrule an answer.
 */
function phaseFromAsked(asked: HerdrStatus | null): BoardPhase | null | undefined {
  if (asked === null) return null
  if (asked === 'working') return 'working'
  if (asked === 'blocked') return 'waiting'
  return undefined
}

/** The scrape: only the two phases pixels can actually establish. */
function phaseFromPane(deps: ProbeDeps, chunk: string): BoardPhase | undefined {
  if (chunk.length === 0) return undefined
  if (deps.detectWorking(chunk)) return 'working'
  if (deps.detectWaiting(chunk.split('\n'))) return 'waiting'
  return undefined
}

/**
 * One sampling pass over an already-computed detached set. Reports ONLY the
 * two phases this layer can actually establish — 'working' and 'waiting'. An
 * idle detached pane is deliberately omitted rather than guessed at, so the
 * ledger layer keeps deciding between unread/offline instead of the probe
 * inventing a completion it never saw.
 *
 * herdr is consulted FIRST where the backend can answer: a status that is
 * asked beats one inferred from pixels (see phaseFromAsked). Null means no
 * signal, and the capture-pane path decides exactly as before.
 */
export function probeDetached(deps: ProbeDeps, detached: readonly DetachedTerminal[]): Map<string, BoardPhase> {
  const phases = new Map<string, BoardPhase>()
  for (const { terminalId, session } of detached) {
    const asked = phaseFromAsked(deps.askedStatus?.(terminalId) ?? null)
    if (asked !== null) {
      if (asked !== undefined) phases.set(terminalId, asked)
      continue
    }
    const phase = phaseFromPane(deps, deps.capturePane(session))
    if (phase) phases.set(terminalId, phase)
  }
  return phases
}

/**
 * The same pass with the pane reads awaited, sequentially: one child at a
 * time, so a detached fleet of forty is forty short waits libuv owns rather
 * than forty forks Electron main owns. Falls back to the sync read where no
 * async one was given, so a backend without one behaves exactly as before.
 */
export async function probeDetachedAsync(
  deps: ProbeDeps,
  detached: readonly DetachedTerminal[]
): Promise<Map<string, BoardPhase>> {
  const phases = new Map<string, BoardPhase>()
  for (const { terminalId, session } of detached) {
    const asked = phaseFromAsked(deps.askedStatus?.(terminalId) ?? null)
    if (asked !== null) {
      if (asked !== undefined) phases.set(terminalId, asked)
      continue
    }
    const chunk = deps.capturePaneAsync ? await deps.capturePaneAsync(session) : deps.capturePane(session)
    const phase = phaseFromPane(deps, chunk)
    if (phase) phases.set(terminalId, phase)
  }
  return phases
}

/**
 * One sampling pass from an inventory read here (or one handed in, so a
 * caller that already listed the panes does not list them again).
 */
export function probeOnce(deps: ProbeDeps, live: ReadonlySet<string> = new Set(deps.listSessions())): Map<string, BoardPhase> {
  return probeDetached(deps, detachedTerminals(deps, live))
}

/** True when at least one known terminal has a tmux session but no live pty. */
export function hasDetachedSessions(deps: ProbeDeps, live: ReadonlySet<string> = new Set(deps.listSessions())): boolean {
  return detachedTerminals(deps, live).length > 0
}

export interface ProbeSampler {
  /** Latest sampled phases — what BoardSources.probe hands to mergeBoard. */
  phases: () => Map<string, BoardPhase>
  /** Begin periodic sampling (idempotent). */
  start: () => void
  stop: () => void
  /** Run one SYNCHRONOUS pass now; returns the fresh map (tests, sync backends). */
  sampleNow: () => Map<string, BoardPhase>
  /**
   * One pass on the async reads when the deps have them (else sampleNow).
   * What the periodic tick runs; exposed so a test can await a tick.
   */
  sampleAsync: () => Promise<Map<string, BoardPhase>>
  readonly running: boolean
}

export interface ProbeSamplerOptions {
  /**
   * Called with how long each pass held the MAIN THREAD, in ms — the
   * loop-health seam. For a synchronous pass that is its wall time; for an
   * async pass it is the loop's active time across the pass (an upper bound:
   * other work in the same span counts too), never the wall time of the
   * awaits, which would name this loop for stalls it did not cause.
   */
  observe?: (ms: number) => void
}

/**
 * Periodic single-flight sampler. Self-stopping: a pass that finds nothing
 * detached parks the timer, so an idle machine pays nothing. Callers restart
 * it when the board is next requested.
 *
 * The tick reads the inventory ONCE and derives both the phases and the
 * "anything detached?" decision from it. With async reads available the tick
 * awaits them, and the single-flight latch spans the whole awaited pass: a
 * pass longer than the interval means the next interval is skipped, never
 * stacked. The first read after start() may therefore answer with the
 * previous pass — the same "last known" degrade the board already documents
 * for a probe that has not run yet.
 */
export function createProbeSampler(
  deps: ProbeDeps,
  intervalMs: number = PROBE_INTERVAL_MS,
  options: ProbeSamplerOptions = {}
): ProbeSampler {
  let latest = new Map<string, BoardPhase>()
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = false
  let lastSampleAt = 0
  /** Whether the last pass found anything to look at — the self-stop input. */
  let lastDetached = 0
  const usesAsync = typeof deps.listSessionsAsync === 'function'

  const sampleNow = (): Map<string, BoardPhase> => {
    if (inFlight) return latest // single-flight: never stack scans
    inFlight = true
    lastSampleAt = Date.now()
    const started = performance.now()
    try {
      const detached = detachedTerminals(deps, new Set(deps.listSessions()))
      lastDetached = detached.length
      latest = probeDetached(deps, detached)
    } catch (error) {
      console.error('Board probe failed:', error)
    } finally {
      inFlight = false
      options.observe?.(performance.now() - started)
    }
    return latest
  }

  const sampleAsync = async (): Promise<Map<string, BoardPhase>> => {
    if (!usesAsync) return sampleNow()
    if (inFlight) return latest
    inFlight = true
    lastSampleAt = Date.now()
    const base = performance.eventLoopUtilization()
    try {
      const detached = detachedTerminals(deps, new Set(await deps.listSessionsAsync!()))
      lastDetached = detached.length
      latest = await probeDetachedAsync(deps, detached)
    } catch (error) {
      console.error('Board probe failed:', error)
    } finally {
      inFlight = false
      options.observe?.(performance.eventLoopUtilization(base).active)
    }
    return latest
  }

  const settle = (): void => {
    // Nothing detached → stop burning a timer until someone asks again.
    if (latest.size === 0 && lastDetached === 0) sampler.stop()
  }

  const tick = (): void => {
    // A tick that lands while a pass is still in flight is simply skipped —
    // it must not settle either, or an empty `latest` would park the sampler
    // on a verdict no pass has reached yet.
    if (inFlight) return
    if (usesAsync) {
      void sampleAsync().then(settle)
      return
    }
    sampleNow()
    settle()
  }

  const sampler: ProbeSampler = {
    phases: () => latest,
    sampleNow,
    sampleAsync,
    start: (): void => {
      if (timer) return
      if (Date.now() - lastSampleAt >= intervalMs) {
        if (usesAsync) void sampleAsync()
        else sampleNow()
      }
      timer = setInterval(tick, intervalMs)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        ;(timer as { unref: () => void }).unref()
      }
    },
    stop: (): void => {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    get running(): boolean {
      return timer !== null
    }
  }
  return sampler
}

/**
 * Coalesce a burst of board-affecting signals into one push. The activity
 * stream is chatty (every tracker tick), and the board is a whole-fleet
 * recompute — pushing per tick would be the expensive mistake.
 */
export function createBoardNotifier(
  emit: () => void,
  waitMs: number = BOARD_EVENT_DEBOUNCE_MS
): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule: (): void => {
      if (timer) return // already coalescing this burst
      timer = setTimeout(() => {
        timer = null
        emit()
      }, waitMs)
    },
    cancel: (): void => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    }
  }
}

/**
 * herdr's view of this terminal's agent, or null for "no signal".
 *
 * Gated on the CAPABILITY, never the backend's name: a backend that does not
 * model agent lifecycle cannot vouch for whatever the feed still holds, so
 * the answer is no signal and callers keep inferring. The feed itself already
 * answers null for a pane it has never heard of.
 */
export function askedAgentStatus(terminalId: string): HerdrStatus | null {
  if (multiplexer()?.capabilities.agentLifecycle !== true) return null
  return agentStatus(sessionNameFor(terminalId))
}

/**
 * ProbeDeps backed by the real cookrew tmux socket. `capture-pane -p` prints
 * the visible pane; failures degrade to '' (the pane vanished mid-scan), which
 * probeOnce treats as "no signal" rather than a phase.
 */
export function tmuxProbeDeps(runtime: {
  knownTerminalIds: () => string[]
  isAttached: (terminalId: string) => boolean
}): ProbeDeps {
  return {
    // Through the seam: the probe asks the ACTIVE backend, so swapping the
    // multiplexer swaps what the board reads with no change here. A missing
    // backend degrades to "nothing detached to probe", which probeOnce already
    // treats as no signal rather than as a phase.
    listSessions: () => multiplexer()?.listSessions() ?? [],
    capturePane: (sessionName) => multiplexer()?.capture(sessionName) ?? '',
    // The periodic tick takes these. A backend with an async runner (herdr
    // host) answers off the main thread; one without falls through to the
    // sync read inside the same promise, which is no worse than before.
    listSessionsAsync: async () => {
      const mux = multiplexer()
      if (!mux) return []
      return mux.listSessionsAsync ? mux.listSessionsAsync() : mux.listSessions()
    },
    capturePaneAsync: async (sessionName) => {
      const mux = multiplexer()
      if (!mux) return ''
      return (mux.captureAsync ? await mux.captureAsync(sessionName) : mux.capture(sessionName)) ?? ''
    },
    knownTerminalIds: runtime.knownTerminalIds,
    isAttached: runtime.isAttached,
    sessionNameFor,
    detectWorking: detectLiveWork,
    detectWaiting: detectAttention,
    askedStatus: askedAgentStatus
  }
}
