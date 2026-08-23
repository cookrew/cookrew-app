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
 * So this is a FACT, not a flag: an entry that exists while a call runs and is
 * removed in a finally. There is no state anyone can forget to unset — the
 * post-mortem this whole model came from is explicit that "a model where
 * forgetting is the dominant failure mode is the wrong model" — because the
 * only way to register is to hold the thing that unregisters.
 *
 * AND IT IS ALSO THE HANDLE (Velvet's ruling). Revoke stops calls already
 * running, which means something has to be able to FIND a running call by who
 * is making it and which agent it is against. That is exactly the set this
 * already maintains, so the counter grew an identity and a way to cut rather
 * than acquiring a parallel registry that could disagree with it. One set, one
 * truth: a call that is counted is a call that can be stopped.
 */

/** Who is calling what — enough to answer "does this revoke apply to you?". */
export interface CallIdentity {
  workspaceId: string
  /** The enrolled subject the credential was minted for. */
  sub: string
  /** The exported agent's terminal id — the durable identity behind the address. */
  nodeId: string
}

interface Entry {
  readonly identity: CallIdentity
  readonly cancel: () => void
  cancelled: boolean
}

export class CallsInFlight {
  private readonly entries = new Set<Entry>()

  /** How many calls this workspace is currently serving. */
  count(workspaceId: string): number {
    let n = 0
    for (const entry of this.entries) {
      if (entry.identity.workspaceId === workspaceId) n += 1
    }
    return n
  }

  /**
   * Mark a call in flight, and hand back the only way to end it.
   *
   * The release is idempotent, because a caller that ends twice — a finally
   * plus an error path, say — would otherwise drop a later call's entry and
   * let the workspace drain out from under it.
   */
  enter(identity: CallIdentity, cancel: () => void): () => void {
    const entry: Entry = { identity: { ...identity }, cancel, cancelled: false }
    this.entries.add(entry)
    return () => {
      this.entries.delete(entry)
    }
  }

  /**
   * Cut every call the predicate claims, and say how many.
   *
   * The count goes back to the owner because "revoked" and "revoked, and
   * stopped two calls that were running" are different things to be told —
   * the second is the one that answers the question they were actually asking.
   *
   * Cancelled ONCE per entry: revoking a caller and unexporting the agent it
   * was calling are two decisions that can land a beat apart on the same call,
   * and firing a cancellation twice would abort whatever reused the handle.
   *
   * An entry is not removed here. Removal belongs to the run's finally, which
   * is the thing that knows the call is really over; deleting it here would
   * release the workspace while the ask is still unwinding.
   */
  cancelWhere(match: (identity: CallIdentity) => boolean): number {
    let stopped = 0
    for (const entry of this.entries) {
      if (entry.cancelled || !match(entry.identity)) continue
      entry.cancelled = true
      stopped += 1
      try {
        entry.cancel()
      } catch {
        // One runner already gone must not strand the rest of the sweep. The
        // owner asked for everything to stop; a cleanup that throws is not a
        // reason to leave the next call running.
      }
    }
    return stopped
  }

  /**
   * The calls running in one workspace right now.
   *
   * Copies out, so the owner's surface cannot hold a reference into the live
   * set and read it changing under itself — or worse, edit it.
   */
  listIn(workspaceId: string): CallIdentity[] {
    return [...this.entries]
      .filter((e) => e.identity.workspaceId === workspaceId)
      .map((e) => ({ ...e.identity }))
  }

  /** Workspaces currently serving a call. For diagnostics, not for decisions. */
  active(): string[] {
    return [...new Set([...this.entries].map((e) => e.identity.workspaceId))]
  }
}
