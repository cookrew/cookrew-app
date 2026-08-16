// THE ONE-PRODUCER LEASE (Sol r6 P0-1): one submission window per terminal.
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
// WHO YIELDS TO WHOM:
// - dispatch vs owner-held    → refused (the dispatch fails honestly; the
//   caller may retry once the owner's submission settles).
// - owner vs dispatch-held    → the owner runs the existing durable preemption
//   (interrupt the dispatch, prove the row committed) and only THEN displaces
//   the holder via `displaceDispatch` — an uncommitted preemption never
//   acquires.
// - owner vs owner-held       → refused honestly ('another owner submission is
//   in flight'); owner submissions never displace each other.
// - same holder               → reentrant (depth-counted; release pairs with
//   acquire).
//
// NO TIMERS, on purpose: the lease never expires a hold on its own. Every
// caller owns its hold's lifetime and releases in a `finally`; a displaced
// holder's release is a no-op, so takeover and orderly release compose.
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

export type LeaseOutcome = 'acquired' | 'held-by-owner' | 'held-by-dispatch'

export interface AcquireOptions {
  /**
   * The caller PROVED a committed preemption of the dispatch that holds this
   * terminal (the interrupt row durably landed), and may displace it. Only a
   * dispatch holder is displaceable — an owner holder never is, because
   * nothing preempts an owner submission mid-flight.
   */
  displaceDispatch?: boolean
}

/** One hold: the holder plus its reentrancy depth. Replaced, never mutated. */
interface Hold {
  readonly holder: ProducerHolder
  readonly depth: number
}

function sameHolder(a: ProducerHolder, b: ProducerHolder): boolean {
  if (a.kind === 'owner' && b.kind === 'owner') return a.askId === b.askId
  if (a.kind === 'dispatch' && b.kind === 'dispatch') return a.dispatchId === b.dispatchId
  return false
}

export class ProducerLease {
  private readonly holds = new Map<string, Hold>()

  /**
   * Claim the terminal's submission window. 'acquired' means the caller may
   * write its irreversible bytes and MUST release (in a `finally`) once the
   * submission is acknowledged. Any other outcome means another producer's
   * submission is in flight and names which kind, so the caller can refuse
   * honestly or (owner over dispatch) run the durable preemption and retry
   * with `displaceDispatch`.
   */
  acquire(
    terminalId: string,
    holder: ProducerHolder,
    opts: AcquireOptions = {}
  ): LeaseOutcome {
    const held = this.holds.get(terminalId)
    if (held === undefined) {
      this.holds.set(terminalId, { holder, depth: 1 })
      return 'acquired'
    }
    if (sameHolder(held.holder, holder)) {
      this.holds.set(terminalId, { holder: held.holder, depth: held.depth + 1 })
      return 'acquired'
    }
    if (held.holder.kind === 'dispatch') {
      if (opts.displaceDispatch === true && holder.kind === 'owner') {
        // Takeover: the displaced dispatch's own release becomes a no-op
        // (holder mismatch), so the leg unwinding out of promptAgent cannot
        // free a window it no longer owns.
        this.holds.set(terminalId, { holder, depth: 1 })
        return 'acquired'
      }
      return 'held-by-dispatch'
    }
    return 'held-by-owner'
  }

  /**
   * Release one acquire. Holder-checked: a displaced (or plain wrong) holder's
   * release is a no-op, so a takeover can never be un-done by the loser's
   * `finally`. Reentrant holds release pairwise — the window frees only when
   * the depth returns to zero.
   */
  release(terminalId: string, holder: ProducerHolder): void {
    const held = this.holds.get(terminalId)
    if (held === undefined || !sameHolder(held.holder, holder)) return
    if (held.depth > 1) {
      this.holds.set(terminalId, { holder: held.holder, depth: held.depth - 1 })
      return
    }
    this.holds.delete(terminalId)
  }

  /** Who holds the terminal's submission window right now, or null. */
  holderOf(terminalId: string): ProducerHolder | null {
    return this.holds.get(terminalId)?.holder ?? null
  }
}

/** Mint one owner submission's identity — each ask is its own producer. */
export function ownerHolder(): ProducerHolder {
  return { kind: 'owner', askId: randomUUID() }
}

/**
 * The process-wide lease every producer shares by default. One instance is
 * the entire point: askTerminal, the dispatch delivery legs and the tracker's
 * PTY guard must all see the SAME holds, or the lease reserves nothing. Tests
 * inject their own instances; production takes this one everywhere.
 */
let shared: ProducerLease | null = null

export function defaultProducerLease(): ProducerLease {
  if (shared === null) shared = new ProducerLease()
  return shared
}
