// THE ONE-PRODUCER LEASE (Sol r6 P0-1, hardened per Sol r7): one submission
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
// CONTAMINATION (Sol r7 P0-1): a delivery cancelled AFTER its paste write but
// BEFORE its CR leaves the cancelled prompt sitting in the TUI's shared input
// box. That buffer is no longer any producer's clean slate — the next submit
// at the terminal would carry the cancelled text. The flag records that fact
// at the lease (the one object every producer already consults); while set,
// every submit-capable write refuses, until the owner clears the box (see
// TurnTracker.handleInput) or the terminal is retired (fresh process, fresh
// box). Marking is generation-checked so a retire that raced the cancellation
// never stains the reborn terminal.
//
// NO TIMERS, on purpose: the lease never expires a hold on its own. Every
// caller owns its hold's lifetime and releases in a `finally`; a retired
// holder's release is a no-op, so retirement and orderly release compose.
//
// Pure map-over-ids state, no I/O — the whole matrix is unit-testable.

import { randomUUID } from 'node:crypto'

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
  private readonly holds = new Map<string, Hold>()
  /** terminalId → current generation; absent reads as 0. */
  private readonly generations = new Map<string, number>()
  /** terminalId → the generation whose input buffer holds cancelled residue. */
  private readonly contaminated = new Map<string, number>()

  /** The terminal's current lifetime generation (0 until first retire). */
  generationOf(terminalId: string): number {
    return this.generations.get(terminalId) ?? 0
  }

  /**
   * Permanent terminal ending (Sol r7 P1): bump the generation so every hold
   * acquired in the old lifetime becomes invisible — a stale async leg's late
   * release no-ops, and the reborn terminal's producers acquire freely.
   * Contamination dies with the process whose input box carried it. Wired by
   * the conductor into retireTerminal and backend death.
   */
  retire(terminalId: string): void {
    this.generations.set(terminalId, this.generationOf(terminalId) + 1)
    this.contaminated.delete(terminalId)
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
  }

  /** Does the terminal's input box hold cancelled-delivery residue? */
  isContaminated(terminalId: string): boolean {
    return this.contaminated.get(terminalId) === this.generationOf(terminalId)
  }

  /**
   * The owner acknowledged and cleared the residue (an explicit line-clear
   * typed at the terminal — see TurnTracker.handleInput). Submits flow again.
   */
  clearContaminated(terminalId: string): void {
    this.contaminated.delete(terminalId)
  }

  /** The current-generation hold, treating a dead generation's as absent. */
  private liveHold(terminalId: string): Hold | undefined {
    const held = this.holds.get(terminalId)
    if (held === undefined || held.generation !== this.generationOf(terminalId)) return undefined
    return held
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
