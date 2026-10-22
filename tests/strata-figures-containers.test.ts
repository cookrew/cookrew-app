import { describe, expect, it } from 'vitest'
import { WORKSPACE_TRAITS } from '../src/shared/strata'
import { BALL, CAPACITY, containerArt, MODULE_SEATS, paletteOf, THEMES, themesOf } from '../src/strata/figures/container'
import { modulesFor, rowCounts, seatGrid, tierFor } from '../src/strata/figures/container/layout'
import { plaqueText } from '../src/strata/figures/container/themes'

/** A one-module table, and the longest (four modules, 48 seats). */
export const MODULE_BUDGET = 9 * 1024
export const CONTAINER_BUDGET = 22 * 1024
const slotsOf = (anchors: Readonly<Record<string, unknown>>) => Object.keys(anchors).filter((k) => k.startsWith('slot:'))

describe('a workspace theme from its traits and name', () => {
  it('is one theme per trait word', () => {
    expect([...THEMES]).toEqual([...WORKSPACE_TRAITS])
  })

  it('takes the name by keyword when there are no traits, first matching word first', () => {
    expect(themesOf('Monorepo')).toEqual(['code'])
    expect(themesOf('Paper Notes')).toEqual(['docs'])
    expect(themesOf('Home Lab')).toEqual(['home', 'ai'])
    expect(themesOf('CI Night Shift')).toEqual(['ops'])
    expect(themesOf('Data Pipes')).toEqual(['data'])
    expect(themesOf('Backups')).toEqual(['security'])
    expect(themesOf('Media')).toEqual(['media'])
    expect(themesOf('Throwaway')).toEqual(['play'])
    expect(themesOf('playgroundStuff')).toEqual(['play'])
    expect(themesOf('Brand Design')).toEqual(['design'])
    expect(themesOf('LLM evals')).toEqual(['ai'])
    expect(themesOf('Core Team')).toEqual(['code', 'team'])
  })

  it('puts the traits first and the name second, two themes at most', () => {
    expect(themesOf('Monorepo', ['ai'])).toEqual(['ai', 'code'])
    expect(themesOf('Monorepo', ['code', 'ai', 'docs'])).toEqual(['code', 'ai'])
    expect(themesOf('Zyxwv', ['bogus', 'ai'] as never)).toEqual(['ai'])
  })

  it('falls back to a stable hash, and short keys only match whole words', () => {
    expect(themesOf('Zyxwv')).toEqual(themesOf('Zyxwv'))
    expect(THEMES).toContain(themesOf('Zyxwv')[0])
    expect(themesOf('cinema')).not.toContain('ops')
  })

  it('gives every name a stable palette', () => {
    expect(paletteOf('Thesis')).toEqual(paletteOf('Thesis'))
    expect(paletteOf('Thesis').l).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('modules: one standard table, longer for a bigger crew', () => {
  it('seats twelve per module, one to four modules', () => {
    expect(MODULE_SEATS).toBe(12)
    expect([0, 1, 12, 13, 24, 25, 36, 37, 48, 500].map(modulesFor)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 4])
    expect(tierFor(13)).toEqual({ cols: 8, rows: 3 })
    expect(tierFor(48)).toEqual({ cols: 16, rows: 3 })
  })

  it('fills rows evenly toward the front, every seat on a drawn place', () => {
    expect(rowCounts(5, tierFor(5))).toEqual([3, 2])
    const grid = seatGrid(5, tierFor(5))
    expect(grid.map((s) => s.row)).toEqual([1, 1, 1, 2, 2])
    expect(seatGrid(1, tierFor(1)).map((s) => s.row)).toEqual([1])
    for (const n of [1, 3, 5, 7, 13, 29, 48]) for (const s of seatGrid(n, tierFor(n))) expect(Number.isInteger(s.col), `${n}`).toBe(true)
  })

  it('is the same table for 1 and 12 agents, and grows by one fixed step per module', () => {
    const w = [1, 12, 13, 25, 37].map((slots) => containerArt({ name: 'Paper Notes', slots }).viewBox)
    expect(w[0]).toEqual(w[1])
    const steps = [w[2].w - w[1].w, w[3].w - w[2].w, w[4].w - w[3].w]
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(1)
    expect(steps[0]).toBeGreaterThan(40)
  })

  it('has one form on every screen: there is no phone variant to ask for', () => {
    const plain = containerArt({ name: 'Monorepo', slots: 20 })
    expect(containerArt({ name: 'Monorepo', slots: 20, columns: 5 } as never).svg).toBe(plain.svg)
  })

  it('lets traits and names change the theme, never the geometry', () => {
    const base = containerArt({ name: 'Monorepo', slots: 5 })
    const ai = containerArt({ name: 'Monorepo', slots: 5, traits: ['ai'] })
    expect(base.theme).toBe('code')
    expect(ai.theme).toBe('ai')
    expect(ai.svg).not.toBe(base.svg)
    expect(ai.anchors).toEqual(base.anchors)
    expect(ai.viewBox).toEqual(base.viewBox)
    const other = containerArt({ name: 'Garden Diary', slots: 5 })
    expect(Object.keys(other.anchors)).toEqual(Object.keys(base.anchors))
    expect(other.anchors['slot:0'].w).toBeCloseTo(base.anchors['slot:0'].w, 1)
  })
})

describe('container figures', () => {
  it('draws every theme at every size within budget, with no ids or refs', () => {
    for (const theme of THEMES) {
      for (const slots of [0, 1, 2, 5, 9, 14, 24, 33, 48, 60]) {
        const art = containerArt({ name: `Sample ${theme}`, slots, theme })
        expect(art.svg.length, `${theme}/${slots}`).toBeLessThanOrEqual(art.modules === 1 ? MODULE_BUDGET : CONTAINER_BUDGET)
        expect(art.svg).not.toMatch(/\bid=|url\(|href|<filter|<script|NaN|undefined|Infinity/)
        expect(art.theme).toBe(theme)
        expect(art.modules).toBe(modulesFor(Math.min(Math.max(0, slots), CAPACITY)))
        expect(slotsOf(art.anchors)).toHaveLength(Math.min(slots, CAPACITY))
      }
    }
  })

  it('blends a second theme in when there is one', () => {
    const one = containerArt({ name: 'Zyxwv', slots: 30, traits: ['data'] })
    const two = containerArt({ name: 'Zyxwv', slots: 30, traits: ['data', 'team'] })
    expect(two.svg).not.toBe(one.svg)
    expect(two.theme).toBe('data')
  })

  it('is deterministic and memoized by input', () => {
    const a = containerArt({ name: 'Monorepo', slots: 48 })
    expect(containerArt({ name: 'Monorepo', slots: 48 })).toBe(a)
    expect(containerArt({ name: 'Monorepo', slots: 48, traits: ['ai'] })).toBe(containerArt({ name: 'Monorepo', slots: 48, traits: ['ai'] }))
  })

  it('makes every seat the same size, in every container', () => {
    const sizes = THEMES.flatMap((theme) => [3, 48].map((slots) => containerArt({ name: 'x', slots, theme }).anchors['slot:0'].w))
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(0.2)
    expect(BALL.d).toBeGreaterThan(0)
  })

  it('keeps slots, tray and label inside the viewBox', () => {
    for (const theme of THEMES) {
      for (const slots of [1, 48]) {
        const { anchors, viewBox } = containerArt({ name: 'Paper Notes', slots, theme })
        for (const [key, r] of Object.entries(anchors)) {
          const ball = key.startsWith('slot:') ? { x: r.x + r.w * 0.22, y: r.y + r.h * 0.3, w: r.w * BALL.d, h: r.h * BALL.d } : r
          expect(ball.x, `${theme} ${key}`).toBeGreaterThanOrEqual(-0.5)
          expect(ball.y, `${theme} ${key}`).toBeGreaterThanOrEqual(-0.5)
          expect(ball.x + ball.w, `${theme} ${key}`).toBeLessThanOrEqual(viewBox.w + 0.5)
          expect(ball.y + ball.h, `${theme} ${key}`).toBeLessThanOrEqual(viewBox.h + 0.5)
        }
      }
    }
  })

  it('seats in creation order: a row reads left to right, the next row nearer', () => {
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
