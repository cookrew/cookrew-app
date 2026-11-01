// AGENTS PER ROW, THE OWNER'S PICK (owner, 2026-11-01: "a row of 3, 4 or 5
// columns to choose from"). crewOf lays the crew in the picked count; the
// pick is remembered per form factor, and anything else stored falls back to
// the form factor's own default (2 on a phone, 5 on a desk).
import { describe, expect, it } from 'vitest'
import { crewOf, CREW_COLS, defaultCrewCols } from '../src/renderer/src/zoom/zoom-layout'
import { crewColsOf, crewColsKey } from '../src/renderer/src/zoom/crew-cols'
import { layoutOf, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'

const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, orch: false }))
const rowsOf = (at: Record<string, { y: number }>): number[] => {
  const ys = [...new Set(Object.values(at).map((p) => p.y))].sort((a, b) => a - b)
  return ys.map((y) => Object.values(at).filter((p) => p.y === y).length)
}

describe('agents per row', () => {
  it('lays the crew in the picked count, on a desk and on a phone', () => {
    for (const narrow of [false, true]) {
      expect(rowsOf(crewOf(agents(13), narrow, 3).at)).toEqual([3, 3, 3, 3, 1])
      expect(rowsOf(crewOf(agents(13), narrow, 4).at)).toEqual([4, 4, 4, 1])
      expect(rowsOf(crewOf(agents(13), narrow, 5).at)).toEqual([5, 5, 3])
    }
  })

  it('keeps the old defaults when nothing is picked', () => {
    expect(rowsOf(crewOf(agents(7), false).at)).toEqual([5, 2])
    expect(rowsOf(crewOf(agents(7), true).at)).toEqual([2, 2, 2, 1])
    expect(defaultCrewCols(false)).toBe(5)
    expect(defaultCrewCols(true)).toBe(2)
  })

  it('a wider row frames a wider crew', () => {
    expect(crewOf(agents(13), false, 3).box.w).toBeLessThan(crewOf(agents(13), false, 5).box.w)
  })

  it('offers 3, 4 and 5, and 2 on a phone so its own default can be picked back', () => {
    expect(CREW_COLS.wide).toEqual([3, 4, 5])
    expect(CREW_COLS.narrow).toEqual([2, 3, 4, 5])
  })

  it('reads a stored pick only when it is one of the form factor’s choices', () => {
    expect(crewColsOf('4', false)).toBe(4)
    expect(crewColsOf('2', true)).toBe(2)
    expect(crewColsOf('2', false)).toBeNull()
    expect(crewColsOf('9', true)).toBeNull()
    expect(crewColsOf(null, true)).toBeNull()
    expect(crewColsOf('x', false)).toBeNull()
    expect(crewColsKey(true)).not.toBe(crewColsKey(false))
  })

  it('the frame model carries the pick into the layout', () => {
    const model = (crewCols?: number): FrameModel => ({
      agents: agents(12).map((a) => ({ ...a, name: a.id, preset: 'Shell', waiting: false })),
      items: [],
      links: [],
      ties: [],
      workspaces: ['w'],
      otherMachines: 0,
      active: 'w',
      newest: null,
      crewCols
    })
    expect(rowsOf(layoutOf(model(3), false).crew.at)).toEqual([3, 3, 3, 3])
    expect(rowsOf(layoutOf(model(), false).crew.at)).toEqual([5, 5, 2])
  })
})
