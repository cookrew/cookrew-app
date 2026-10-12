// RETRY ONLY RE-SENDS A BRIEF THAT NEVER LANDED (fix/hp-decide round 2, HIGH).
import { describe, expect, it } from 'vitest'
import { retryVerdict, type RetryTargetFacts } from '../src/main/sous-retry'
import type { SousLedgerRow } from '../src/main/sous-ledger'

const row = (patch: Partial<SousLedgerRow>): SousLedgerRow => ({
  token: 'tok',
  at: 1,
  updatedAt: 2,
  sentence: 'push the branch',
  domain: 'repo',
  exposure: 2,
  mode: 'paused',
  target: { id: 'forge', name: 'Forge' },
  alternates: [],
  ownerResponse: 'send-anyway',
  dispatchId: 'd1',
  outcome: 'failed',
  proposalText: 'push the branch\n\nBoundaries: push only after the check passes',
  deliveredTo: 'forge',
  dismissed: false,
  ...patch
})
const idle: RetryTargetFacts = { served: false, phase: 'idle', ownerComposing: false }
const facts = (f: RetryTargetFacts | null) => () => f

describe('retryVerdict', () => {
  it('a failed or interrupted, undismissed proposal into an idle owned card is re-sent — exactly that text, to that card', () => {
    expect(retryVerdict(row({}), facts(idle))).toEqual({ ok: true, nodeId: 'forge', text: 'push the branch\n\nBoundaries: push only after the check passes' })
    expect(retryVerdict(row({ outcome: 'interrupted' }), facts({ ...idle, phase: 'replied' })).ok).toBe(true)
    expect(retryVerdict(row({}), facts({ ...idle, phase: undefined })).ok).toBe(true)
  })

  it('a DELIVERED brief is never re-sent; neither is a pending, cancelled or expired one', () => {
    expect(retryVerdict(row({ outcome: 'delivered' }), facts(idle))).toEqual({ ok: false, error: 'that brief already landed' })
    for (const outcome of ['pending', 'cancelled', 'expired'] as const) expect(retryVerdict(row({ outcome }), facts(idle)).ok).toBe(false)
  })

  it('a dismissed row is not re-sent, whatever its outcome', () => {
    expect(retryVerdict(row({ dismissed: true }), facts(idle))).toEqual({ ok: false, error: 'that proposal was dismissed' })
  })

  it('the exact-action check: not a served seat, not mid-turn, not while the owner composes; a missing card or proposal refuses', () => {
    expect(retryVerdict(row({}), facts({ ...idle, served: true })).ok).toBe(false)
    expect(retryVerdict(row({}), facts({ ...idle, phase: 'thinking' })).ok).toBe(false)
    expect(retryVerdict(row({}), facts({ ...idle, phase: 'waiting' })).ok).toBe(false)
    expect(retryVerdict(row({}), facts({ ...idle, ownerComposing: true })).ok).toBe(false)
    expect(retryVerdict(row({}), facts(null))).toEqual({ ok: false, error: 'the card is gone' })
    expect(retryVerdict(row({ proposalText: null }), facts(idle))).toEqual({ ok: false, error: 'no such proposal' })
    expect(retryVerdict(undefined, facts(idle))).toEqual({ ok: false, error: 'no such proposal' })
  })
})
