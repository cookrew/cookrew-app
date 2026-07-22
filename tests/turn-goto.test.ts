import { describe, expect, it } from 'vitest'
import { gotoCursor } from '../src/renderer/src/checkpoint-sync'
import type { TurnRecord } from '../src/shared/turn'

const rec = (index: number): TurnRecord => ({
  index,
  prompt: `p${index}`,
  reply: `r${index}`,
  startedAt: 0,
  endedAt: 1
})

describe('gotoCursor (checkpoint jump target)', () => {
  const records = [rec(1), rec(2), rec(3)]

  it('maps a checkpoint index to its cursor', () => {
    expect(gotoCursor(records, 1)).toBe(0)
    expect(gotoCursor(records, 2)).toBe(1)
  })

  it('makes the NEWEST checkpoint viewable (not a live no-op)', () => {
    // Regression: previously selecting the newest from live stayed live (null).
    expect(gotoCursor(records, 3)).toBe(2)
  })

  it('returns null for an unknown index', () => {
    expect(gotoCursor(records, 99)).toBeNull()
  })
})
