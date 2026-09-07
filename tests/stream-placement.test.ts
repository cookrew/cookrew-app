// WHERE A FILE NOBODY DECLARED BELONGS (one-stream T2.5 follow-up).
//
// stream-chain.ts puts the session ids no transcript declares any more IN
// FRONT of the rotation walk, saying why: "They cannot be placed by evidence."
// The blocks carry their own clock, so they can. Measured on the owner's
// busiest card, two undeclared ids sat at the head of a nine-file chain — one
// from 2026-09-03 belonging seventh, one from 2026-09-06 belonging LAST — so
// the rail drew this week's exchanges ahead of exchanges from July.

import { describe, expect, it } from 'vitest'
import { placeUndeclared } from '../src/main/stream-placement'

const day = (n: number): number => Date.parse(`2026-09-${String(n).padStart(2, '0')}T00:00:00Z`)

const file = (name: string, declared: boolean, startedAt: number | null) => ({
  name,
  declared,
  startedAt
})

describe('placeUndeclared', () => {
  it('puts an undeclared file back in time among the declared walk', () => {
    const placed = placeUndeclared([
      file('undeclared-09-03', false, day(3)),
      file('undeclared-09-06', false, day(6)),
      file('walk-09-01', true, day(1)),
      file('walk-09-02', true, day(2)),
      file('walk-09-04', true, day(4)),
      file('walk-09-05', true, day(5))
    ])
    expect(placed.map((one) => one.name)).toEqual([
      'walk-09-01',
      'walk-09-02',
      'undeclared-09-03',
      'walk-09-04',
      'walk-09-05',
      'undeclared-09-06'
    ])
  })

  it('leaves the DECLARED walk in its own order — a head pointer beats a clock', () => {
    // A walk whose clocks look out of order is still the walk: each file's
    // head names its predecessor, and that is a fact, not an inference.
    const placed = placeUndeclared([
      file('walk-b', true, day(5)),
      file('walk-a', true, day(1)),
      file('walk-c', true, day(3))
    ])
    expect(placed.map((one) => one.name)).toEqual(['walk-b', 'walk-a', 'walk-c'])
  })

  it('an undeclared file with no blocks has no clock, and stays where it was', () => {
    const placed = placeUndeclared([
      file('undeclared-empty', false, null),
      file('walk-09-01', true, day(1))
    ])
    expect(placed.map((one) => one.name)).toEqual(['undeclared-empty', 'walk-09-01'])
  })

  it('an undeclared file older than everything still comes first', () => {
    const placed = placeUndeclared([
      file('undeclared-09-01', false, day(1)),
      file('walk-09-04', true, day(4))
    ])
    expect(placed.map((one) => one.name)).toEqual(['undeclared-09-01', 'walk-09-04'])
  })

  it('a chain with nothing undeclared is returned untouched', () => {
    const chain = [file('a', true, day(1)), file('b', true, day(2))]
    expect(placeUndeclared(chain)).toEqual(chain)
  })

  it('does not mutate the chain it was given', () => {
    const chain = [file('u', false, day(9)), file('a', true, day(1))]
    const before = JSON.parse(JSON.stringify(chain))
    placeUndeclared(chain)
    expect(chain).toEqual(before)
  })
})
