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
  /**
   * The probe's in-flight pass, for a READ that would rather wait a bounded
   * moment than paint the map from before the sampler parked. Optional; a
   * board without it answers from whatever probe() holds.
   */
  probeWarm?: () => Promise<unknown>
  /**
   * Hold the probe open while a consumer exists (the SSE ?board=1 stream, a
   * desktop panel). The last release stops the periodic pass. Optional.
   */
  probeSubscribe?: () => () => void
  /** The probe changed a phase — push the board. Returns the unlisten. */
  probeOnChange?: (listener: () => void) => () => void
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
  turns: { listVerified: () => TerminalActivity[] }
  turnStore: { loadAll: () => Map<string, TurnRecord[]> }
  agents: { list: () => readonly BoardAgentMeta[] }
  probe?: () => Map<string, BoardPhase>
  probeWarm?: () => Promise<unknown>
  probeSubscribe?: () => () => void
  probeOnChange?: (listener: () => void) => () => void
}

/**
 * Adapt the live main-process objects to BoardSources. AgentRegistryEntry is
 * a structural superset of BoardAgentMeta; the projection is explicit so the
 * registry can grow fields without silently widening the board contract.
 */
export function boardSourcesFrom(runtime: BoardRuntime): BoardSources {
  return {
    activeWorkspaceId: () => runtime.store.focusedId,
    // VERIFIED only: L2's probe derives the same herdr status and labels
    // it honestly, so a skeleton here would outrank it while claiming a
    // live tail it does not have.
    live: () => runtime.turns.listVerified(),
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
    ...(runtime.probe ? { probe: runtime.probe } : {}),
    ...(runtime.probeWarm ? { probeWarm: runtime.probeWarm } : {}),
    ...(runtime.probeSubscribe ? { probeSubscribe: runtime.probeSubscribe } : {}),
    ...(runtime.probeOnChange ? { probeOnChange: runtime.probeOnChange } : {})
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

/** What one async pass produced, and how far it got. */
export interface DetachedPass {
  phases: Map<string, BoardPhase>
  /** Terminals looked at before the deadline — the rest were not reached. */
  reached: number
  /** Main-thread time: the sum of the synchronous segments between awaits. */
  heldMs: number
}

/**
 * The same pass with the pane reads awaited, sequentially: one child at a
 * time, so a detached fleet of forty is forty short waits libuv owns rather
 * than forty forks Electron main owns. Falls back to the sync read where no
 * async one was given, so a backend without one behaves exactly as before.
 *
 * Reports how far it got: past the deadline (a wedged backend answers each
 * read at its bound) the pass stops and says so, and the caller decides what
 * the unreached terminals show. Also reports its own main-thread hold — the
 * synchronous segments only, never the awaits, so the number names this
 * loop for what it did and not for what else the loop was doing meanwhile.
 */
export async function runDetachedPass(
  deps: ProbeDeps,
  detached: readonly DetachedTerminal[],
  options: { deadline?: number } = {}
): Promise<DetachedPass> {
  const phases = new Map<string, BoardPhase>()
  let heldMs = 0
  let segment = performance.now()
  let reached = 0
  for (const { terminalId, session } of detached) {
    if (options.deadline !== undefined && Date.now() > options.deadline) break
    reached += 1
    const asked = phaseFromAsked(deps.askedStatus?.(terminalId) ?? null)
    if (asked !== null) {
      if (asked !== undefined) phases.set(terminalId, asked)
      continue
    }
    let chunk: string
    if (deps.capturePaneAsync) {
      const read = deps.capturePaneAsync(session)
      heldMs += performance.now() - segment
      chunk = await read
      segment = performance.now()
    } else {
      chunk = deps.capturePane(session)
    }
    const phase = phaseFromPane(deps, chunk)
    if (phase) phases.set(terminalId, phase)
  }
  heldMs += performance.now() - segment
  return { phases, reached, heldMs }
}

/** The pass's phases alone — the shape callers that do not merge want. */
export async function probeDetachedAsync(
  deps: ProbeDeps,
  detached: readonly DetachedTerminal[],
  options: { deadline?: number } = {}
): Promise<Map<string, BoardPhase>> {
  return (await runDetachedPass(deps, detached, options)).phases
}

/**
 * A truncated pass over the previous map: the terminals it reached take
 * their fresh verdict (including "no phase"), the ones it did not reach keep
 * what the last pass said. Stale beats blank — a wedged herdr must not turn
 * every working agent into a row with no phase.
 */
export function mergePartialPass(
  previous: ReadonlyMap<string, BoardPhase>,
  pass: DetachedPass,
  detached: readonly DetachedTerminal[]
): Map<string, BoardPhase> {
  if (pass.reached >= detached.length) return pass.phases
  const merged = new Map(pass.phases)
  for (const { terminalId } of detached.slice(pass.reached)) {
    const kept = previous.get(terminalId)
    if (kept) merged.set(terminalId, kept)
  }
  return merged
}

/**
 * One sampling pass from an inventory read here (or one handed in, so a
 * caller that already listed the panes does not list them again).
 */
export function probeOnce(
  deps: ProbeDeps,
  live: ReadonlySet<string> = new Set(deps.listSessions())
): Map<string, BoardPhase> {
  return probeDetached(deps, detachedTerminals(deps, live))
}

/** What the sampler has been doing lately — read by /api/health. */
export interface ProbeStats {
  /** Board consumers holding the sampler open (SSE ?board=1 streams, desktop panels). */
  subscribers: number
  /** The current rung of the backoff ladder, ms — PROBE_INTERVAL_MS after any change. */
  intervalMs: number
  /** Whole-fleet passes in the last minute. */
  passesLastMinute: number
  /** Inventory listings (one child each) in the last minute. */
  listingsLastMinute: number
  /** Per-terminal recomputes from events in the last minute. */
  invalidationsLastMinute: number
  everCompleted: boolean
  running: boolean
}

export interface ProbeSampler {
  /** Latest sampled phases — what BoardSources.probe hands to mergeBoard. */
  phases: () => Map<string, BoardPhase>
  /** Begin periodic sampling (idempotent). subscribe() is the normal way in. */
  start: () => void
  stop: () => void
  /** Run one SYNCHRONOUS pass now; returns the fresh map (tests, sync backends). */
  sampleNow: () => Map<string, BoardPhase>
  /**
   * One pass on the async reads when the deps have them (else sampleNow).
   * What the periodic tick runs; exposed so a test can await a tick.
   */
  sampleAsync: () => Promise<Map<string, BoardPhase>>
  /**
   * A ONE-SHOT read's touch: at most one pass (only when nothing is in
   * flight and the last pass is older than the first rung), never the
   * timer. Returns the phases as they stand.
   */
  touch: () => Map<string, BoardPhase>
  /**
   * touch(), then the phases — at once once ANY pass has completed, or once
   * the very first pass lands. What a board READ awaits, bounded by the
   * caller: the first frame ever is not an empty one, and no later read
   * waits on a pass. Completion, not emptiness, is the key: an all-attached
   * fleet has a legitimately empty map forever, and keying on that made
   * every idle board read wait on a live listing.
   */
  warm: () => Promise<Map<string, BoardPhase>>
  /**
   * Hold the sampler open. The periodic pass runs only while at least one
   * subscriber exists; the last one leaving stops the timer even with the
   * whole fleet detached. Returns the release.
   */
  subscribe: () => () => void
  /**
   * An event about ONE terminal (a herdr status push, a turn boundary, an
   * attach or detach): recompute that terminal alone and merge it, without
   * a listing. Any event also resets the backoff ladder to its first rung.
   */
  invalidate: (terminalId: string) => Promise<void>
  /** Fires with the new map whenever a pass or an invalidation changed it. */
  onChange: (listener: (phases: Map<string, BoardPhase>) => void) => () => void
  stats: () => ProbeStats
  readonly running: boolean
}

/** A pass may run at most this many intervals before it reports partial. */
export const PROBE_PASS_DEADLINE_TICKS = 10

/**
 * The fallback tick's backoff ladder. While a pass changes nothing the
 * sampler climbs a rung per pass; a pass that changed something, or any
 * event, drops it back to the first rung. The first rung is
 * PROBE_INTERVAL_MS, so a board that is actually changing samples exactly as
 * it always did.
 */
export const PROBE_BACKOFF_MS: readonly number[] = [PROBE_INTERVAL_MS, 10_000, 30_000, 60_000]

export interface ProbeSamplerOptions {
  /**
   * Called with how long each pass held the MAIN THREAD, in ms — the
   * loop-health seam. For a synchronous pass that is its wall time; for an
   * async pass it is the sum of the synchronous segments between awaits,
   * never the awaits themselves, so the number names this loop for what it
   * did and not for whatever else the loop was busy with meanwhile.
   */
  observe?: (ms: number) => void
  /** The ladder, first rung first. Tests shrink it; production uses PROBE_BACKOFF_MS. */
  backoffMs?: readonly number[]
  now?: () => number
}

/** Two phase maps say the same thing. */
export function samePhases(a: ReadonlyMap<string, BoardPhase>, b: ReadonlyMap<string, BoardPhase>): boolean {
  if (a.size !== b.size) return false
  for (const [id, phase] of a) if (b.get(id) !== phase) return false
  return true
}

/**
 * Single-flight sampler whose LIFETIME is its subscribers and whose CADENCE
 * is events first, a backed-off tick as the fallback.
 *
 * Lifetime: the periodic pass runs only while a board consumer holds a
 * subscription. A one-shot read (GET /api/board, the board:list IPC) touches
 * the sampler for at most one pass and never starts the timer. So a fleet
 * with forty detached panes and no board open costs nothing.
 *
 * Cadence: the events the app already sees — a herdr status push, a turn
 * boundary, an attach or a detach — recompute ONE terminal through
 * invalidate(), with no listing. The whole-fleet pass remains for the panes
 * with no push source (herdr calls them 'unknown'; pixels are their only
 * signal), on the PROBE_BACKOFF_MS ladder: the first rung while passes keep
 * finding changes, climbing to a minute while nothing moves, dropped back by
 * any event.
 *
 * The tick reads the inventory ONCE and derives the detached set from it.
 * With async reads available the pass is awaited, and the single-flight
 * latch spans the whole pass: a tick landing mid-pass is skipped, never
 * stacked. A read while a pass is in flight answers with the previous pass —
 * unless there is no previous pass at all, in which case warm() lets it
 * wait.
 */
export function createProbeSampler(
  deps: ProbeDeps,
  intervalMs: number = PROBE_INTERVAL_MS,
  options: ProbeSamplerOptions = {}
): ProbeSampler {
  const now = options.now ?? (() => Date.now())
  const ladder = options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : [intervalMs, ...PROBE_BACKOFF_MS.slice(1)]
  let latest = new Map<string, BoardPhase>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let lastSampleAt = 0
  /** The live pane set of the last listing — what an invalidation checks a pane against. */
  let lastLive: ReadonlySet<string> = new Set()
  /** The async pass in flight, so a read before the first completion can await it. */
  let pending: Promise<Map<string, BoardPhase>> | null = null
  /** Any pass has run to its end (fresh, partial or failed) — after that, no read waits. */
  let everCompleted = false
  let subscribers = 0
  let rung = 0
  const listeners = new Set<(phases: Map<string, BoardPhase>) => void>()
  const usesAsync = typeof deps.listSessionsAsync === 'function'

  // Bounded event journals for stats(): timestamps of the last minute.
  const MINUTE = 60_000
  const journal = { passes: [] as number[], listings: [] as number[], invalidations: [] as number[] }
  const note = (kind: keyof typeof journal): void => {
    const list = journal[kind]
    list.push(now())
    if (list.length > 2000) list.splice(0, list.length - 2000)
  }
  const lastMinute = (kind: keyof typeof journal): number => {
    const since = now() - MINUTE
    return journal[kind].filter((t) => t >= since).length
  }

  const observe = (ms: number): void => {
    try {
      options.observe?.(ms)
    } catch {
      // An observer's failure is not the probe's.
    }
  }

  const announce = (): void => {
    for (const listener of listeners) {
      try {
        listener(latest)
      } catch (error) {
        console.error('Board probe listener failed:', error)
      }
    }
  }

  /** Install the pass's map; say so if it differs; climb or drop the ladder. */
  const adopt = (next: Map<string, BoardPhase>): void => {
    const changed = !samePhases(latest, next)
    latest = next
    rung = changed ? 0 : Math.min(rung + 1, ladder.length - 1)
    if (changed) announce()
  }

  const sampleNow = (): Map<string, BoardPhase> => {
    if (inFlight) return latest // single-flight: never stack scans
    inFlight = true
    lastSampleAt = now()
    note('passes')
    const started = performance.now()
    try {
      note('listings')
      const live = new Set(deps.listSessions())
      lastLive = live
      adopt(probeDetached(deps, detachedTerminals(deps, live)))
    } catch (error) {
      console.error('Board probe failed:', error)
    } finally {
      inFlight = false
      everCompleted = true
      observe(performance.now() - started)
    }
    return latest
  }

  const runAsyncPass = async (): Promise<Map<string, BoardPhase>> => {
    const deadline = now() + intervalMs * PROBE_PASS_DEADLINE_TICKS
    let heldMs = 0
    // The open synchronous segment, or null while an await is in flight —
    // so a rejection thrown INTO the finally from an await bills nothing for
    // the off-thread wait it interrupted.
    let segment: number | null = performance.now()
    const close = (): void => {
      if (segment !== null) heldMs += performance.now() - segment
      segment = null
    }
    try {
      note('listings')
      const listing = deps.listSessionsAsync!()
      close()
      const live = new Set(await listing)
      segment = performance.now()
      lastLive = live
      const detached = detachedTerminals(deps, live)
      close()
      const pass = await runDetachedPass(deps, detached, { deadline })
      segment = performance.now()
      heldMs += pass.heldMs
      adopt(mergePartialPass(latest, pass, detached))
    } catch (error) {
      console.error('Board probe failed:', error)
    } finally {
      close()
      inFlight = false
      pending = null
      everCompleted = true
      observe(heldMs)
    }
    return latest
  }

  const sampleAsync = (): Promise<Map<string, BoardPhase>> => {
    if (!usesAsync) return Promise.resolve(sampleNow())
    if (inFlight) return pending ?? Promise.resolve(latest)
    inFlight = true
    lastSampleAt = now()
    note('passes')
    pending = runAsyncPass()
    return pending
  }

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** Arm the next fallback pass at the current rung — only while subscribed. */
  const schedule = (): void => {
    clearTimer()
    if (subscribers === 0) return
    timer = setTimeout(tick, ladder[rung])
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  const tick = (): void => {
    timer = null
    // A tick landing mid-pass is skipped, never stacked; the pass in flight
    // re-arms the ladder when it lands.
    if (inFlight) {
      schedule()
      return
    }
    if (!usesAsync) {
      sampleNow()
      schedule()
      return
    }
    void sampleAsync().then(schedule)
  }

  /** Recompute one terminal from what the app already knows — no listing. */
  const recompute = async (terminalId: string): Promise<Map<string, BoardPhase>> => {
    const next = new Map(latest)
    if (deps.isAttached(terminalId)) {
      next.delete(terminalId) // L1 owns it now
      return next
    }
    const session = deps.sessionNameFor(terminalId)
    const asked = phaseFromAsked(deps.askedStatus?.(terminalId) ?? null)
    if (asked !== null) {
      if (asked === undefined) next.delete(terminalId)
      else next.set(terminalId, asked)
      return next
    }
    // Pixels only: one read of this pane, if the last listing saw it. A pane
    // the last listing did not see is the next pass's to find.
    if (!lastLive.has(session)) return next
    const chunk = deps.capturePaneAsync ? await deps.capturePaneAsync(session) : deps.capturePane(session)
    const phase = phaseFromPane(deps, chunk)
    if (phase) next.set(terminalId, phase)
    else next.delete(terminalId)
    return next
  }

  const sampler: ProbeSampler = {
    phases: () => latest,
    sampleNow,
    sampleAsync,
    touch: () => {
      if (!inFlight && now() - lastSampleAt >= ladder[0]) void sampleAsync()
      return latest
    },
    warm: () => {
      sampler.touch()
      if (everCompleted) return Promise.resolve(latest)
      return pending ?? Promise.resolve(latest)
    },
    subscribe: () => {
      subscribers += 1
      if (subscribers === 1) sampler.start()
      let released = false
      return () => {
        if (released) return
        released = true
        subscribers -= 1
        if (subscribers === 0) sampler.stop()
      }
    },
    invalidate: async (terminalId) => {
      note('invalidations')
      rung = 0
      if (timer) schedule() // drop the ladder: the next fallback pass comes at the first rung
      try {
        const next = await recompute(terminalId)
        if (samePhases(latest, next)) return
        latest = next
        announce()
      } catch (error) {
        console.error('Board probe invalidation failed:', error)
      }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    stats: () => ({
      subscribers,
      intervalMs: ladder[rung],
      passesLastMinute: lastMinute('passes'),
      listingsLastMinute: lastMinute('listings'),
      invalidationsLastMinute: lastMinute('invalidations'),
      everCompleted,
      running: timer !== null
    }),
    start: (): void => {
      if (timer) return
      if (subscribers === 0) subscribers = 1 // a bare start() is one anonymous subscriber; stop() is its release
      if (now() - lastSampleAt < ladder[0]) {
        schedule()
        return
      }
      if (!usesAsync) {
        sampleNow()
        schedule()
        return
      }
      void sampleAsync().then(schedule)
    },
    stop: (): void => {
      subscribers = 0
      clearTimer()
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
    // sync read inside the same promise, which is no worse than before. A
    // listing that FAILS rejects — the pass logs and leaves the last map
    // alone — rather than reading as an empty fleet.
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
