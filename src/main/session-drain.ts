/**
 * The residency drain, wired — out of index.ts so the wiring itself is what
 * the tests exercise, not a copy of it.
 *
 * session-registry.ts decides WHEN a session goes (three derived facts, a
 * debounced death clock, nothing anyone can pin). This module says WHERE the
 * facts come from and WHAT a release tears down, and it is the seam the
 * PERF-N harness (scratchpad/perf-n-harness.mjs, verifyLoops) locates.
 *
 * Without this the SessionRegistry was a design with no caller: hydrating
 * grew the resident set monotonically and nothing ever released it — the
 * unbounded hold of ef5e13c, reinstated by the module written to prevent
 * it. The three liveness facts are read from where they already live, so
 * there is still nothing to set and nothing to leak.
 *
 * THE SHAPE, and the one thing this module adds (perf/tempo, 2026-09-06):
 * every PER-TICK fact is answered from MEMORY. A workspace the store is not
 * holding has no terminals anyone could be watching or working in — its
 * ptys were detached with it — so for liveness its terminal set is [] by
 * construction rather than a disk read, and the drain never hydrates
 * anything. A parked session costs the registry a timestamp (deadSince) and
 * the store the session it already holds; the tick walks the resident set
 * and, per resident session, its in-memory nodes. Zero I/O per tick is the
 * gate (tests/session-drain-wiring.test.ts, tests/perf/residency.perf.ts).
 * The release — once per workspace lifetime — reads the store's view so no
 * watch is left behind.
 */
import { SessionRegistry } from './session-registry'

/** How often the drain looks; a session must be dead across two of these. */
export const SESSION_DRAIN_TICK_MS = 5_000

export interface SessionDrainStore {
  readonly focusedId: string
  resident(): string[]
  isResident(workspaceId: string): boolean
  terminalIdsOf(workspaceId: string): string[]
  releaseSession(workspaceId: string): boolean
}

export interface SessionDrainFacts {
  store: SessionDrainStore
  /** A phone or SSE reader watching this terminal. */
  subscriberCount: (terminalId: string) => number
  /** A terminal mid-turn, or carrying an open dispatch. */
  hasLiveWork: (terminalId: string) => boolean
  /** Remote calls this workspace is serving — invisible to the inferred signals during a cold fork's boot. */
  callsInFlight: (workspaceId: string) => number
  /** Stop watching one terminal (session-sync release + turn untrack). */
  releaseTerminal: (terminalId: string) => void
  /** Detach every pty of the workspace. */
  detachWorkspace: (workspaceId: string) => void
  now?: () => number
}

export interface SessionDrain {
  sessions: SessionRegistry<{ id: string }>
  /**
   * One tick. Materialise whatever the store is holding, then let liveness
   * decide. The registry never PINS anything — get() deliberately does not
   * clear the death clock, so a session that is merely resident still drains.
   */
  tick(): void
}

export function createSessionDrain(facts: SessionDrainFacts): SessionDrain {
  const { store } = facts
  /** The terminals liveness can be true through — held in memory, or none. */
  const terminalsOf = (id: string): string[] => (store.isResident(id) ? store.terminalIdsOf(id) : [])

  const sessions = new SessionRegistry<{ id: string }>({
    // One window today; a per-window count once windows exist.
    boundWindows: (id) => (id === store.focusedId ? 1 : 0),
    subscribers: (id) => terminalsOf(id).reduce((n, tid) => n + facts.subscriberCount(tid), 0),
    inFlightWork: (id) => terminalsOf(id).filter(facts.hasLiveWork).length + facts.callsInFlight(id),
    hydrate: (id) => ({ id }),
    release: (id) => {
      // Order matters: release and untrack FIRST, then detach — so a watch
      // can never re-arm against a terminal being torn out from under it.
      // Read the set, then tear down. The STORE'S view, not terminalsOf: a
      // release fires at most once per workspace lifetime, so a session the
      // store evicted by another path may cost one read here — and every
      // watch it still had is handed back, which the memory-only shortcut
      // (right for the per-tick facts) would silently skip.
      for (const tid of store.terminalIdsOf(id)) facts.releaseTerminal(tid)
      facts.detachWorkspace(id)
      store.releaseSession(id)
    },
    now: facts.now ?? (() => Date.now())
  })

  return {
    sessions,
    tick: () => {
      for (const id of store.resident()) sessions.get(id)
      sessions.drainTick()
    }
  }
}
