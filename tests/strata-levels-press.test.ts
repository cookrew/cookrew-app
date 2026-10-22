// The pick rule on a level whose seats are under the touch target: a first tap
// picks, only a tap on the picked seat dives, and a key always dives.
import { describe, expect, it } from 'vitest'
import { pressOf } from '../src/strata/levels/press'

const tap = { held: false, keyboard: false }

describe('pressOf', () => {
  it('dives at once where seats are big enough to aim at', () => {
    expect(pressOf({ ...tap, pick: false, picked: false })).toBe('dive')
  })

  it('picks first on a small table, and dives on the picked seat', () => {
    expect(pressOf({ ...tap, pick: true, picked: false })).toBe('pick')
    expect(pressOf({ ...tap, pick: true, picked: true })).toBe('dive')
  })

  it('picks first on the seat the level entered on: highlighted is not picked', () => {
    // The level seeds its highlight on entry; the rule never sees it, only `picked`.
    expect(pressOf({ ...tap, pick: true, picked: false })).toBe('pick')
  })

  it('does nothing after a hold, which has already shown the card (and picked the seat)', () => {
    expect(pressOf({ held: true, keyboard: false, pick: true, picked: false })).toBe('none')
    expect(pressOf({ held: true, keyboard: false, pick: false, picked: false })).toBe('none')
  })

  it('always dives on Enter or Space, which aims at the focused seat already', () => {
    expect(pressOf({ held: false, keyboard: true, pick: true, picked: false })).toBe('dive')
  })
})
