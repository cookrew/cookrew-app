import { describe, expect, it } from 'vitest'
import type { Rect } from '../src/shared/strata'
import { mapRect } from '../src/strata/levels/geometry'
import { fanLayout, layoutAgents, layoutMachines, layoutTerminal, layoutWorkspaces, MAX_SEAT, miniatureTransform } from '../src/strata/levels/layout'
import { standInFigures } from '../src/strata/stand-in/figures'

const desktop: Rect = { x: 0, y: 52, w: 1440, h: 848 }
const phone: Rect = { x: 0, y: 52, w: 390, h: 792 }
const inside = (r: Rect, box: Rect) => r.x >= box.x - 0.01 && r.y >= box.y - 0.01 && r.x + r.w <= box.x + box.w + 0.01 && r.y + r.h <= box.y + box.h + 0.01
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

const kinds = ['desktop', 'cloud', 'cluster', 'sandbox', 'server', 'laptop', 'vm'] as const
const machines = kinds.map((kind, i) => ({ id: `m${i}`, kind, link: 'live' as const, reached: true }))
const studio = [
  { id: 'w0', name: 'Monorepo', agents: 48 },
  { id: 'w1', name: 'Paper Notes', agents: 9 },
  { id: 'w2', name: 'Home Lab', agents: 2 }
]

describe('machines layout (L0)', () => {
  it('is pure: same data and viewport give the same rects', () => {
    expect(layoutMachines(machines, desktop, standInFigures)).toEqual(layoutMachines(machines, desktop, standInFigures))
  })

  it('keeps every figure, portal and label inside the viewport without overlap', () => {
    for (const viewport of [desktop, phone]) {
      const cells = layoutMachines(machines, viewport, standInFigures)
      expect(cells.map((c) => c.id)).toEqual(machines.map((m) => m.id))
      for (const c of cells) {
        expect(inside(c.rect, viewport)).toBe(true)
        expect(inside(c.portal, c.rect)).toBe(true)
        expect(inside(c.pins, viewport)).toBe(true)
      }
      cells.forEach((a, i) => cells.slice(i + 1).forEach((b) => expect(overlaps(a.rect, b.rect)).toBe(false)))
    }
  })

  it('draws a lone machine large but capped', () => {
    const [one] = layoutMachines(machines.slice(0, 1), desktop, standInFigures)
    expect(one.rect.w).toBeGreaterThan(400)
    expect(one.rect.w).toBeLessThanOrEqual(240 * 2.2 + 0.01)
  })

  it('handles an empty account', () => {
    expect(layoutMachines([], desktop, standInFigures)).toEqual([])
  })
})

describe('workspaces layout (L1) and agents layout (L2)', () => {
  it('is pure and keeps workspace order', () => {
    const a = layoutWorkspaces(studio, desktop, standInFigures)
    expect(a).toEqual(layoutWorkspaces(studio, desktop, standInFigures))
    expect(a.map((c) => c.id)).toEqual(['w0', 'w1', 'w2'])
  })

  it('uses one seat size per machine, so a container shows its crew', () => {
    const cells = layoutWorkspaces(studio, desktop, standInFigures)
    const seatW = cells.map((c) => c.seats[0].w)
    expect(new Set(seatW.map((w) => w.toFixed(3))).size).toBe(1)
    expect(cells[0].rect.w * cells[0].rect.h).toBeGreaterThan(cells[2].rect.w * cells[2].rect.h)
  })

  it('seats every agent in creation order, inside its container, never overlapping', () => {
    for (const viewport of [desktop, phone]) {
      const [box] = layoutWorkspaces([studio[0]], viewport, standInFigures)
      expect(box.seats).toHaveLength(48)
      box.seats.forEach((s) => expect(inside(s, box.rect)).toBe(true))
      for (let i = 1; i < box.seats.length; i++) {
        const [p, q] = [box.seats[i - 1], box.seats[i]]
        expect(q.y > p.y + 0.01 || (Math.abs(q.y - p.y) < 0.01 && q.x > p.x)).toBe(true)
      }
      box.seats.forEach((a, i) => box.seats.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)))
    }
  })

  it('fits every container inside the viewport, on the phone too', () => {
    for (const viewport of [desktop, phone]) {
      for (const c of layoutWorkspaces(studio, viewport, standInFigures)) {
        expect(inside(c.rect, viewport)).toBe(true)
        expect(inside(c.pins, viewport)).toBe(true)
      }
    }
  })

  it('caps the seat size so small crews stay small', () => {
    const l2 = layoutAgents({ id: 'w2', name: 'Home Lab', agents: 2 }, desktop, standInFigures)
    expect(l2?.seats[0].w).toBeLessThanOrEqual(MAX_SEAT + 0.01)
  })

  it('gives the 48-agent workspace touch-sized seats on a phone at L2', () => {
    const l2 = layoutAgents(studio[0], phone, standInFigures)
    expect(l2?.seats[0].w).toBeGreaterThanOrEqual(36)
  })
})

describe('miniatures land exactly on their level', () => {
  it('maps the L1 layout into a machine portal with one uniform transform', () => {
    const [cell] = layoutMachines(machines.slice(0, 1), desktop, standInFigures)
    const level = layoutWorkspaces(studio, desktop, standInFigures)
    const t = miniatureTransform(desktop, cell.portal)
    const mini = level.map((c) => mapRect(c.rect, t))
    mini.forEach((r) => expect(inside(r, cell.portal)).toBe(true))
    // Inverting the transform brings the miniature back onto the level's own rects.
    mini.forEach((r, i) => {
      const back = { x: (r.x - t.dx) / t.s, y: (r.y - t.dy) / t.s, w: r.w / t.s, h: r.h / t.s }
      expect(back.x).toBeCloseTo(level[i].rect.x, 6)
      expect(back.w).toBeCloseTo(level[i].rect.w, 6)
    })
  })
})

describe('terminal fallback layout (L3), on rail-layout rules', () => {
  it('the view takes the whole stage below the top bar, at every width', () => {
    for (const w of [1440, 1280, 1024]) {
      const t = layoutTerminal({ x: 0, y: 0, w, h: 900 }, 52)
      expect(t.terminal).toEqual({ x: 0, y: 52, w, h: 848 })
    }
  })

  it('desktop: edge tabs on both sides open drawers over the view, never beside it', () => {
    const t = layoutTerminal({ x: 0, y: 0, w: 1440, h: 900 }, 52)
    expect(t.sheet).toBe(false)
    expect(inside(t.edgeTabs!.notes, t.terminal)).toBe(true)
    expect(inside(t.edgeTabs!.browsers, t.terminal)).toBe(true)
    expect(inside(t.drawer!.notes, t.terminal)).toBe(true)
    expect(t.drawer!.browsers.x + t.drawer!.browsers.w).toBeLessThanOrEqual(t.edgeTabs!.browsers.x + 0.01)
  })

  it('a phone keeps the view full bleed and uses one tab and a bottom sheet', () => {
    expect(layoutTerminal({ x: 0, y: 0, w: 390, h: 844 }, 52)).toMatchObject({ terminal: { x: 0, y: 52, w: 390, h: 792 }, sheet: true, edgeTabs: null, drawer: null })
  })
})

describe('attachment fan', () => {
  it('shows everything up to the cap, in connection order', () => {
    const { cards, more } = fanLayout(4, 6, 50)
    expect(cards.map((c) => c.item)).toEqual([0, 1, 2, 3])
    expect(more).toBe(0)
  })

  it('caps at 6 with a +N card for 40 attachments', () => {
    const { cards, more } = fanLayout(40, 6, 50)
    expect(cards).toHaveLength(6)
    expect(cards.map((c) => c.item)).toEqual([0, 1, 2, 3, 4, 'more'])
    expect(more).toBe(35)
  })

  it('fans above the avatar, symmetric around it', () => {
    const { cards } = fanLayout(5, 6, 50)
    cards.forEach((c) => expect(c.y).toBeLessThan(0))
    expect(cards[0].x).toBeCloseTo(-cards[4].x, 6)
  })

  it('draws nothing for no attachments', () => {
    expect(fanLayout(0, 6, 50)).toEqual({ cards: [], more: 0 })
  })
})
