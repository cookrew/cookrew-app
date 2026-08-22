/**
 * A CALL IN FLIGHT IS WORK (§11 · ④ · S4) — liveness fact 3, told the truth.
 *
 * SessionRegistry holds a workspace resident while any of three facts is true:
 * a window is bound to it, a subscriber is reading it, or work is in flight in
 * it. A remote call to a PARKED workspace is exactly the case the marketplace
 * exists for — nobody is looking, no phone is attached, and an exported agent
 * is supposed to answer anyway — so the third fact is the only one that can be
 * true, and it has to actually become true.
 *
 * WHY THE EXISTING SIGNAL IS NOT ENOUGH. `hasLiveWork` reads the turn phase and
 * open dispatches: both are INFERRED from a terminal that has already started
 * producing. Between accepting a call and the agent's first byte there is a
 * window — boot, context injection, the paste-and-submit delay — where an
 * inferred signal says idle. The drain runs on a five-second tick and releases
 * a session dead across two of them, which is comfortably inside that window
 * for a cold fork. The workspace would be torn down under a call it had already
 * agreed to serve.
 *
 * So this is a FACT, not a flag: a counter that goes up when a call starts and
 * down when it finishes, in a finally. There is no state anyone can forget to
 * unset — the post-mortem this whole model came from is explicit that "a model
 * where forgetting is the dominant failure mode is the wrong model" — because
 * the only way to increment is to hold the thing that decrements.
 */

export class CallsInFlight {
  private readonly counts = new Map<string, number>()

  /** How many calls this workspace is currently serving. */
  count(workspaceId: string): number {
    return this.counts.get(workspaceId) ?? 0
  }

  /**
   * Mark a call in flight, and hand back the only way to end it.
   *
   * The release is idempotent, because a caller that ends twice — a finally
   * plus an error path, say — would otherwise decrement a later call's count
   * and let the workspace drain out from under it.
   */
  enter(workspaceId: string): () => void {
    this.counts.set(workspaceId, this.count(workspaceId) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.count(workspaceId) - 1
      if (next > 0) this.counts.set(workspaceId, next)
      // Deleted rather than left at zero: a workspace nobody is calling should
      // cost exactly nothing, including a map entry.
      else this.counts.delete(workspaceId)
    }
  }

  /** Workspaces currently serving a call. For diagnostics, not for decisions. */
  active(): string[] {
    return [...this.counts.keys()]
  }
}
