/**
 * Which workspaces the main process is holding in memory, and why.
 *
 * This module exists because of ef5e13c. Wave C answered the same question
 * with `serviceState: hot | dormant | parked` — a stored intent a human or a
 * code path had to remember to unset. Two flags leaked by a failed rollback
 * cost O(attached × panes) on every sweep, forever, invisibly: /api/activity
 * went 190ms → 6.85s and herdr sat at 74% CPU while ten symptoms looked
 * unrelated. The owner reverted all of it, and the post-mortem's verdict was
 * the model, not the bug: "a model where forgetting is the dominant failure
 * mode is the wrong model."
 *
 * So there is no flag here, and deliberately no open()/close() pair either —
 * an explicitly-opened thing that must be explicitly closed IS the flag,
 * wearing different clothes. A workspace is live iff one of three FACTS is
 * true right now:
 *
 *   1. a window is bound to it   (someone is looking)
 *   2. a slug subscriber is reading it   (a phone, an SSE consumer)
 *   3. work is in flight in it   (a dispatch, a running turn)
 *
 * Every one of those is already tracked elsewhere for its own reasons, and
 * every one falls to zero on its own. Nothing to set, nothing to unset,
 * nothing to leak; a workspace nobody is using costs exactly zero. This is the
 * same shape session-sync.ts already uses for terminals (pins, subscribers,
 * drain) — one idea, applied one level up.
 *
 * Residency (what is hydrated) is downstream of liveness (what is true).
 */

/** How long a session must be dead before it is released. */
export const DRAIN_DEBOUNCE_MS = 15_000

export interface SessionRegistryDeps<S> {
  /** Windows currently displaying this workspace. */
  boundWindows: (workspaceId: string) => number
  /** Live route subscribers reading this workspace (phone card, SSE). */
  subscribers: (workspaceId: string) => number
  /** Dispatches or turns in flight in this workspace. */
  inFlightWork: (workspaceId: string) => number
  /** Build the session. May throw — a corrupt workspace file is not fatal. */
  hydrate: (workspaceId: string) => S
  /** Tear one down: flush its state, detach its PTYs, unmount its routes. */
  release: (workspaceId: string, session: S) => void
  now: () => number
}

/**
 * Sessions the process is holding, materialised on demand and dropped when
 * nothing is true about them any more.
 */
export class SessionRegistry<S> {
  private readonly sessions = new Map<string, S>()

  /** When each resident session was first observed dead; absent = alive. */
  private readonly deadSince = new Map<string, number>()

  constructor(private readonly deps: SessionRegistryDeps<S>) {}

  /**
   * Is anything true about this workspace right now? Computed every call —
   * never cached, because a cached answer is a flag and a flag can go stale.
   */
  isLive(workspaceId: string): boolean {
    return (
      this.deps.boundWindows(workspaceId) > 0 ||
      this.deps.subscribers(workspaceId) > 0 ||
      this.deps.inFlightWork(workspaceId) > 0
    )
  }

  /**
   * The session for a workspace, hydrating it if the process is not already
   * holding one.
   *
   * A hydrate that throws retains NOTHING: the entry is only recorded once it
   * exists. That is the direct lesson of the failed-rollback leak — a boot
   * path that dies must cost zero, not leave a permanent tax behind.
   */
  get(workspaceId: string): S {
    const existing = this.sessions.get(workspaceId)
    // NOT cleared here. A poller calling get() on every tick would otherwise
    // reset the death clock forever and nothing would ever drain — the same
    // unbounded hold as a leaked flag, arrived at from the other direction.
    // Only drainTick(), which actually consults liveness, clears it.
    if (existing !== undefined) return existing

    const session = this.deps.hydrate(workspaceId)
    this.sessions.set(workspaceId, session)
    this.deadSince.delete(workspaceId)
    return session
  }

  /** The session, only if already resident — never hydrates. */
  peek(workspaceId: string): S | undefined {
    return this.sessions.get(workspaceId)
  }

  /** Workspace ids currently held in memory. */
  resident(): string[] {
    return [...this.sessions.keys()]
  }

  residentCount(): number {
    return this.sessions.size
  }

  /**
   * Release every resident session that has been dead for longer than the
   * debounce. Idempotent, and safe to call on any cadence.
   *
   * The debounce is what makes switching away and straight back cheap: the
   * session is dead for a moment, then alive again, and the timer resets
   * without anything being torn down.
   *
   * A release that throws still drops the session — otherwise a flaky
   * teardown becomes exactly the permanent leak this module was written to
   * make impossible.
   */
  drainTick(): void {
    const now = this.deps.now()
    for (const [id, session] of [...this.sessions]) {
      if (this.isLive(id)) {
        this.deadSince.delete(id)
        continue
      }
      const since = this.deadSince.get(id)
      if (since === undefined) {
        this.deadSince.set(id, now)
        continue
      }
      if (now - since < DRAIN_DEBOUNCE_MS) continue

      this.sessions.delete(id)
      this.deadSince.delete(id)
      try {
        this.deps.release(id, session)
      } catch (error) {
        console.error(`Failed to release workspace session '${id}':`, error)
      }
    }
  }
}
