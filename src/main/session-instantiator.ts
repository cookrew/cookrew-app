import { nextOrdinal, sessionIdentity, type SessionIdentity } from './session-identity'

// Re-exported: the seams below name it in their signatures, so an adapter or a
// test that implements one must be able to import it from here.
export type { SessionIdentity }

/**
 * THE INSTANTIATOR (R30) — first gated call → a live WorkspaceSession.
 *
 * A caller passes the gate (401/402, Forge's half) and lands here. This decides
 * ONE thing: does an OPEN session already exist for this account on this
 * service, or must a new one be minted from the template at its pin? Everything
 * with a side effect — copyTeam, the sandbox dir, the PTYs, the in-flight
 * cancellation, the disk cleanup — is behind a seam, because the design's whole
 * point is that the decisions can be tested without a filesystem, a PTY or a
 * network. The seams are wired to the real subsystems in the production adapter;
 * here they are interfaces, and the orchestrator composes them.
 *
 * WHAT IT COMPOSES, not builds (verified in the tree, per the R30 note):
 *   • session-identity.ts — the account-keyed id, the ordinal, the slug.
 *   • copyTeam / forkTeam — one mint per session, the pinned snapshot as source.
 *   • CallsInFlight.cancelWhere — END cuts mid-call, reusing revoke semantics.
 *   • the sandbox (session-sandbox.ts) — every terminal's cwd, confined.
 *
 * THE PIN IS RESOLVED ONCE, AT MINT (design S1). A running session keeps the
 * version it started on; only a NEW session gets the latest pin. So the record
 * carries the resolved pin, and nothing re-reads the template for a session that
 * already exists. That is what makes "ana-1 on V1 and ana-2 on V2 at once" a
 * fact of the data rather than a race.
 */

/**
 * A template, resolved to a value (design S1). The instantiator never learns how
 * templates are stored — behind this seam a template is a snapshot at a pin, and
 * the pin is read ONCE so the version cannot shift under a running session.
 */
export interface ResolvedTemplate {
  /**
   * The saved-team id the mint engine forks from (`forkTeam`'s `fromSavedTeam`).
   * Resolved from the service's LOCAL cache — the crew runs on this machine, so
   * this names bytes this machine actually holds (design S1b).
   */
  templateId: string
  /** The version LABEL the owner reads on the rail and the Sessions table. */
  version: number
  /**
   * The pin's identity — a content address, not the label (design S1c). Two
   * offline "V2"s share a label but not this, so a session can never be
   * ambiguous about the bytes it is running.
   */
  pinAddress: string
}

export interface TemplateSource {
  /**
   * The template a service serves, read from the LOCAL cache and resolved to its
   * current pin. Local-first is not a fallback (design S1b): the crew runs on
   * THIS machine, so a service must serve what this machine actually holds.
   */
  read(serviceId: string): ResolvedTemplate
}

/** A live session's record. Immutable — a state change is a new record. */
export interface SessionRecord {
  readonly identity: SessionIdentity
  /** The workspace the mint created; an ordinary SessionRegistry resident. */
  readonly workspaceId: string
  readonly serviceId: string
  readonly accountId: string
  readonly ordinal: number
  /** Resolved at mint, never re-read (design S1). */
  readonly version: number
  readonly pinAddress: string
}

/**
 * Turn a resolved template into a live, sandboxed workspace (design S3 + mint).
 * The adapter creates the sandbox dir, forkTeams the snapshot into a fresh
 * workspace, and boots the terminals IN PLACE (slice 1's `bootTerminals` seam,
 * so a stranger's first call never yanks the owner's screen). Returns the new
 * workspace id.
 *
 * Async because the real engine (`forkTeam`) awaits worktrees, native session
 * restore and context injection. A caller that arrived over HTTP is already on
 * an async path, so the admission that mints for them is async too.
 */
export interface Minter {
  mint(input: {
    serviceId: string
    identity: SessionIdentity
    template: ResolvedTemplate
  }): Promise<string>
}

/** Only the orch answers (design S5). Null when the session has no conductor. */
export interface ConductorRoute {
  conductorOf(workspaceId: string): string | null
}

/**
 * What END needs to identify a session to the subsystems it cuts. The workspace
 * is what `CallsInFlight.cancelWhere` matches on; the service and session ids
 * are what the sandbox path is built from. Passing the trio rather than a bare
 * id is why the Ender adapter can be pure plumbing.
 */
export interface EndTarget {
  sessionId: string
  workspaceId: string
  serviceId: string
}

/**
 * END, and what it cuts (design S4). `cut` stops running calls for the session
 * and returns how many — the revoke seam (CallsInFlight.cancelWhere), not a
 * second cancellation path. `cleanup` removes the sandbox, and the orchestrator
 * calls it AFTER the cut, never before: deleting a sandbox out from under a
 * running agent is how a stop becomes a crash.
 */
export interface Ender {
  cut(target: EndTarget): number
  cleanup(target: EndTarget): void
}

export interface InstantiatorDeps {
  templates: TemplateSource
  minter: Minter
  route: ConductorRoute
  ender: Ender
}

/** The outcome of admitting a call: the session, and whether this call minted it. */
export interface Admission {
  session: SessionRecord
  created: boolean
}

/**
 * A collision-free key for a (service, account) pair, used to key the ordinal
 * ledger and the in-flight-mint map. JSON.stringify of the raw pair, so no pair
 * of inputs can ever alias to another pair's key. Reuse itself matches on the
 * record's raw fields (see openFor), so this key never decides who reuses whom.
 */
function pairKey(serviceId: string, accountId: string): string {
  return JSON.stringify([serviceId, accountId])
}

/**
 * The instantiator holds the live session table. It is a stateful service — the
 * one place open sessions are tracked — but every RECORD is frozen and every
 * side effect is a seam, so the state is only the maps below: the open sessions,
 * the ordinals ever used, and the mints currently in flight.
 */
export class SessionInstantiator {
  private readonly deps: InstantiatorDeps
  /**
   * sessionId → its record, for the OPEN sessions only. This is the SINGLE
   * source of truth for what is open; reuse derives from it (see `openFor`)
   * rather than a parallel index, so the two can never disagree — the bug where
   * a second session for an account orphaned the first's reuse pointer cannot
   * exist when there is only one index.
   */
  private readonly openById = new Map<string, SessionRecord>()
  /**
   * (service,account) → every ordinal ever minted, open or closed. A closed
   * ordinal is NEVER reused (design): END destroys sandboxes, so re-minting onto
   * a just-deleted path is the exact hazard nextOrdinal is written to avoid.
   */
  private readonly usedOrdinals = new Map<string, number[]>()
  /**
   * (service,account) → an in-flight first-mint, so two concurrent first calls
   * from the same caller JOIN one mint instead of racing to make two workspaces
   * for one account. Admit is async and awaits the mint; without this, both
   * calls would pass the "is there an open session" check (there is not one YET)
   * and each would forkTeam a workspace, leaking the first.
   */
  private readonly mintingByPair = new Map<string, Promise<SessionRecord>>()

  constructor(deps: InstantiatorDeps) {
    this.deps = deps
  }

  /**
   * Admit a gated call. Reuses the account's OPEN session if it has one — which
   * keeps that session's pin — otherwise mints a new one. The default is reuse:
   * a caller who does nothing lands back where their work is, because the safe
   * shape is what happens when a client does nothing.
   *
   * CONTRACT: `serviceId` and `accountId` are OPAQUE, already-safe identifiers —
   * an R31 account id and an export's service id, both minted upstream, not
   * display names. The instantiator does not defend against two DIFFERENT raw
   * ids that would segment to one slug (`sessionIdentity` flattens via
   * `safeSegment`), because with opaque ids upstream that case cannot arise; the
   * key that decides reuse and the id that names the sandbox both derive from
   * these, so a caller passing raw names would collide at both and this is the
   * one place that assumption must hold.
   */
  async admit(serviceId: string, accountId: string): Promise<Admission> {
    const existing = this.openFor(serviceId, accountId)
    if (existing) return { session: existing, created: false }

    // A first-mint may already be in flight for this pair (a concurrent first
    // call). Join it rather than mint a second workspace onto the same identity;
    // the joiner did not create the session, so it reports created:false.
    const key = pairKey(serviceId, accountId)
    const inflight = this.mintingByPair.get(key)
    if (inflight) return { session: await inflight, created: false }

    const promise = this.mintNew(serviceId, accountId)
    this.mintingByPair.set(key, promise)
    try {
      return { session: await promise, created: true }
    } finally {
      this.mintingByPair.delete(key)
    }
  }

  /**
   * Mint a NEW session even if the account already has one open — the explicit
   * "start another" that makes ana-1 and ana-2 concurrent (design S2's demo). A
   * fresh ordinal, so the second session gets its own sandbox and, if the pin
   * moved since ana-1, its own version.
   */
  async startNew(serviceId: string, accountId: string): Promise<SessionRecord> {
    return this.mintNew(serviceId, accountId)
  }

  /** The conductor terminal for a session, or null if it is gone (design S5). */
  conductorFor(sessionId: string): string | null {
    const record = this.openById.get(sessionId)
    if (!record) return null
    return this.deps.route.conductorOf(record.workspaceId)
  }

  /**
   * END a session (design S4). Cuts any in-flight call FIRST, forgets the
   * session, then cleans up its sandbox. Idempotent: ending an unknown or
   * already-ended session stops nothing and throws nothing — END is a panic
   * button, and a panic button that can fail is not one.
   */
  end(sessionId: string): { stopped: number } {
    const record = this.openById.get(sessionId)
    if (!record) return { stopped: 0 }

    const target: EndTarget = {
      sessionId,
      workspaceId: record.workspaceId,
      serviceId: record.serviceId
    }

    // Cut before cleanup — a running agent must be stopped before its sandbox
    // is removed, or the removal races the process still writing into it.
    const stopped = this.deps.ender.cut(target)

    // Forget it. A concurrent admit for the same account now reuses another OPEN
    // session for that account if one exists (startNew's second session), or
    // mints afresh if this was the last — because reuse reads openById, ending
    // one session cannot strand another. The ordinal stays used.
    this.openById.delete(sessionId)

    this.deps.ender.cleanup(target)
    return { stopped }
  }

  /** The OPEN sessions, for the owner's Sessions table (Fresco reads these). */
  sessions(): readonly SessionRecord[] {
    return [...this.openById.values()]
  }

  /**
   * The caller's current session, resolved by the same newest-open rule admit
   * uses. Served read routes use this instead of accepting a session id from
   * the wire, so a credential can never select another caller's transcript.
   */
  sessionForCaller(serviceId: string, accountId: string): SessionRecord | null {
    return this.openFor(serviceId, accountId)
  }

  /**
   * The session a minted workspace belongs to, or null if the workspace is not a
   * served session (the owner's own). The spawn path asks this to decide whether
   * a terminal must start confined and scrubbed — an ordinary workspace answers
   * null and spawns exactly as it always did.
   */
  sessionForWorkspace(workspaceId: string): SessionRecord | null {
    for (const record of this.openById.values()) {
      if (record.workspaceId === workspaceId) return record
    }
    return null
  }

  /**
   * The account's OPEN session to reuse on this service, or null. When an
   * account has more than one open (it started a second with `startNew`), the
   * NEWEST — highest ordinal — is the one a plain call lands on, so "start
   * another" moves the caller forward and a bare reuse returns to their latest.
   * Matches on the record's raw fields, never a derived slug, so two accounts
   * whose ids happen to segment alike are still distinct here.
   */
  private openFor(serviceId: string, accountId: string): SessionRecord | null {
    let newest: SessionRecord | null = null
    for (const record of this.openById.values()) {
      if (record.serviceId !== serviceId || record.accountId !== accountId) continue
      if (newest === null || record.ordinal > newest.ordinal) newest = record
    }
    return newest
  }

  private async mintNew(serviceId: string, accountId: string): Promise<SessionRecord> {
    const key = pairKey(serviceId, accountId)
    const used = this.usedOrdinals.get(key) ?? []
    const ordinal = nextOrdinal(used)
    const identity = sessionIdentity(serviceId, accountId, ordinal)

    // RESERVE the ordinal synchronously, before any await, so two mints for the
    // same account (two startNew, or a startNew beside an admit) cannot both
    // take it — JS runs this to the `await` below without interleaving.
    this.usedOrdinals.set(key, [...used, ordinal])

    // Resolve the pin ONCE, here, then mint. The template read is pure and
    // cannot half-create a workspace; the mint is the side effect. If it throws,
    // the reserved ordinal is released so a retry reuses the same clean one.
    const template = this.deps.templates.read(serviceId)
    let workspaceId: string
    try {
      workspaceId = await this.deps.minter.mint({ serviceId, identity, template })
    } catch (err) {
      this.usedOrdinals.set(
        key,
        (this.usedOrdinals.get(key) ?? []).filter((o) => o !== ordinal)
      )
      throw err
    }

    // Frozen: the record is a fact of a running session, and a caller that could
    // mutate its version or workspaceId could defeat the resolved-once pin at
    // runtime past what the readonly types catch at compile time.
    const record: SessionRecord = Object.freeze({
      identity,
      workspaceId,
      serviceId,
      accountId,
      ordinal,
      version: template.version,
      pinAddress: template.pinAddress
    })
    this.openById.set(identity.sessionId, record)
    return record
  }
}
