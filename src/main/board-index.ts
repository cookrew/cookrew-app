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
// is detached. Measured baseline: 19 sessions scanned in ~107 ms, so at a 3 s
// period the duty cycle is ~3.6%.
// ---------------------------------------------------------------------------

/** Sampling period. 107 ms per full scan / 3 s ⇒ well under a 5% duty cycle. */
export const PROBE_INTERVAL_MS = 3000

export interface ProbeDeps {
  /** Live tmux session names under the cookrew socket. */
  listSessions: () => string[]
  /** Visible pane text for a session name; '' when it cannot be read. */
  capturePane: (sessionName: string) => string
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

/**
 * One sampling pass. Reports ONLY the two phases this layer can actually
 * establish — 'working' and 'waiting'. An idle detached pane is deliberately
 * omitted rather than guessed at, so the ledger layer keeps deciding between
 * unread/offline instead of the probe inventing a completion it never saw.
 *
 * herdr is consulted FIRST where the backend can answer: a status that is
 * asked beats one inferred from pixels. Its working/blocked map straight onto
 * the two probe phases. An idle/done answer sets nothing AND suppresses the
 * scrape — a detached pane's last painted frame can hold a stale spinner
 * forever, and frozen pixels must not overrule an answer — while still never
 * clearing an unread marker, because omission leaves that call to the ledger.
 * Null means no signal, and the capture-pane path decides exactly as before.
 */
export function probeOnce(deps: ProbeDeps): Map<string, BoardPhase> {
  const phases = new Map<string, BoardPhase>()
  const live = new Set(deps.listSessions())
  if (live.size === 0) return phases
  for (const terminalId of deps.knownTerminalIds()) {
    if (deps.isAttached(terminalId)) continue // L1 already has full fidelity
    const session = deps.sessionNameFor(terminalId)
    if (!live.has(session)) continue // no pane at all → a ledger row
    const asked = deps.askedStatus?.(terminalId) ?? null
    if (asked !== null) {
      if (asked === 'working') phases.set(terminalId, 'working')
      else if (asked === 'blocked') phases.set(terminalId, 'waiting')
      continue
    }
    const chunk = deps.capturePane(session)
    if (chunk.length === 0) continue
    if (deps.detectWorking(chunk)) phases.set(terminalId, 'working')
    else if (deps.detectWaiting(chunk.split('\n'))) phases.set(terminalId, 'waiting')
  }
  return phases
}

/** True when at least one known terminal has a tmux session but no live pty. */
export function hasDetachedSessions(deps: ProbeDeps): boolean {
  const live = new Set(deps.listSessions())
  if (live.size === 0) return false
  return deps
    .knownTerminalIds()
    .some((id) => !deps.isAttached(id) && live.has(deps.sessionNameFor(id)))
}

export interface ProbeSampler {
  /** Latest sampled phases — what BoardSources.probe hands to mergeBoard. */
  phases: () => Map<string, BoardPhase>
  /** Begin periodic sampling (idempotent). */
  start: () => void
  stop: () => void
  /** Run one pass now; returns the fresh map (used by tests and first paint). */
  sampleNow: () => Map<string, BoardPhase>
  readonly running: boolean
}

/**
 * Periodic single-flight sampler. Self-stopping: a pass that finds nothing
 * detached parks the timer, so an idle machine pays nothing. Callers restart
 * it when the board is next requested.
 */
export function createProbeSampler(
  deps: ProbeDeps,
  intervalMs: number = PROBE_INTERVAL_MS
): ProbeSampler {
  let latest = new Map<string, BoardPhase>()
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = false
  let lastSampleAt = 0

  const sampleNow = (): Map<string, BoardPhase> => {
    if (inFlight) return latest // single-flight: never stack scans
    inFlight = true
    lastSampleAt = Date.now()
    try {
      latest = probeOnce(deps)
    } catch (error) {
      console.error('Board probe failed:', error)
    } finally {
      inFlight = false
    }
    return latest
  }

  const tick = (): void => {
    sampleNow()
    // Nothing detached → stop burning a timer until someone asks again.
    if (latest.size === 0 && !hasDetachedSessions(deps)) sampler.stop()
  }

  const sampler: ProbeSampler = {
    phases: () => latest,
    sampleNow,
    start: (): void => {
      if (timer) return
      if (Date.now() - lastSampleAt >= intervalMs) sampleNow()
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
    knownTerminalIds: runtime.knownTerminalIds,
    isAttached: runtime.isAttached,
    sessionNameFor,
    detectWorking: detectLiveWork,
    detectWaiting: detectAttention,
    askedStatus: askedAgentStatus
  }
}
