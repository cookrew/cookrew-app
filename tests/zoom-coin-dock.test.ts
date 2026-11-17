// THE COINS DOCKED ON A THUMBNAIL (renderer zoom/coin-dock.ts): at the
// artifacts stop each agent's coin for an item lies along the bottom of the
// item's thumbnail, from its right corner leftwards. Ten agents on one browser
// ran the row 50 px past the card's left edge, over the picture and the
// neighbour's (owner, 2026-11-17). The row now stays on its thumbnail.
import { describe, expect, it } from 'vitest'
import { coinDock, DOCK_COIN, DOCK_EDGE, DOCK_MAX, DOCK_STEP } from '../src/renderer/src/zoom/coin-dock'
import { layoutOf, paint, type FrameEls, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

/** A thumbnail's half width (zoom.css · .zv-ip > .zv-th, 168 wide). */
const HALF = 84

const row = (n: number) => Array.from({ length: n }, (_, j) => coinDock(j, n))

describe('the coins docked on a thumbnail', () => {
  it('lies from the right corner leftwards, at its own pitch while there is room', () => {
    expect(row(3).map((d) => d.dx)).toEqual([DOCK_EDGE, DOCK_EDGE - DOCK_STEP, DOCK_EDGE - 2 * DOCK_STEP])
    expect(row(3).every((d) => d.shown)).toBe(true)
  })

  it('never reaches past the thumbnail, however many agents share it', () => {
    for (const n of [1, 2, 7, 8, 10, 12, 13, 40]) {
      for (const d of row(n)) {
        expect(d.dx + DOCK_COIN / 2).toBeLessThanOrEqual(HALF)
        expect(d.dx - DOCK_COIN / 2).toBeGreaterThanOrEqual(-HALF)
      }
    }
  })

  it('closes up into a stack when crowded, each coin still showing part of its face', () => {
    const ten = row(10)
    expect(ten.every((d) => d.shown)).toBe(true)
    const step = ten[0].dx - ten[1].dx
    expect(step).toBeLessThan(DOCK_STEP)
    expect(step).toBeGreaterThanOrEqual(DOCK_COIN * 0.45)
    // Evenly, from the right corner to the left one.
    expect(ten[9].dx).toBeCloseTo(-DOCK_EDGE)
  })

  it('past what fits, the rest wait under the last coin shown, hidden', () => {
    const many = row(40)
    const shown = many.filter((d) => d.shown)
    expect(DOCK_MAX).toBe(12)
    expect(shown).toHaveLength(DOCK_MAX)
    const last = shown[shown.length - 1]
    for (const d of many.slice(shown.length)) expect(d).toEqual({ dx: last.dx, shown: false })
  })
})

// The painter, at the artifacts stop: ten agents on one browser, as in the owner's screenshot.
describe('the artifacts stop paints the row on its thumbnail', () => {
  const part = (): HTMLElement => ({ style: { setProperty: () => undefined } }) as unknown as HTMLElement
  const nums = (t: string, fn: string): number[] => (t.match(new RegExp(`${fn}\\(([^)]*)\\)`))?.[1] ?? '').split(',').map((n) => parseFloat(n))

  function paintShared(sharers: number, narrow: boolean) {
    const base = modelOf(sharers)
    const ids = base.agents.map((a) => a.id)
    const model: FrameModel = {
      ...base,
      items: [
        { id: 'tg', kind: 'browser', owners: ids },
        { id: 'b1', kind: 'browser', owners: [] },
        { id: 'b2', kind: 'browser', owners: [] }
      ],
      links: ids.map((id, j) => ({ key: `${id}|tg`, agent: id, item: 'tg', k: 0, j, of: sharers, u: j }))
    }
    const links = new Map(model.links.map((l) => [l.key, { node: part(), th: part(), coin: part(), badge: null }]))
    const items = new Map(model.items.map((i) => [i.id, { node: part(), ttl: part() }]))
    const L = layoutOf(model, narrow)
    const els = { devices: part(), device: part(), scene: part(), panel: part(), wash: part(), label: part(), newCap: part(), machine: part(), labelW: 200, labelH: 24, agents: new Map(), links, items, ties: new Map(), marks: new Map(), next: null } as unknown as FrameEls
    paint(model, L, els, { dir: 'items', sv: 0, w: narrow ? 320 : 1280, h: narrow ? 693 : 800, narrow, focus: null, leaving: null, leavingAmt: 0, focusItem: null })
    const item = nums(items.get('tg')!.node.style.transform, 'translate')
    const coins = model.links.map((l) => {
      const t = links.get(l.key)!.node.style
      return { x: nums(t.transform, 'translate')[0], k: nums(t.transform, 'scale')[0], o: Number(t.opacity) }
    })
    return { item, coins }
  }

  for (const narrow of [false, true]) {
    it(`keeps every coin seen and inside the card ${narrow ? 'on a phone' : 'on a desk'}`, () => {
      const { item, coins } = paintShared(10, narrow)
      for (const c of coins) {
        expect(c.o).toBeGreaterThan(0.99)
        expect(c.x + 11 * c.k).toBeLessThanOrEqual(item[0] + HALF)
        expect(c.x - 11 * c.k).toBeGreaterThanOrEqual(item[0] - HALF)
      }
      // One place each: no two coins on the same spot, no gap wider than the pitch.
      const xs = coins.map((c) => c.x).sort((a, b) => a - b)
      for (let n = 1; n < xs.length; n++) {
        expect(xs[n] - xs[n - 1]).toBeGreaterThan(5)
        expect(xs[n] - xs[n - 1]).toBeLessThanOrEqual(DOCK_STEP * 1.2 + 0.1)
      }
    })
  }

  it('hides only the coins past what fits', () => {
    const { coins } = paintShared(20, false)
    const seen = coins.filter((c) => c.o > 0.5).length
    expect(seen).toBe(DOCK_MAX)
  })
})
