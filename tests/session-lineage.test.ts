import { describe, expect, it } from 'vitest'
import { withSessionLineage } from '../src/main/session-lineage'

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

  // WAS: "caps the lineage at 20, dropping the oldest". That cap is the
  // 2026-09-06 checkpoint-loss defect — Conductor sat at exactly 20 and the
  // next rebind would have sliced its oldest transcript out of every path
  // that can reach a checkpoint. The lineage is APPEND-ONLY now.
  it('never drops an id, however long the chain gets', () => {
    const lineage = Array.from({ length: 40 }, (_, i) => `s${i}`)
    const patch = withSessionLineage({ claudeSessionId: 'cur', sessionLineage: lineage }, 'next')
    expect(patch.sessionLineage).toHaveLength(41)
    expect(patch.sessionLineage?.[0]).toBe('s0') // the id the cap used to eat
    expect(patch.sessionLineage?.at(-1)).toBe('cur')
  })

  it('an id already on the chain is not appended twice (idempotent)', () => {
    const patch = withSessionLineage({ claudeSessionId: 'b', sessionLineage: ['a', 'b'] }, 'c')
    expect(patch.sessionLineage).toEqual(['a', 'b'])
  })
})
