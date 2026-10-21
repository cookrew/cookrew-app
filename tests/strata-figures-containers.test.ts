import { describe, expect, it } from 'vitest'
import { ARCHETYPES, archetypeOf, BALL, CAPACITY, containerArt, MAX_ROWS, paletteOf } from '../src/strata/figures/container'
import { rowCounts, seatGrid, tierFor } from '../src/strata/figures/container/layout'
import { plaqueText } from '../src/strata/figures/container/name'

export const CONTAINER_BUDGET = 10 * 1024
const slotsOf = (anchors: Readonly<Record<string, unknown>>) => Object.keys(anchors).filter((k) => k.startsWith('slot:'))

describe('container archetypes from the name', () => {
  it('picks by keyword, first matching word wins', () => {
    expect(archetypeOf('Monorepo')).toBe('workbench')
    expect(archetypeOf('Paper Notes')).toBe('bookshelf')
    expect(archetypeOf('Home Lab')).toBe('house')
    expect(archetypeOf('CI Night Shift')).toBe('lockers')
    expect(archetypeOf('Data Pipes')).toBe('pipes')
    expect(archetypeOf('Backups')).toBe('vault')
    expect(archetypeOf('Media')).toBe('crate')
    expect(archetypeOf('Throwaway')).toBe('sandbox')
    expect(archetypeOf('playgroundStuff')).toBe('sandbox')
    expect(archetypeOf('Brand Design')).toBe('drawers')
    expect(archetypeOf('LLM evals')).toBe('lab')
    expect(archetypeOf('Core Team')).toBe('workbench')
    expect(archetypeOf('The Team')).toBe('bleachers')
  })

  it('falls back to a stable hash, and short keys only match whole words', () => {
    expect(archetypeOf('Zyxwv')).toBe(archetypeOf('Zyxwv'))
    expect(ARCHETYPES).toContain(archetypeOf('Zyxwv'))
    expect(archetypeOf('cinema')).not.toBe('lockers')
  })

  it('gives every name a stable palette', () => {
    expect(paletteOf('Thesis')).toEqual(paletteOf('Thesis'))
    expect(paletteOf('Thesis').l).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('seating', () => {
  it('grows the tier with the seat count', () => {
    expect(tierFor(1)).toEqual({ cols: 4, rows: 1 })
    expect(tierFor(48)).toEqual({ cols: 12, rows: 4 })
    expect(tierFor(500)).toEqual({ cols: 12, rows: 4 })
  })

  it('fills rows evenly, earlier rows first, centred', () => {
    expect(rowCounts(5, tierFor(5))).toEqual([3, 2])
    expect(rowCounts(13, tierFor(13))).toEqual([5, 4, 4])
    const grid = seatGrid(5, tierFor(5))
    expect(grid.map((s) => s.row)).toEqual([0, 0, 0, 1, 1])
    expect(grid[3].col).toBe(1)
  })
})

/** Seats per row as the anchors show them: a row runs along model y, where y + x·tan 30° is constant on screen. */
const rowsOf = (anchors: Readonly<Record<string, { x: number; y: number; w: number; h: number }>>) => {
  const keys = slotsOf(anchors)
  const rows = new Map<number, number>()
  for (const key of keys) {
    const r = anchors[key]
    const k = Math.round((r.y + r.h / 2 + (r.x + r.w / 2) * Math.tan(Math.PI / 6)) / 4)
    rows.set(k, (rows.get(k) ?? 0) + 1)
  }
  return [...rows.values()]
}

describe('the columns hint', () => {
  it('changes nothing when absent', () => {
    const plain = containerArt({ name: 'Paper Notes', slots: 48 })
    expect(containerArt({ name: 'Paper Notes', slots: 48, columns: undefined }).svg).toBe(plain.svg)
    expect(Math.max(...rowsOf(plain.anchors))).toBe(12)
    expect(rowsOf(containerArt({ name: 'Paper Notes', slots: 5 }).anchors)).toEqual([3, 2])
  })

  it('seats 48 agents 4, 5 or 6 to a row when the archetype can, within budget', () => {
    for (const columns of [4, 5, 6]) {
      for (const name of ['Paper Notes', 'CI Night Shift', 'Home Lab', 'LLM Evals', 'Brand Design', 'Backups']) {
        const rows = rowsOf(containerArt({ name, slots: 48, columns }).anchors)
        expect(Math.max(...rows), `${name} ${columns}`).toBe(columns)
        expect(rows.reduce((a, b) => a + b, 0)).toBe(48)
      }
      for (const archetype of ARCHETYPES) {
        const art = containerArt({ name: 'x', slots: 48, archetype, columns })
        expect(art.svg.length, `${archetype} ${columns}`).toBeLessThanOrEqual(CONTAINER_BUDGET)
      }
    }
  })

  it('widens the row when the archetype cannot stack that many rows', () => {
    const bleachers = containerArt({ name: 'Crew', slots: 48, columns: 4 })
    expect(bleachers.archetype).toBe('bleachers')
    expect(rowsOf(bleachers.anchors)).toHaveLength(MAX_ROWS.bleachers)
    expect(Math.max(...rowsOf(bleachers.anchors))).toBe(8)
    const bench = containerArt({ name: 'Monorepo', slots: 48, columns: 4 })
    expect(Math.max(...rowsOf(bench.anchors))).toBe(6)
  })

  it('gives a shelf at five columns seats of 44 px or more on a 360 px stage', () => {
    for (const name of ['Paper Notes', 'CI Night Shift', 'Home Lab', 'LLM Evals', 'Brand Design']) {
      const art = containerArt({ name, slots: 48, columns: 5 })
      expect((art.anchors['slot:0'].w / art.viewBox.w) * 360, name).toBeGreaterThanOrEqual(44)
    }
  })

  it('keeps the row width for a workspace smaller than the hint', () => {
    const three = containerArt({ name: 'Paper Notes', slots: 3, columns: 5 })
    const five = containerArt({ name: 'Paper Notes', slots: 5, columns: 5 })
    expect(three.viewBox.w).toBe(five.viewBox.w)
  })

  it('ignores hints that are not a positive number, and is memoized on the hint', () => {
    const plain = containerArt({ name: 'Monorepo', slots: 20 })
    for (const columns of [0, -2, Number.NaN]) expect(containerArt({ name: 'Monorepo', slots: 20, columns }).svg).toBe(plain.svg)
    expect(containerArt({ name: 'Monorepo', slots: 20, columns: 5 })).toBe(containerArt({ name: 'Monorepo', slots: 20, columns: 5 }))
  })
})

describe('container figures', () => {
  it('draws every archetype at every size within budget, with no ids or refs', () => {
    for (const archetype of ARCHETYPES) {
      for (const slots of [0, 1, 2, 5, 9, 14, 24, 33, 48, 60]) {
        const art = containerArt({ name: `Sample ${archetype}`, slots, archetype })
        expect(art.svg.length, `${archetype}/${slots}`).toBeLessThanOrEqual(CONTAINER_BUDGET)
        expect(art.svg).not.toMatch(/\bid=|url\(|href|<filter|<script|NaN|undefined/)
        expect(art.archetype).toBe(archetype)
        expect(slotsOf(art.anchors)).toHaveLength(Math.min(slots, CAPACITY))
      }
    }
  })

  it('is deterministic and memoized by input', () => {
    const a = containerArt({ name: 'Monorepo', slots: 48 })
    expect(containerArt({ name: 'Monorepo', slots: 48 })).toBe(a)
    expect(a.archetype).toBe('workbench')
  })

  it('makes every seat the same size, in every container', () => {
    const sizes = ARCHETYPES.flatMap((archetype) =>
      [3, 48].map((slots) => containerArt({ name: 'x', slots, archetype }).anchors['slot:0'].w)
    )
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(0.2)
    expect(BALL.d).toBeGreaterThan(0)
  })

  it('keeps slots, tray and label inside the viewBox', () => {
    for (const archetype of ARCHETYPES) {
      const { anchors, viewBox } = containerArt({ name: 'Paper Notes', slots: 48, archetype })
      for (const [key, r] of Object.entries(anchors)) {
        const ball = key.startsWith('slot:') ? { x: r.x + r.w * 0.22, y: r.y + r.h * 0.3, w: r.w * BALL.d, h: r.h * BALL.d } : r
        expect(ball.x, `${archetype} ${key}`).toBeGreaterThanOrEqual(-0.5)
        expect(ball.y, `${archetype} ${key}`).toBeGreaterThanOrEqual(-0.5)
        expect(ball.x + ball.w, `${archetype} ${key}`).toBeLessThanOrEqual(viewBox.w + 0.5)
        expect(ball.y + ball.h, `${archetype} ${key}`).toBeLessThanOrEqual(viewBox.h + 0.5)
      }
    }
  })

  it('seats in creation order: the first row reads left to right', () => {
    const { anchors } = containerArt({ name: 'Paper Notes', slots: 8 })
    expect(anchors['slot:1'].x).toBeGreaterThan(anchors['slot:0'].x)
    expect(anchors['slot:4'].y).toBeGreaterThan(anchors['slot:0'].y)
  })

  it('puts "+K" on the last seat past capacity', () => {
    const art = containerArt({ name: 'Monorepo', slots: 60 })
    expect(art.capacity).toBe(CAPACITY)
    expect(art.svg).toContain('>+13</text>')
    expect(art.anchors.more).toEqual(art.anchors[`slot:${CAPACITY - 1}`])
    expect(containerArt({ name: 'Monorepo', slots: 48 }).anchors.more).toBeUndefined()
  })

  it('treats odd slot counts as whole agents', () => {
    for (const slots of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const art = containerArt({ name: 'Odd', slots })
      expect(slotsOf(art.anchors), String(slots)).toHaveLength(0)
      expect(art.svg).not.toMatch(/NaN|Infinity/)
    }
    const almost = containerArt({ name: 'Odd', slots: 48.5 })
    expect(slotsOf(almost.anchors)).toHaveLength(48)
    expect(almost.anchors.more).toBeUndefined()
  })

  it('never splits an emoji when it cuts a long name', () => {
    expect(plaqueText('😀😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('escapes the name on its plaque', () => {
    const { svg } = containerArt({ name: '<b>&"x', slots: 2 })
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('&#60;b&#62;')
  })
})
