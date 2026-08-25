// THE ONE-PRODUCER LEASE (Sol r6 P0-1, hardened per Sol r7/r8): one submission
// window per terminal.
//
// The r5 owner guard was a point-in-time check — it preempted a dispatch that
// was already armed, but it RESERVED nothing, so a dispatch could arm and
// submit while an owner ask sat inside its blocking promptAgent, and two owner
// asks could both pass the same guard while nothing was armed. This lease is
// the reservation the check lacked: whoever is about to write an IRREVERSIBLE
// submission byte acquires the terminal first and holds it through submission
// acknowledgement, so at most one producer's bytes can be in flight toward the
// agent's single input buffer at any moment.
//
// SCOPE — the SUBMISSION WINDOW, not the turn. A dispatch acquires before its
// first irreversible byte (native promptAgent, or the fallback's paste) and
// releases when the submission is acknowledged (promptAgent resolved / the
// fallback's CR written). The turn the submission opens keeps running long
// after release; the dispatch RESERVATION (DispatchService.reserved plus the
// tracker stamp) still guards that turn against a second dispatch — the lease
// only guards the bytes-in-flight window the reservation could not see.
//
// WHO YIELDS TO WHOM (Sol r7 P0-1 — displacement is GONE):
// - dispatch vs owner-held    → refused (the dispatch fails honestly; the
//   caller may retry once the owner's submission settles).
// - owner vs dispatch-held    → refused. The r6 `displaceDispatch` takeover
//   treated a committed ledger interrupt as proof the backend submission was
//   undone — it never was: promptAgent had already been invoked (no await sits
//   between acquire and submit), and a fallback's paste may already be in the
//   TUI's input box. A bookkeeping row cannot un-send bytes, so once a
//   dispatch HOLDS the window the owner waits. Preempting a dispatch that is
//   merely ARMED (stamped, no hold) is unchanged — that path never crosses
//   the irreversible boundary.
// - owner vs owner-held       → refused honestly ('another owner submission is
//   in flight'); owner submissions never displace each other.
// - same holder               → reentrant (depth-counted; release pairs with
//   acquire).
//
// GENERATIONS (Sol r7 P1): a hold is scoped to the terminal LIFETIME it was
// acquired in. `retire(terminalId)` bumps a monotonic per-terminal generation
// at every permanent ending (remove, cut, CWD rebind, backend death); a hold
// from a dead generation is invisible to new acquirers and its late release is
// a no-op. Without this, a native promptAgent that outlives its terminal (an
// execFile that only settles at the ask timeout) stranded the reborn
// terminal's window until the dead promise finally resolved.
//
// CONTAMINATION (Sol r7 P0-1, fail-closed per Sol r8 P0-2): a delivery
// cancelled AFTER its paste write but BEFORE its CR leaves the cancelled
// prompt sitting in the TUI's shared input box. That buffer is no longer any
// producer's clean slate — the next submit at the terminal would carry the
// cancelled text. The flag records that fact at the lease (the one object
// every producer already consults); while set, every submit-capable write
// refuses. The ONLY clear is a terminal generation reset (`retire` — fresh
// process, fresh input box). The r7 owner-acknowledgment clear (one observed
// Ctrl-U/Ctrl-C byte) is gone: a control byte is an observation, never PROOF
// — Ctrl-U provably clears one line of a multi-line residue, Ctrl-C doubles
// as quit in some harnesses — and converting it into proof readmitted
// submits over live residue. Marking is generation-checked so a retire that
// raced the cancellation never stains the reborn terminal.
//
// OWNER EDITING (Sol r8 P0-1, hardened per r9 P0-1/P0-2): the composing mark.
// The tracker sets it on the FIRST owner byte entering the shared input box —
// any byte, whitespace included; a space is a real byte in the real box — and
// clears it only on PROOF the box emptied: a positively observed owner submit
// consuming the buffer, the one proven clear op (Ctrl-U on a single-line
// buffer the model watched being typed), or terminal retirement. The mark
// lives HERE, generation-scoped, precisely so it survives the tracker: a
// workspace detach untracks the view, but the pane and its dirty input box
// live on, and dispatch must keep refusing until reattach+submit or retire.
// While set, dispatch admission and both delivery legs refuse — the input box
// is the owner's, and a delivery pasted beside half-typed owner text would
// submit a combined prompt no producer ever asked for. It is a MARK, not a
// hold: owner typing must never block owner typing, so it carries no holder
// identity and no depth.
//
// NO TIMERS, on purpose: the lease never expires a hold on its own. Every
// caller owns its hold's lifetime and releases in a `finally`; a retired
// holder's release is a no-op, so retirement and orderly release compose.
//
// DURABLE PROVENANCE (Sol r10 P0-1, hardened per Sol r11 P0-1/2/3 and P1):
// the marks — owner-editing, dispatch residue and contamination — describe
// the REAL input box of a pane that deliberately outlives this process. An
// attached InputProvenanceStore makes them survive it: dirtying writes hit
// the WAL durably BEFORE the byte crosses the pane boundary
// (noteBytesEntering / noteDispatchBytesEntering, called by the PTY write
// paths — a mark that cannot commit REFUSES the write), and a NEW process
// adopts a recorded fact fail-closed at first sight of the terminal id.
// Clearing is proof-shaped: the transcript witness (witnessConsumed), the
// one proven single-line erase (clearOwnerEditingProven), or PROVEN pane
// death (clearProvenanceOnDeath, after killAndWait) — never the local input
// echo, and never bare retirement, because retire() is bookkeeping while the
// kill behind it can still fail. Without a store (tests, embedders) the
// lease is the pure in-memory object it always was.
//
// Pure map-over-ids state otherwise — the whole matrix is unit-testable.

import { randomUUID } from 'node:crypto'
import { dirtiesInputBox, pastedBodyOf } from './input-provenance'
import type { InputProvenanceStore, ProvenanceDetail } from './input-provenance'

/** The named refusal every producer surfaces while the buffer is dirty. */
export const CONTAMINATED_REFUSAL =
  'input box contaminated by a cancelled delivery — restart the terminal to clear it'

/**
 * The refusal while an unconfirmed dispatch delivery may sit in the box (Sol
 * r11 P0-3): unlike contamination it CAN clear without a restart — the
 * transcript witnessing the delivered prompt consumed settles it.
 */
export const DISPATCH_RESIDUE_REFUSAL =
  'input box holds an unconfirmed dispatch delivery — awaiting the transcript witness (or restart the terminal)'

/**
 * Generation entries a retired-and-never-reused terminal id may keep (Sol r8
 * P2). A tombstone only matters while a stale asynchronous holder could still
 * return — bounded by the ask timeout — so the map is bounded rather than
 * eternal: beyond this, the oldest tombstones with no live hold or mark are
 * reclaimed. Generous on purpose: live terminals number in the dozens, and a
 * stale leg lives minutes, not thousands of retires.
 */
const GENERATION_TOMBSTONES = 1024

/**
 * Who holds a terminal's submission window. Owner holders carry a minted
 * `askId` because two concurrent owner submissions are DIFFERENT producers —
 * a bare `{kind:'owner'}` would make the second read as reentrant and defeat
 * the owner-vs-owner refusal.
 */
export type ProducerHolder =
  | { kind: 'owner'; askId: string }
  | { kind: 'dispatch'; dispatchId: string }

export type LeaseOutcome = 'acquired' | 'held-by-owner' | 'held-by-dispatch' | 'retired'

export interface AcquireOptions {
  /**
   * The terminal generation the caller captured when its work began
   * (`generationOf`). When provided and the terminal has since been retired,
   * the acquire refuses with 'retired' — a leg from a dead lifetime must not
   * claim the reborn terminal's window. Omitted, the acquire binds to the
   * CURRENT generation.
   */
  generation?: number
}

/** One hold: holder, reentrancy depth, and the generation it lives in. */
interface Hold {
  readonly holder: ProducerHolder
  readonly depth: number
  readonly generation: number
}

function sameHolder(a: ProducerHolder, b: ProducerHolder): boolean {
  if (a.kind === 'owner' && b.kind === 'owner') return a.askId === b.askId
  if (a.kind === 'dispatch' && b.kind === 'dispatch') return a.dispatchId === b.dispatchId
  return false
}

export class ProducerLease {
  /**
   * The durable input-provenance WAL, when wired (production: PtyManager
   * attaches the default store at construction; tests inject their own or
   * none). Null = process-memory-only marks, the pre-r10 behavior.
   */
  private provenance: InputProvenanceStore | null

  constructor(provenance: InputProvenanceStore | null = null) {
    this.provenance = provenance
  }

  /**
   * Late wiring for the shared default instance: the conductor's module graph
   * constructs the lease before anything owns a state directory, so the store
   * arrives when the PTY plane boots. Must precede seeding and first-sight
   * queries — attach only affects adoption from this point on.
   */
  attachProvenance(store: InputProvenanceStore): void {
    this.provenance = store
  }

  private readonly holds = new Map<string, Hold>()
  /** terminalId → current generation; absent reads as 0. */
  private readonly generations = new Map<string, number>()
  /**
   * Terminal ids that are ALIVE right now (Sol r8 P1 follow-up — liveness is
   * represented, not inferred). A CWD rebind retires and immediately
   * respawns the SAME terminal id; while that reborn generation sat idle it
   * carried no hold or mark, so the tombstone bound could evict it and drop
   * `generationOf` back to 0 — current-generation asks then read as retired
   * while an ancient generation-0 leg passed the checks again. Registered
   * ids are never evicted; eviction applies only to ids FORGOTTEN
   * (permanently removed) once their bounded tombstone window drains. The
   * conductor wires registerTerminal at spawn and forgetTerminal at node
   * removal.
   */
  private readonly live = new Set<string>()
  /** terminalId → the generation whose input buffer holds cancelled residue. */
  private readonly contaminated = new Map<string, number>()
  /**
   * terminalId → the generation carrying an UNCONFIRMED dispatch delivery
   * (Sol r11 P0-3): its paste crossed (or is crossing) the pane boundary and
   * no downstream witness has proven the submit consumed it. While set, every
   * submit-capable producer refuses — owner included, exactly like
   * contamination — but unlike contamination the transcript witness
   * (`witnessConsumed`) clears it without a terminal restart.
   */
  private readonly dispatchResidue = new Map<string, number>()
  /** terminalId → the generation whose input box holds owner typing (r8 P0-1). */
  private readonly ownerEditing = new Map<string, number>()
  /**
   * Retirement observers (Sol r8 P1): the abort seam. A native prompt child
   * blocked inside execFile cannot poll the generation it captured; whoever
   * holds its AbortController subscribes here and aborts when the terminal's
   * lifetime ends. Notified AFTER the retire's own state changes land, so a
   * listener observing the lease sees the retired world.
   */
  private readonly retireListeners = new Set<(terminalId: string) => void>()

  /** The terminal's current lifetime generation (0 until first retire). */
  generationOf(terminalId: string): number {
    return this.generations.get(terminalId) ?? 0
  }

  /**
   * The terminal id EXISTS: pin its generation entry against tombstone
   * eviction for as long as it lives. Idempotent; a retire between register
   * calls (a CWD rebind's retire-then-respawn) keeps the pin — the entry
   * belongs to the id's lifetime, not to any one generation.
   *
   * EXISTENCE, not attachment (Sol r10 P1): registration is about the durable
   * terminal NODE — its pane may be alive with no PTY attach in this process
   * (an inactive workspace, a background dispatch target). Wiring it only at
   * spawn left exactly those attach-free targets unpinned; seedLive covers
   * them at store load. Registration is also a first-sight point: a durable
   * provenance fact recorded by the previous process adopts here.
   */
  registerTerminal(terminalId: string): void {
    this.adopt(terminalId)
    this.live.add(terminalId)
  }

  /**
   * Pin EVERY terminal node the workspace store knows about, attached or not
   * (Sol r10 P1) — called by the conductor once at store load, before any
   * dispatch can target a cold detached node. Idempotent per id (registration
   * is a Set add), so overlapping seeds and later spawnTracked registrations
   * compose.
   */
  seedLive(ids: Iterable<string>): void {
    for (const id of ids) this.registerTerminal(id)
  }

  /**
   * The terminal id is PERMANENTLY gone (node removed, workspace removed,
   * terminal cut): release the liveness pin. The generation entry remains as
   * an ordinary bounded tombstone so stale async legs still fail their
   * generation checks until the tombstone window drains — exactly the
   * pre-liveness behavior for dead ids.
   *
   * IDEMPOTENT and order-free (Sol r10 P1): a Set delete, so every permanent
   * removal path — removeNode, workspace delete, both cut legs — calls it
   * without coordinating; double-forget and forget-then-register both behave.
   */
  forgetTerminal(terminalId: string): void {
    this.live.delete(terminalId)
  }

  /**
   * LOGICAL terminal retirement (Sol r7 P1, split per Sol r11 P1): bump the
   * generation so every hold acquired in the old lifetime becomes invisible —
   * a stale async leg's late release no-ops, and the reborn terminal's
   * producers acquire freely. The dead hold itself is DELETED (Sol r8 P2),
   * not merely hidden: retired ids are UUIDs that never return, and hiding
   * kept their entries for the process lifetime. Contamination and the
   * owner-editing mark die IN MEMORY with the generation — retirement is the
   * ONLY exit for contamination (Sol r8 P0-2). Wired by the conductor into
   * retireTerminal and backend death.
   *
   * The DURABLE provenance fact deliberately SURVIVES this call (Sol r11 P1):
   * retire is a bookkeeping statement, not proof the pane died — every caller
   * kills best-effort AFTERWARDS, and a kill that fails (or is never awaited)
   * leaves the real pane alive with its real input box. Only
   * `clearProvenanceOnDeath` — called after killAndWait POSITIVELY proves
   * pane death — clears the WAL record; until then a recover/rebind of the
   * surviving pane re-adopts the fact fail-closed.
   */
  retire(terminalId: string): void {
    this.retireOne(terminalId)
  }

  /**
   * Pane death PROVEN (Sol r11 P1): the kill was awaited and the backend
   * confirmed the session gone, so the input box the WAL fact described no
   * longer exists anywhere. This is the ONE durable provenance clear that
   * retirement can produce. Kill failure must NOT call this — the fact stays
   * (see noteKillFailed for the fail-closed upgrade).
   */
  clearProvenanceOnDeath(terminalId: string): void {
    this.contaminated.delete(terminalId)
    this.dispatchResidue.delete(terminalId)
    this.ownerEditing.delete(terminalId)
    this.provenance?.clear(terminalId)
  }

  /**
   * The kill FAILED — the pane survived with its real input box (Sol r11 P1).
   * Every fact keeps standing fail-closed, and an unconfirmed dispatch
   * delivery is UPGRADED to contamination: its witness path died with the
   * process that was watching for it, so the residue is now KNOWN stranded
   * until a future kill actually succeeds.
   */
  noteKillFailed(terminalId: string): void {
    const generation = this.generationOf(terminalId)
    const residueInMemory = this.dispatchResidue.get(terminalId) === generation
    const residueDurable = this.provenance?.recordOf(terminalId) === 'dispatch-delivery'
    if (!residueInMemory && !residueDurable) return
    this.dispatchResidue.delete(terminalId)
    this.contaminated.set(terminalId, generation)
    this.provenance?.markContaminated(terminalId)
  }

  /**
   * PROCESS SHUTDOWN, not pane endings (Sol r10 P1): bump every known
   * generation so each in-flight leg — native asks blocked in their CLI
   * children foremost — observes retirement (onRetire fires per id, aborting
   * their controllers) and every stranded hold dies with this process instead
   * of pinning state into teardown. The panes themselves stay ALIVE for the
   * next launch, which is exactly why this is NOT a durable clear: the WAL's
   * dirty/contaminated facts describe input boxes that survive the quit and
   * must be adopted by the next process. Only `retire` — a permanent pane
   * ending — clears the durable record.
   */
  retireAll(): void {
    // Shutdown upgrade (Sol r11 P0-3): a dispatch delivery still unresolved
    // at quit was cancelled by the teardown itself — its transcript witness
    // will never arrive in this process, so the durable fact hardens to
    // contamination before the generations die.
    this.provenance?.upgradeUnresolvedDeliveries()
    const known = new Set<string>([
      ...this.live,
      ...this.generations.keys(),
      ...this.holds.keys(),
      ...this.contaminated.keys(),
      ...this.dispatchResidue.keys(),
      ...this.ownerEditing.keys()
    ])
    for (const id of known) this.retireOne(id)
  }

  /**
   * One LOGICAL retirement. Durable provenance is untouched by design (Sol
   * r11 P1): panes end by kill, and only a proven kill clears the WAL —
   * `clearProvenanceOnDeath`, after the conductor's killAndWait.
   */
  private retireOne(terminalId: string): void {
    const next = this.generationOf(terminalId) + 1
    this.holds.delete(terminalId)
    // Delete-then-set refreshes Map insertion order, so the tombstone bound
    // below reclaims oldest-retired first.
    this.generations.delete(terminalId)
    this.generations.set(terminalId, next)
    this.contaminated.delete(terminalId)
    this.dispatchResidue.delete(terminalId)
    this.ownerEditing.delete(terminalId)
    this.boundGenerations()
    for (const listener of [...this.retireListeners]) listener(terminalId)
  }

  /**
   * Observe retirements (Sol r8 P1). Returns the unsubscribe; callers pair it
   * with their own settle path in a `finally` so the set stays bounded by
   * in-flight work.
   */
  onRetire(listener: (terminalId: string) => void): () => void {
    this.retireListeners.add(listener)
    return () => {
      this.retireListeners.delete(listener)
    }
  }

  /**
   * Claim the terminal's submission window. 'acquired' means the caller may
   * write its irreversible bytes and MUST release (in a `finally`) once the
   * submission is acknowledged. Any other outcome means another producer's
   * submission is in flight (or the caller's lifetime is over) and names
   * which, so the caller can refuse honestly. There is NO displacement: a
   * held window is only ever freed by its holder's release or by `retire`.
   */
  acquire(
    terminalId: string,
    holder: ProducerHolder,
    opts: AcquireOptions = {}
  ): LeaseOutcome {
    const generation = this.generationOf(terminalId)
    if (opts.generation !== undefined && opts.generation !== generation) return 'retired'
    const held = this.liveHold(terminalId)
    if (held === undefined) {
      this.holds.set(terminalId, { holder, depth: 1, generation })
      return 'acquired'
    }
    if (sameHolder(held.holder, holder)) {
      this.holds.set(terminalId, { ...held, depth: held.depth + 1 })
      return 'acquired'
    }
    return held.holder.kind === 'dispatch' ? 'held-by-dispatch' : 'held-by-owner'
  }

  /**
   * Release one acquire. Holder-checked AND generation-checked: a stranger's
   * release is a no-op, and so is a late release arriving from a retired
   * lifetime — the reborn terminal's window cannot be freed by the dead leg's
   * `finally`. Reentrant holds release pairwise — the window frees only when
   * the depth returns to zero. Honest limit: a release names its HOLDER, so
   * two holds with the same identity on either side of a retire would pair —
   * impossible in practice, because owner askIds are minted per submission
   * and dispatch ids per record.
   */
  release(terminalId: string, holder: ProducerHolder): void {
    const held = this.liveHold(terminalId)
    if (held === undefined || !sameHolder(held.holder, holder)) return
    if (held.depth > 1) {
      this.holds.set(terminalId, { ...held, depth: held.depth - 1 })
      return
    }
    this.holds.delete(terminalId)
  }

  /** Who holds the terminal's submission window right now, or null. */
  holderOf(terminalId: string): ProducerHolder | null {
    return this.liveHold(terminalId)?.holder ?? null
  }

  /**
   * Record that the terminal's input box holds a cancelled delivery's paste
   * (cancelled after the paste write, before the CR). Generation-checked:
   * `generation` is the lifetime the paste was written in, and marking
   * no-ops when the terminal has since been retired — the residue died with
   * the process, and the flag must not stain the reborn input box.
   */
  markContaminated(terminalId: string, generation?: number): void {
    const current = this.generationOf(terminalId)
    if (generation !== undefined && generation !== current) return
    this.contaminated.set(terminalId, current)
    // Durable too (Sol r10 P0-1): the stranded paste sits in a pane that
    // outlives this process, so the fact must outlive it as well.
    this.provenance?.markContaminated(terminalId)
  }

  /**
   * Must every submit-capable producer refuse at this terminal's box? True
   * for cancelled-delivery contamination — whose only exit is retirement
   * (Sol r8 P0-2): no byte this process can send or observe PROVES a
   * multi-line residue gone — AND for unconfirmed dispatch-delivery residue
   * (Sol r11 P0-3), which exits through the transcript witness instead.
   *
   * The residue rides THIS query on purpose: the dispatch delivery legs (and
   * every other producer) already consult isContaminated before their
   * irreversible submission, so folding the residue in blocks owner and
   * dispatch alike with no new call sites. hasDispatchResidue names which
   * fact refused when the message matters.
   */
  isContaminated(terminalId: string): boolean {
    this.adopt(terminalId)
    const generation = this.generationOf(terminalId)
    return (
      this.contaminated.get(terminalId) === generation ||
      this.dispatchResidue.get(terminalId) === generation
    )
  }

  /** Is the refusing fact specifically an unconfirmed dispatch delivery? */
  hasDispatchResidue(terminalId: string): boolean {
    this.adopt(terminalId)
    return this.dispatchResidue.get(terminalId) === this.generationOf(terminalId)
  }

  /**
   * The owner's typing entered the shared input box (Sol r8 P0-1): the first
   * meaningful owner byte acquires this mark, and the tracker keeps it while
   * its prompt-buffer model of the box holds owner text. Generation-checked
   * like contamination — a mark racing a retire must not stain the reborn
   * terminal's box.
   */
  markOwnerEditing(terminalId: string, generation?: number): void {
    const current = this.generationOf(terminalId)
    if (generation !== undefined && generation !== current) return
    this.ownerEditing.set(terminalId, current)
    // Belt for the WAL: the PTY write path already recorded the dirty fact
    // before the byte crossed (noteBytesEntering); bytes that reached the
    // tracker some other way (noteExternalInput) still land here. Debounced —
    // an existing record costs nothing.
    this.provenance?.markDirty(terminalId)
  }

  /**
   * The MODEL saw the box consumed (Sol r9 P0-1/P0-2, demoted to observation
   * per Sol r11 P0-2): an observed owner submit emptied the tracker's buffer
   * model, so the in-memory composing mark drops — owner typing and dispatch
   * admission resume on the model's word, exactly as before. The DURABLE
   * record deliberately STANDS: the submit the model observed is a local
   * input-stream echo — an enqueue, not proof the bytes crossed the
   * asynchronous PTY write and consumed the real box. It clears when a
   * downstream witness lands (`witnessConsumed`, wired from the session-file
   * reconcile and the scrape's settled turn), and until then a crash adopts
   * the box dirty — the safe direction. The store is told about the local
   * consumption so bytes typed AFTER this submit re-stamp the record's
   * markedAt and the earlier submit's witness cannot clear their protection.
   */
  clearOwnerEditing(terminalId: string): void {
    // Adopt BEFORE clearing: a pending durable fact must not resurrect the
    // mark on the next query after proof already consumed it here.
    this.adopt(terminalId)
    this.ownerEditing.delete(terminalId)
    this.provenance?.noteLocalConsumption(terminalId)
  }

  /**
   * The one PROVEN local clear (Sol r9 P0-2, kept per Sol r11 P0-2): Ctrl-U
   * on a single-line buffer the model watched being typed byte by byte. The
   * bytes were erased IN the box, so there is nothing left for a downstream
   * witness to consume — the durable record clears here, unless a stronger
   * fact (contamination, unconfirmed delivery) stands.
   */
  clearOwnerEditingProven(terminalId: string): void {
    this.adopt(terminalId)
    this.ownerEditing.delete(terminalId)
    const generation = this.generationOf(terminalId)
    if (this.contaminated.get(terminalId) === generation) return
    if (this.dispatchResidue.get(terminalId) === generation) return
    const durable = this.provenance?.recordOf(terminalId)
    if (durable === 'contaminated' || durable === 'dispatch-delivery') return
    this.provenance?.clear(terminalId)
  }

  /**
   * THE DOWNSTREAM WITNESS (Sol r11 P0-2/P0-3): the transcript (or a settled
   * scrape turn) proved a submit at/after the mark consumed the shared box.
   * Clears the owner-editing mark, the dispatch residue, and the durable
   * record — everything except contamination, whose only exit stays proven
   * pane death. Wired by the tracker from the session-file reconcile
   * (afterCommit) and the scrape's turn settlement.
   */
  witnessConsumed(terminalId: string): void {
    this.adopt(terminalId)
    this.dispatchResidue.delete(terminalId)
    if (this.provenance !== null && this.provenance.recordOf(terminalId) !== 'contaminated') {
      this.provenance.clear(terminalId)
    }
    // An owner-editing mark still standing here describes bytes that did NOT
    // ride the witnessed submit — typing the guard admitted beside a
    // dispatch's turn, or an adopted composition nothing has consumed. The
    // mark survives and its durable protection is re-recorded; only the
    // ordinary owner clears (observed submit + its own witness, the proven
    // erase, proven pane death) end it.
    if (this.ownerEditing.get(terminalId) === this.generationOf(terminalId)) {
      this.provenance?.markDirty(terminalId)
    }
  }

  /** The durable fact's full detail — the tracker's witness reads this. */
  provenanceDetail(terminalId: string): ProvenanceDetail | null {
    return this.provenance?.detailOf(terminalId) ?? null
  }

  /** Is the owner composing in this terminal's input box right now? */
  isOwnerEditing(terminalId: string): boolean {
    this.adopt(terminalId)
    return this.ownerEditing.get(terminalId) === this.generationOf(terminalId)
  }

  /**
   * WRITE-AHEAD dirty fact (Sol r10 P0-1, refusal-bearing per Sol r11 P0-1):
   * called by the PTY write paths — tagged and untagged alike — BEFORE the
   * bytes cross the pane boundary, and by pasteAndSubmit before its paste
   * write. `data`, when given, lets the store skip chunks that cannot leave
   * input-box content (mouse reports, arrows, a bare Enter — see
   * dirtiesInputBox; submit-carrying content chunks now MARK, Sol r11 P0-2).
   * Purely durable: the in-memory owner-editing mark stays the tracker's to
   * maintain, because a dispatch's own tagged paste dirties the BOX without
   * being owner composition.
   *
   * Returns FALSE when the WAL could not commit the fact durably — the
   * caller MUST refuse the pane write. Storeless leases (tests, embedders)
   * always allow: they never promised durability.
   */
  noteBytesEntering(terminalId: string, data?: string): boolean {
    return this.provenance?.markDirty(terminalId, data) ?? true
  }

  /**
   * The dispatch delivery's own WRITE-AHEAD fact (Sol r11 P0-3), called by
   * PtySession.writeFromDispatch before the paste crosses: producer identity
   * AND the delivered body land durably first, and the in-memory residue
   * blocks every submit-capable producer from this instant until the
   * transcript witnesses the delivered prompt consumed (witnessConsumed) or
   * the pane provably dies. Non-content chunks (the delivery's own trailing
   * CR) mark nothing. Same refusal contract as noteBytesEntering.
   */
  noteDispatchBytesEntering(terminalId: string, data: string): boolean {
    if (!dirtiesInputBox(data)) {
      return this.provenance?.markDirty(terminalId, data) ?? true
    }
    this.dispatchResidue.set(terminalId, this.generationOf(terminalId))
    return this.provenance?.markDispatchDelivery(terminalId, pastedBodyOf(data)) ?? true
  }

  /**
   * First sight of a terminal id in this process: adopt the previous
   * process's durable fact fail-closed — 'owner-dirty' as the owner-editing
   * mark, 'dispatch-delivery' as everyone-blocking residue (Sol r11 P0-3),
   * 'contaminated' as contamination — at the CURRENT generation, from where
   * the ordinary clear rules (downstream witness, proven single-line clear,
   * retirement/proven death) govern it. Absence adopts clean: every dirtying
   * write was WAL-first, so no record is evidence of an empty box — unless
   * the load itself FAULTED, in which case the store answers 'owner-dirty'
   * for every id (Sol r11 P0-1). The false-dirty asymmetry (crash between
   * WAL mark and byte write) resolves through the same rules.
   */
  private adopt(terminalId: string): void {
    if (this.provenance === null) return
    const fact = this.provenance.takeAdoptable(terminalId)
    if (fact === null) return
    const current = this.generationOf(terminalId)
    if (fact === 'contaminated') this.contaminated.set(terminalId, current)
    else if (fact === 'dispatch-delivery') this.dispatchResidue.set(terminalId, current)
    else this.ownerEditing.set(terminalId, current)
  }

  /**
   * Entry counts, for the growth gates (Sol r8 P2) and diagnostics. Retired
   * ids must not accumulate: holds/contamination/editing die at retire, and
   * generation tombstones are bounded by GENERATION_TOMBSTONES.
   */
  mapSizes(): {
    holds: number
    generations: number
    contaminated: number
    dispatchResidue: number
    ownerEditing: number
    live: number
  } {
    return {
      holds: this.holds.size,
      generations: this.generations.size,
      contaminated: this.contaminated.size,
      dispatchResidue: this.dispatchResidue.size,
      ownerEditing: this.ownerEditing.size,
      live: this.live.size
    }
  }

  /** The current-generation hold, treating a dead generation's as absent. */
  private liveHold(terminalId: string): Hold | undefined {
    const held = this.holds.get(terminalId)
    if (held === undefined || held.generation !== this.generationOf(terminalId)) return undefined
    return held
  }

  /**
   * Keep the generation tombstones bounded (Sol r8 P2, liveness-aware per
   * r9). Oldest-retired ids are reclaimed first (retire refreshes insertion
   * order). Never reclaimed: a REGISTERED (live) id — its rebound generation
   * must survive any amount of churn, because dropping it to zero would make
   * current-generation asks read as retired and readmit ancient generation-0
   * legs — and an id still carrying a hold or mark. Reclaiming a truly dead,
   * forgotten tombstone re-opens only a negligible window: its stale legs
   * would need to return after ~a thousand later retires AND carry a
   * captured generation of exactly zero.
   */
  private boundGenerations(): void {
    if (this.generations.size <= GENERATION_TOMBSTONES) return
    for (const id of this.generations.keys()) {
      if (this.generations.size <= GENERATION_TOMBSTONES) return
      if (this.live.has(id)) continue
      if (
        this.holds.has(id) ||
        this.contaminated.has(id) ||
        this.dispatchResidue.has(id) ||
        this.ownerEditing.has(id)
      ) {
        continue
      }
      this.generations.delete(id)
    }
  }
}

/** Mint one owner submission's identity — each ask is its own producer. */
export function ownerHolder(): ProducerHolder {
  return { kind: 'owner', askId: randomUUID() }
}

/**
 * The process-wide lease every producer shares by default. One instance is
 * the entire point: ownerSubmit/askTerminal, the dispatch delivery legs and
 * the tracker's PTY guard must all see the SAME holds, or the lease reserves
 * nothing. Tests inject their own instances; production takes this one
 * everywhere.
 */
let shared: ProducerLease | null = null

export function defaultProducerLease(): ProducerLease {
  if (shared === null) shared = new ProducerLease()
  return shared
}
