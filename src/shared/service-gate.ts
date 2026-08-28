// R30 — the gate at the door of a served crew.
//
// WHAT NARROWED. A service exposes ONE callee: the orch agent. That deletes
// the per-agent grant matrix for services outright — there is no caller×agent
// cell to fill in, because there is one door. And entitlement moves from
// per-preset-download to PER SESSION: starting a session IS the purchase, and
// every turn inside it draws down (R12) without buying anything again.
//
// THE RULE THIS MODULE EXISTS TO HOLD: a caller who paid for a session has
// bought THAT SESSION. Nothing the author does afterwards — unlisting, cutting
// V2, changing the price — may take it away mid-conversation. Her work is
// against the crew she paid for. So `listed: false` stops the service being
// SOLD; it does not reach into a conversation and end it.
//
// Pure, and ordered like the v4 gate: the EARLIEST failing step wins, so a
// refusal never leaks what a later step would have said. Wrong-callee outranks
// everything, including unlisted and anonymous, because the address is the
// only thing a caller is entitled to learn.

/** The two ways a crew can be served. There is no third. */
export type ServeMode = 'free-with-signin' | 'priced'

export interface ServePrice {
  /** Decimal string, as the manifest carries it. */
  amount: string
  asset: 'USDC'
}

export interface ServeConfig {
  mode: ServeMode
  /**
   * The ONE agent this service answers as — the orch. Singular by type, so a
   * grant matrix cannot grow back by someone adding a second entry.
   */
  callee: string
  /**
   * Is the service being offered right now? Unlisting flips this. It gates NEW
   * sessions only; see the module note.
   */
  listed: boolean
  /** Required when mode is 'priced'. Absent is a misconfiguration, not free. */
  pricePerSession?: ServePrice
}

export interface SessionFacts {
  /** Has the caller completed the identity ceremony (401)? */
  signedIn: boolean
  /** This caller's session for this service, when one exists. */
  session: { id: string; state: 'live' | 'ended'; paid: boolean } | null
}

export type ServeReason =
  | 'ok'
  | 'not-the-callee'
  | 'not-served'
  | 'sign-in'
  | 'pay-for-session'
  | 'session-ended'
  | 'misconfigured'

export interface ServeDecision {
  status: 200 | 401 | 402 | 404 | 503
  reason: ServeReason
  /** What to quote. Present ONLY when a purchase is what unblocks the call. */
  charge?: ServePrice
}

export function serveDecision(
  config: ServeConfig,
  facts: SessionFacts,
  requestedAgent: string
): ServeDecision {
  // 1 — THE ADDRESS. A service has one door. Asking for another agent is not
  // an entitlement question, so it is 404 and not 403: a 403 would tell a
  // stranger that the agent exists and they merely lack a grant, which is
  // exactly the enumeration the single-callee model removes.
  if (requestedAgent !== config.callee) return { status: 404, reason: 'not-the-callee' }

  // 2 — IS IT OFFERED? Before identity, because there is nothing to sign in
  // FOR. A live paid session bypasses this: unlisting withdraws the offer, it
  // does not repossess a conversation someone already bought.
  const live = facts.session?.state === 'live' && facts.session.paid
  if (!config.listed && !live) return { status: 404, reason: 'not-served' }

  // 3 — WHO. Identity precedes payment always: quoting a price to someone we
  // cannot name would bill a stranger.
  if (!facts.signedIn) return { status: 401, reason: 'sign-in' }

  if (config.mode === 'free-with-signin') return { status: 200, reason: 'ok' }

  // 4 — PAYMENT, per SESSION. A misconfigured priced service is refused rather
  // than served free: giving the author's work away on a missing field is the
  // worse failure, and 503 says the service is not answering rather than that
  // the caller did something wrong.
  const price = config.pricePerSession
  if (price === undefined) return { status: 503, reason: 'misconfigured' }

  if (facts.session === null) return { status: 402, reason: 'pay-for-session', charge: price }
  if (facts.session.state === 'ended') {
    // END is the caller's own act. Reviving on the next call would resurrect a
    // sandbox they finished with, for free.
    return { status: 402, reason: 'session-ended', charge: price }
  }
  if (!facts.session.paid) return { status: 402, reason: 'pay-for-session', charge: price }

  // Live and paid. Every turn from here draws down per R12 — no charge here,
  // because the session was the sale.
  return { status: 200, reason: 'ok' }
}
