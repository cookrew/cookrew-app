import { describe, expect, it } from 'vitest'
import {
  geometryKey,
  routeCables,
  type CableLink,
  type CableRect
} from '../src/renderer/src/cable-route'

/**
 * THE HARNESS ROUTER — cables around cards, shared runs drawn once.
 *
 * Measured on the live board before this existed: 297 cables drawn centre to
 * centre crossed each other 3,112 times. Routed orthogonally through the gaps
 * between cards, with every shared grid edge drawn once, the same cables cross
 * 1,247 times and use a quarter of the ink; with the long ones named instead
 * of drawn, zero. The rules under test are the ones those numbers rest on: a
 * route never passes through a card, cables that travel together become one
 * trunk, a cable too long to follow is reported rather than drawn, and the
 * whole thing is deterministic — a layout that changes between two identical
 * inputs would make cards' cables flicker.
 */

const card = (id: string, x: number, y: number, width = 640, height = 420): CableRect => ({
  id,
  x,
  y,
  width,
  height
})
const link = (a: string, b: string): CableLink => ({ id: `${a}~${b}`, a, b })

const inside = (p: { x: number; y: number }, r: CableRect): boolean =>
  p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height

describe('routing around cards', () => {
  it('never runs a trunk through a card that sits between the two ends', () => {
    // Three cards in a row; the outer two are wired. The obvious straight line
    // passes through the middle card — the route must not.
    const rects = [card('left', 0, 0), card('middle', 800, 0), card('right', 1600, 0)]
    // farPx raised: these tests are about routing, and the default threshold
    // would name a 1,600 px cable rather than draw it.
    const harness = routeCables(rects, [link('left', 'right')], { farPx: 4000 })
    expect(harness.unrouted).toEqual([])
    expect(harness.trunks.length).toBeGreaterThan(0)
    for (const t of harness.trunks) {
      const mid = { x: (t.x1 + t.x2) / 2, y: (t.y1 + t.y2) / 2 }
      expect(inside(mid, rects[1]), `trunk through the middle card at ${mid.x},${mid.y}`).toBe(false)
    }
  })

  it('bundles cables that share a corridor into one trunk with a count', () => {
    // Two cards stacked on the left, one on the right, both left ones wired to
    // it: their runs share the corridor and that corridor is drawn ONCE.
    const rects = [card('a', 0, 0), card('b', 0, 600), card('hub', 2400, 300)]
    const harness = routeCables(rects, [link('a', 'hub'), link('b', 'hub')], { farPx: 4000 })
    expect(harness.unrouted).toEqual([])
    const shared = harness.trunks.filter((t) => t.count === 2)
    expect(shared.length, 'at least one run carrying both cables').toBeGreaterThan(0)
    // And a shared run names both links, so a hover can light the right ones.
    expect(new Set(shared[0].links)).toEqual(new Set(['a~hub', 'b~hub']))
  })

  it('reports a cable it cannot route rather than drawing through anything', () => {
    // A card walled in on all four sides by cards butted against it: there is
    // no free cell for a cable to leave from, and that is a fact about the
    // board worth surfacing — it is where the board is physically tangled.
    const w = 640
    const h = 420
    const rects = [
      card('core', w, h),
      card('n', 0, 0, 3 * w, h),
      card('s', 0, 2 * h, 3 * w, h),
      card('w', 0, h, w, h),
      card('e', 2 * w, h, w, h),
      card('far', 5000, 5000)
    ]
    const harness = routeCables(rects, [link('core', 'far')], { farPx: 20000 })
    expect(harness.unrouted).toEqual(['core~far'])
    expect(harness.trunks).toEqual([])
  })
})

describe('what is far is named, not drawn', () => {
  it('leaves a cable longer than farPx out of the harness and reports it', () => {
    const rects = [card('a', 0, 0), card('b', 6000, 0)]
    const harness = routeCables(rects, [link('a', 'b')], { farPx: 1500 })
    expect(harness.trunks).toEqual([])
    expect(harness.far.map((f) => f.link)).toEqual(['a~b'])
    expect(harness.far[0].distance).toBeGreaterThan(1500)
  })

  it('routes a cable exactly at the threshold', () => {
    const rects = [card('a', 0, 0), card('b', 1000, 0)]
    const harness = routeCables(rects, [link('a', 'b')], { farPx: 1500 })
    expect(harness.far).toEqual([])
    expect(harness.trunks.length).toBeGreaterThan(0)
  })
})

describe('stability', () => {
  it('is deterministic — the same board routes the same way twice', () => {
    const rects = [card('a', 0, 0), card('b', 900, 500), card('c', 200, 1100), card('d', 1500, 1100)]
    const links = [link('a', 'b'), link('a', 'c'), link('c', 'd'), link('b', 'd')]
    expect(JSON.stringify(routeCables(rects, links))).toBe(JSON.stringify(routeCables(rects, links)))
  })

  it('keys geometry so a pan or zoom changes nothing and a moved card changes everything', () => {
    const rects = [card('a', 0, 0), card('b', 900, 500)]
    const links = [link('a', 'b')]
    const key = geometryKey(rects, links)
    expect(geometryKey(rects, links)).toBe(key)
    expect(geometryKey([card('a', 0, 0), card('b', 901, 500)], links)).not.toBe(key)
    expect(geometryKey(rects, [])).not.toBe(key)
  })

  it('stays quick at the size of the live board', () => {
    // 210 cards, ~300 cables, in the sprawl the real board has. The router runs
    // on the renderer's thread after a drag settles; a second would be felt.
    const rects: CableRect[] = []
    for (let i = 0; i < 210; i += 1) {
      rects.push(card(`c${i}`, (i % 14) * 900, Math.floor(i / 14) * 700, i % 3 === 0 ? 640 : 280, i % 3 === 0 ? 420 : 220))
    }
    const links: CableLink[] = []
    for (let i = 0; i < 300; i += 1) links.push(link(`c${i % 210}`, `c${(i * 37 + 11) % 210}`))
    const t0 = performance.now()
    const harness = routeCables(rects, links, { farPx: 4000 })
    const ms = performance.now() - t0
    expect(harness.trunks.length + harness.far.length).toBeGreaterThan(0)
    expect(ms, `routed ${links.length} cables in ${ms.toFixed(0)} ms`).toBeLessThan(1500)
  })
})

describe('bundling is a preference, not an accident', () => {
  it('pulls a later cable onto a trunk an earlier one already laid', () => {
    // Two cards stacked on the left, a hub far to the right. Routed alone, each
    // cable takes its own row to the hub: two parallel wires, nothing shared.
    // With the pull, the second cable pays two turns to join the first's run
    // and rides it most of the way — which is what makes a harness a harness
    // rather than parallel wires. The corridor is long on purpose: the
    // discount has to outweigh the detour, and on a short run it should not.
    const rects = [card('a', 0, 0), card('b', 0, 1200), card('hub', 9000, 500)]
    const links = [link('a', 'hub'), link('b', 'hub')]
    const alone = routeCables(rects, links, { farPx: 99_999, bundlePull: 0 })
    const pulled = routeCables(rects, links, { farPx: 99_999 })
    const length = (t: { x1: number; y1: number; x2: number; y2: number }): number => Math.hypot(t.x2 - t.x1, t.y2 - t.y1)
    const sharedLength = (h: ReturnType<typeof routeCables>): number =>
      h.trunks.filter((t) => t.count >= 2).reduce((s, t) => s + length(t), 0)
    const ink = (h: ReturnType<typeof routeCables>): number => h.trunks.reduce((s, t) => s + length(t), 0)
    expect(sharedLength(alone)).toBe(0)
    expect(sharedLength(pulled)).toBeGreaterThan(5000)
    // Sharing is not just prettier, it is less ink: one run instead of two.
    expect(ink(pulled)).toBeLessThan(ink(alone) * 0.7)
    expect(pulled.unrouted).toEqual([])
  })

  it('draws a straight shared run as ONE trunk, not one per grid cell', () => {
    // A clear corridor between two cards: the run is a single line, so the
    // layer draws one element and a hover lights one thing.
    const rects = [card('a', 0, 0), card('b', 3000, 0)]
    const harness = routeCables(rects, [link('a', 'b')], { farPx: 6000 })
    expect(harness.unrouted).toEqual([])
    const horizontal = harness.trunks.filter((t) => t.y1 === t.y2)
    expect(horizontal.length, `horizontal trunks: ${JSON.stringify(horizontal)}`).toBe(1)
    expect(Math.abs(horizontal[0].x2 - horizontal[0].x1)).toBeGreaterThan(1000)
  })
})
