import { describe, expect, it, vi } from 'vitest'
import { decideGate, type GateIssuer, type GateInputs } from '../src/shared/gate'

/**
 * THE SHARED DECISION (④ · S1).
 *
 * These exercise the function itself, with no server and no disk on either
 * side. The registry's own A2/A3 suites are the other half of S1's proof: they
 * pass UNCHANGED against a rebound authorize.ts, which is how we know the
 * extraction moved the decision without altering it.
 */

interface Claims {
  sub: string
  scope: string
}

const issuer = (table: Record<string, Claims>): GateIssuer<Claims> => ({
  challenge: () => 'nonce-1',
  verifyToken: (token) => table[token] ?? null
})

const GOOD: Claims = { sub: 'alice', scope: 'download' }

const inputs = (over: Partial<GateInputs<Claims>> = {}): GateInputs<Claims> => ({
  visibility: 'identified',
  credential: 'good',
  issuer: issuer({ good: GOOD }),
  covers: (claims) => (claims.scope === 'download' ? null : 'scope'),
  entitled: () => null,
  ...over
})

describe('decideGate — the order is the protocol', () => {
  it('404s a resource that does not exist here, before asking anything else', () => {
    const asked = vi.fn(() => null)
    const verdict = decideGate(
      inputs({ visibility: null, issuer: { challenge: () => 'n', verifyToken: asked } })
    )
    expect(verdict).toEqual({ code: 404 })
    // Existence is answered without touching the credential: a 401 for a
    // resource that is not here would confirm it is.
    expect(asked).not.toHaveBeenCalled()
  })

  it('serves a public resource with no credential and no claims', () => {
    expect(decideGate(inputs({ visibility: 'public', credential: null }))).toEqual({
      code: 200,
      claims: null
    })
  })

  it('does not consult identity for a public resource', () => {
    const asked = vi.fn(() => GOOD)
    decideGate(
      inputs({
        visibility: 'public',
        credential: 'good',
        issuer: { challenge: () => 'n', verifyToken: asked }
      })
    )
    expect(asked).not.toHaveBeenCalled()
  })

  it('serves an identified resource to a good credential, carrying the claims', () => {
    expect(decideGate(inputs())).toEqual({ code: 200, claims: GOOD })
  })
})

describe('decideGate — absence is never permission', () => {
  it('401s when no credential was presented', () => {
    const verdict = decideGate(inputs({ credential: null }))
    expect(verdict).toEqual({ code: 401, challenge: 'nonce-1' })
  })

  it('answers a missing credential and a bad one IDENTICALLY', () => {
    const missing = decideGate(inputs({ credential: null }))
    const forged = decideGate(inputs({ credential: 'forged' }))
    expect(forged).toEqual(missing)
  })

  it('never reaches 200 for an identified resource without claims', () => {
    // The property, stated as a property: across every way a credential can
    // fail to produce claims, no input yields a served answer.
    for (const credential of [null, '', 'forged', 'expired', 'good.tampered']) {
      const verdict = decideGate(inputs({ credential }))
      expect(verdict.code).toBe(401)
    }
  })

  it('offers a FRESH challenge each refusal, never a reused one', () => {
    let n = 0
    const counting: GateIssuer<Claims> = {
      challenge: () => `nonce-${(n += 1)}`,
      verifyToken: () => null
    }
    const first = decideGate(inputs({ credential: null, issuer: counting }))
    const second = decideGate(inputs({ credential: 'forged', issuer: counting }))
    expect(first).toEqual({ code: 401, challenge: 'nonce-1' })
    expect(second).toEqual({ code: 401, challenge: 'nonce-2' })
  })
})

describe('decideGate — 403 is the answer a client must not retry (D4/R9)', () => {
  it('403s a verified credential that does not cover the resource', () => {
    const publishToken: Claims = { sub: 'alice', scope: 'publish' }
    const verdict = decideGate(
      inputs({ credential: 'p', issuer: issuer({ p: publishToken }) })
    )
    expect(verdict).toEqual({ code: 403, reason: 'scope' })
  })

  it('names the reason, because the reason is what a client acts on', () => {
    const verdict = decideGate(inputs({ covers: () => 'workspace' }))
    expect(verdict).toEqual({ code: 403, reason: 'workspace' })
  })

  it('checks coverage BEFORE entitlement — the cheaper, client-fixable one first', () => {
    const entitled = vi.fn(() => 'balance_empty')
    const verdict = decideGate(inputs({ covers: () => 'scope', entitled }))
    expect(verdict).toEqual({ code: 403, reason: 'scope' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('403s an unentitled caller with the entitlement reason', () => {
    expect(decideGate(inputs({ entitled: () => 'balance_empty' }))).toEqual({
      code: 403,
      reason: 'balance_empty'
    })
  })

  it('passes the verified claims to entitlement, not the raw credential', () => {
    const entitled = vi.fn(() => null)
    decideGate(inputs({ entitled }))
    expect(entitled).toHaveBeenCalledWith(GOOD)
  })
})
