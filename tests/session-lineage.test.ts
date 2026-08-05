import { describe, expect, it } from 'vitest'
import { SESSION_LINEAGE_CAP, withSessionLineage } from '../src/main/session-lineage'

describe('withSessionLineage — the rebind choke point', () => {
  it('a transition appends the OLD id (oldest first), immutably', () => {
    const node = { claudeSessionId: 'b', sessionLineage: ['a'] }
    const patch = withSessionLineage(node, 'c')
    expect(patch).toEqual({ claudeSessionId: 'c', sessionLineage: ['a', 'b'] })
    expect(node.sessionLineage).toEqual(['a']) // input untouched
  })

  it('a same-id rebind (reattach) records NOTHING', () => {
    const patch = withSessionLineage({ claudeSessionId: 'a', sessionLineage: ['x'] }, 'a')
    expect(patch).toEqual({ claudeSessionId: 'a', sessionLineage: ['x'] })
  })

  it('first binding (no prior id) starts no lineage', () => {
    expect(withSessionLineage({ claudeSessionId: null }, 'a').sessionLineage).toEqual([])
    expect(withSessionLineage({}, 'a').sessionLineage).toEqual([])
  })

  it(`caps the lineage at ${SESSION_LINEAGE_CAP}, dropping the oldest`, () => {
    const lineage = Array.from({ length: SESSION_LINEAGE_CAP }, (_, i) => `s${i}`)
    const patch = withSessionLineage({ claudeSessionId: 'cur', sessionLineage: lineage }, 'next')
    expect(patch.sessionLineage).toHaveLength(SESSION_LINEAGE_CAP)
    expect(patch.sessionLineage?.[0]).toBe('s1') // s0 dropped
    expect(patch.sessionLineage?.[SESSION_LINEAGE_CAP - 1]).toBe('cur')
  })
})
