// Swapping places at the crew by hand (zoom/crew-slots.ts): the fold and its
// faces are worked out from where the agents now stand.
import { describe, expect, it } from 'vitest'
import { swapped, withSlots } from '../src/renderer/src/zoom/crew-slots'

const at = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 200, y: 0 } }
const places = (out: Record<string, { x: number }>): number[] => Object.values(out).map((p) => p.x).sort((m, n) => m - n)

describe('swapping places', () => {
  it('puts each of two agents where the other stood, and back again', () => {
    const once = swapped({}, 'a', 'c')
    expect(withSlots(at, once)).toEqual({ a: at.c, b: at.b, c: at.a })
    expect(swapped(once, 'a', 'c')).toEqual({})
  })

  it('swaps from wherever they stand now', () => {
    const out = withSlots(at, swapped(swapped({}, 'a', 'b'), 'a', 'c'))
    // a stood at b's place and c at its own: now a is at c's, c at b's, b at a's.
    expect(out).toEqual({ a: at.c, b: at.a, c: at.b })
  })

  it('keeps one agent to a place when a partner has gone or a swap is stale', () => {
    const gone = withSlots({ a: at.a, b: at.b }, swapped(swapped({}, 'a', 'b'), 'a', 'c'))
    expect(places(gone)).toEqual([0, 100])
    expect(places(withSlots(at, { a: 'b', b: 'b', c: 'nobody' }))).toEqual([0, 100, 200])
  })

  it('leaves a crew with no swaps as its ties lay it out', () => {
    expect(withSlots(at, {})).toEqual(at)
  })
})
