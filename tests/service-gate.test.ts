import { describe, expect, it } from 'vitest'
import {
  serveDecision,
  type ServeConfig,
  type SessionFacts
} from '../src/shared/service-gate'

// R30 — the gate at the door, narrowed.
//
// A service exposes ONE callee (the orch agent), so the per-agent grant matrix
// disappears for services: there is no caller×agent cell to fill in, because
// there is one door. And entitlement moves from per-preset-download to
// PER-SESSION — starting a session IS the purchase, and every turn inside it
// draws down (R12) without buying anything again.
//
// The load-bearing consequence, and the reason this is a module rather than an
// if: a caller who paid for a session has bought THAT SESSION. Nothing the
// author does afterwards — unlisting, cutting V2, changing the price — may
// take it away mid-conversation. "Her work is against the crew she paid for."

const FREE: ServeConfig = { mode: 'free-with-signin', callee: 'Conductor', listed: true }
const PRICED: ServeConfig = {
  mode: 'priced',
  callee: 'Conductor',
  listed: true,
  pricePerSession: { amount: '2.50', asset: 'USDC' }
}

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  signedIn: true,
  session: null,
  ...over
})

describe('one callee — the matrix is gone', () => {
  it('serves the configured orch agent', () => {
    expect(serveDecision(FREE, facts(), 'Conductor').status).toBe(200)
  })

  it('refuses any OTHER agent by name, without consulting a grant list', () => {
    // There is no per-agent cell to look up. A service has one door, so
    // asking for a different agent is not an entitlement question at all — it
    // is a wrong address, and answering 403 would imply a grant might exist.
    const decision = serveDecision(FREE, facts(), 'Velvet')
    expect(decision.status).toBe(404)
    expect(decision.reason).toBe('not-the-callee')
  })

  it('does not leak which agents the author actually runs', () => {
    // 404 for every non-callee, whether or not that agent exists behind the
    // service. The address is the only thing a caller may learn.
    for (const name of ['Velvet', 'Magpie', 'does-not-exist']) {
      expect(serveDecision(FREE, facts(), name).status).toBe(404)
    }
  })
})

describe('free-with-signin — 401 is the whole gate', () => {
  it('refuses an anonymous caller with 401', () => {
    const decision = serveDecision(FREE, facts({ signedIn: false }), 'Conductor')
    expect(decision.status).toBe(401)
  })

  it('admits a signed-in caller with no payment anywhere in the path', () => {
    const decision = serveDecision(FREE, facts(), 'Conductor')
    expect(decision.status).toBe(200)
    expect(decision.charge).toBeUndefined()
  })
})

describe('priced — start a session IS the purchase', () => {
  it('401s before 402: identity precedes payment', () => {
    // Asking an anonymous caller to pay would bill someone we cannot name.
    const decision = serveDecision(PRICED, facts({ signedIn: false }), 'Conductor')
    expect(decision.status).toBe(401)
  })

  it('402s a signed-in caller with no session, quoting the SESSION price', () => {
    const decision = serveDecision(PRICED, facts(), 'Conductor')
    expect(decision.status).toBe(402)
    expect(decision.charge).toEqual({ amount: '2.50', asset: 'USDC' })
  })

  it('admits a caller whose session is live and paid — with NO further charge', () => {
    // The whole point of per-session: the second turn is not a second sale.
    const decision = serveDecision(
      PRICED,
      facts({ session: { id: 's1', state: 'live', paid: true } }),
      'Conductor'
    )
    expect(decision.status).toBe(200)
    expect(decision.charge).toBeUndefined()
  })

  it('402s a session that was started but never paid', () => {
    const decision = serveDecision(
      PRICED,
      facts({ session: { id: 's1', state: 'live', paid: false } }),
      'Conductor'
    )
    expect(decision.status).toBe(402)
  })

  it('refuses an ENDED session rather than silently reviving it', () => {
    // END is the caller's own action. Reviving on the next call would charge
    // nothing and resurrect a sandbox they finished with.
    const decision = serveDecision(
      PRICED,
      facts({ session: { id: 's1', state: 'ended', paid: true } }),
      'Conductor'
    )
    expect(decision.status).toBe(402)
    expect(decision.reason).toBe('session-ended')
  })
})

describe('unlist stops SERVING, and does not repossess', () => {
  it('refuses a NEW session once unlisted', () => {
    const decision = serveDecision({ ...PRICED, listed: false }, facts(), 'Conductor')
    expect(decision.status).toBe(404)
    expect(decision.reason).toBe('not-served')
  })

  it('LETS A PAID LIVE SESSION CONTINUE — the caller bought that session', () => {
    // The load-bearing one. Unlisting is the author withdrawing the offer, not
    // reaching into a conversation someone paid for and ending it. A caller
    // mid-session whose service is unlisted keeps working until they END it.
    const decision = serveDecision(
      { ...PRICED, listed: false },
      facts({ session: { id: 's1', state: 'live', paid: true } }),
      'Conductor'
    )
    expect(decision.status).toBe(200)
  })

  it('does not let an unlisted service start a session even for a signed-in caller', () => {
    const decision = serveDecision({ ...FREE, listed: false }, facts(), 'Conductor')
    expect(decision.status).toBe(404)
  })

  it('still refuses the wrong callee first — unlisting reveals nothing new', () => {
    const decision = serveDecision({ ...PRICED, listed: false }, facts(), 'Velvet')
    expect(decision.reason).toBe('not-the-callee')
  })
})

describe('the order, as a matrix', () => {
  // Same discipline as the v4 gate: the EARLIEST failing step wins, so a
  // refusal never leaks what a later step would have said.
  it('callee → listed → identity → payment, in that order', () => {
    const anon = facts({ signedIn: false })
    // Wrong callee outranks everything, including being unlisted and anonymous.
    expect(serveDecision({ ...PRICED, listed: false }, anon, 'Velvet').reason).toBe('not-the-callee')
    // Unlisted outranks identity: there is nothing to sign in FOR.
    expect(serveDecision({ ...PRICED, listed: false }, anon, 'Conductor').reason).toBe('not-served')
    // Identity outranks payment.
    expect(serveDecision(PRICED, anon, 'Conductor').status).toBe(401)
  })

  it('a priced config with no price is refused, not served free', () => {
    // A service set to sell but carrying no price is misconfigured. Serving it
    // free would give away the author's work on a typo.
    const broken = { mode: 'priced', callee: 'Conductor', listed: true } as ServeConfig
    expect(serveDecision(broken, facts(), 'Conductor').status).toBe(503)
  })
})
