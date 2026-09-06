// A CARD THAT PING-PONGS IS A BUG REPORT, NOT A STATE MACHINE.
//
// 2026-09-06. Conductor's card alternated between two sessions — 295d5f1c and
// a78aa3e5, eight times — because spawn adopted a background job's transcript
// and the oracle sweep put the binding back thirty seconds later. The adoption
// itself is fixed in claude-session-adoption.ts; this is the seatbelt for
// whatever finds the next way in, because the FAILURE MODE is the expensive
// part: the rail jumps between two conversations, the lineage and the event
// log fill with rotations, and a real rotation is impossible to spot among
// them.
//
// THE RULE: a binding never returns to a session it left in the last minute.
// A conversation moves FORWARD — a compaction, a /clear, a resume, a
// held-session fork all mint a session the card has never been bound to — so a
// move BACK onto an id it just left is not a rotation, it is two mechanisms
// disagreeing. The second one is refused and reported once, and the card stays
// where it is until the window closes.
//
// SCOPE — a bounded per-card memory of departures and a pure decision over it.
// No fs, no store, no clock of its own beyond the injected one.

/**
 * How long an id a card LEFT is refused as a destination.
 *
 * 60 s is chosen against the two clocks that can legitimately re-answer within
 * one rotation: the oracle sweep is 30 s (claude-session-oracle.ts,
 * ORACLE_SWEEP_MS) and the spawn-time boot retries run out at 20 s
 * (ORACLE_BOOT_DELAYS_MS). One window therefore covers the whole boot ladder
 * plus two full sweeps — every mechanism has had its say, twice, before an id
 * a card walked away from may be adopted again. Long enough that a flap is
 * broken by the first refusal; short enough that a card is never stuck: a
 * genuine rotation is onto an id nothing has left, and is never damped at all.
 */
export const REBIND_BACKOFF_MS = 60_000

/** How many departures are remembered per card — a flap needs only the last few. */
const DEPARTURES_KEPT = 8

/** A session id a card was bound to and moved off, and when. */
export interface Departure {
  sessionId: string
  /** Epoch ms of the rebind that left it. */
  at: number
}

/**
 * May a binding move to `to`? Pure, so the whole rule is one readable line and
 * the tests do not need a clock.
 */
export function allowsRebind(
  to: string,
  departures: readonly Departure[],
  now: number,
  windowMs: number = REBIND_BACKOFF_MS
): boolean {
  return !departures.some((d) => d.sessionId === to && now - d.at < windowMs)
}

/**
 * Per-card departures, bounded in both directions: at most DEPARTURES_KEPT
 * entries per card, and entries older than the window are dropped as they are
 * passed. Records are replaced, never mutated in place.
 */
export class RebindDamper {
  private readonly departures = new Map<string, readonly Departure[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = REBIND_BACKOFF_MS
  ) {}

  /** Record that `terminalId` moved OFF `sessionId`. */
  left(terminalId: string, sessionId: string): void {
    const at = this.now()
    const kept = this.recent(terminalId, at).filter((d) => d.sessionId !== sessionId)
    this.departures.set(terminalId, [...kept, { sessionId, at }].slice(-DEPARTURES_KEPT))
  }

  /** Whether this card's binding may move onto `sessionId` right now. */
  allows(terminalId: string, sessionId: string): boolean {
    const at = this.now()
    return allowsRebind(sessionId, this.recent(terminalId, at), at, this.windowMs)
  }

  /** Drop a card's memory — its terminal is gone or has been repurposed. */
  forget(terminalId: string): void {
    this.departures.delete(terminalId)
  }

  private recent(terminalId: string, at: number): readonly Departure[] {
    const all = this.departures.get(terminalId) ?? []
    return all.filter((d) => at - d.at < this.windowMs)
  }
}
