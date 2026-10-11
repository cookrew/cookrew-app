/**
 * WHICH ROUTE STATE IS THE NEWEST.
 *
 * The renderer learns the gateway's state three ways: a read it asked for, a
 * push main sent, and the answer to its own default pick. A read is computed
 * when main gets round to it and lands when the link delivers it — on the
 * companion that is a GET through whatever plane carries the session, and on
 * the desktop a probe that can take seconds. A push or a pick that landed in
 * between is newer than the read whatever the read says, so the read is
 * dropped: applying it would show the owner a default they no longer have.
 *
 * One counter: every state applied bumps it; a read remembers the count when
 * it was issued and applies only if nothing was applied since.
 */
export interface RouteOrder {
  /** The count to remember when a read is issued. */
  issue: () => number
  /** True when nothing newer landed since the read was issued. */
  stillNewest: (issued: number) => boolean
  /** A state is applied, whatever its source. */
  applied: () => void
}

export function createRouteOrder(): RouteOrder {
  let seq = 0
  return {
    issue: () => seq,
    stillNewest: (issued) => issued === seq,
    applied: () => {
      seq += 1
    }
  }
}
