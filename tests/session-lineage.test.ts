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

  // THE MEASURED SHAPE, 2026-09-06. Conductor's persisted lineage was 20
  // entries long and held FOUR distinct ids: 5a4cdb91, f16cf111, then
  // 295d5f1c/a78aa3e5 alternating eight times. The card was flapping between
  // its real session and one a background job held, and every flap ate a slot
  // of a 20-slot cap — two more and the 2026-09-05 sessions would have been
  // evicted. Deduping is what makes a flap cost nothing.
  it('a card flapping between two sessions never eats its own history', () => {
    let node: { claudeSessionId?: string | null; sessionLineage?: string[] } = {
      claudeSessionId: '295d5f1c',
      sessionLineage: ['5a4cdb91', 'f16cf111']
    }
    for (let flap = 0; flap < 8; flap++) {
      node = withSessionLineage(node, 'a78aa3e5')
      node = withSessionLineage(node, '295d5f1c')
    }
    expect(node.sessionLineage).toEqual(['5a4cdb91', 'f16cf111', '295d5f1c', 'a78aa3e5'])
  })
})
