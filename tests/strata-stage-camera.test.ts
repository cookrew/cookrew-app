import { describe, expect, it } from 'vitest'
import type { Rect } from '../src/shared/strata'
import { fitPivot, pushOf, scaleRectAbout, transformAbout, visibleShare, PUSH_CAP } from '../src/strata/stage/camera'
import { DIVE, FLY, ease, settleCurve } from '../src/strata/stage/easing'
import { GRID_CELL, boundariesOf, durationOf, easingOf, framesFor, geometryOf, gridPivot, stateAt, type FlightGeometry } from '../src/strata/stage/timeline'
import { planFlight } from '../src/strata/stage/plan'

const V: Rect = { x: 0, y: 0, w: 1440, h: 900 }
const close = (a: number, b: number, eps = 0.5) => expect(Math.abs(a - b)).toBeLessThan(eps)

/** "translate(Fx, Fy) scale(s) translate(-Fx, -Fy)" → { F, s }, or identity. */
const parse = (t: string) => {
  if (t === 'none') return { F: { x: 0, y: 0 }, s: 1 }
  const m = t.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.e-]+)\)/)
  if (!m) throw new Error(`unparsed transform ${t}`)
  return { F: { x: Number(m[1]), y: Number(m[2]) }, s: Number(m[3]) }
}
const apply = (t: string, r: Rect): Rect => {
  const { F, s } = parse(t)
  return scaleRectAbout(F, s, r)
}

describe('camera: one pivot, one scale', () => {
  const R: Rect = { x: 1100, y: 600, w: 200, h: 125 }

  it('the incoming scene at 1/K about F sits exactly in the anchor', () => {
    const p = fitPivot(R, V)!
    const placed = scaleRectAbout(p.F, p.k, V)
    close(placed.x, R.x)
    close(placed.y, R.y)
    close(placed.w, R.w)
    close(placed.h, R.h)
  })

  it('the outgoing scene at K about F carries the anchor onto the viewport', () => {
    const p = fitPivot(R, V)!
    const landed = scaleRectAbout(p.F, p.K, R)
    close(landed.x, 0)
    close(landed.w, 1440)
  })

  it('contain-fits a content rect of another aspect, centred in the anchor', () => {
    const portrait: Rect = { x: 0, y: 0, w: 390, h: 844 }
    const p = fitPivot(R, portrait)!
    const placed = scaleRectAbout(p.F, p.k, portrait)
    close(placed.h, R.h)
    expect(placed.w).toBeLessThan(R.w)
    close(placed.x + placed.w / 2, R.x + R.w / 2)
  })

  it('refuses steps that are not a zoom in', () => {
    expect(fitPivot({ x: 0, y: 0, w: 1440, h: 900 }, V)).toBeNull()
    expect(fitPivot({ x: 0, y: 0, w: 0, h: 10 }, V)).toBeNull()
    expect(fitPivot({ x: 0, y: 0, w: 2000, h: 1200 }, V)).toBeNull()
  })

  it('caps the push only where a terminal opens', () => {
    expect(pushOf(10, false)).toBe(10)
    expect(pushOf(10, true)).toBe(PUSH_CAP)
    expect(pushOf(2, true)).toBe(2)
  })

  it('measures how much of a rect is on screen', () => {
    expect(visibleShare({ x: -50, y: 0, w: 100, h: 100 }, V)).toBeCloseTo(0.5)
    expect(visibleShare({ x: 0, y: 1000, w: 10, h: 10 }, V)).toBe(0)
  })
})

describe('easing', () => {
  it('hits the ends and is monotonic', () => {
    for (const curve of [FLY, DIVE]) {
      expect(ease(curve, 0)).toBe(0)
      expect(ease(curve, 1)).toBe(1)
      const ys = Array.from({ length: 21 }, (_, i) => ease(curve, i / 20))
      ys.slice(1).forEach((y, i) => expect(y).toBeGreaterThanOrEqual(ys[i]))
    }
  })

  it('FLY lands long and quiet like the reference, but launches sooner', () => {
    const felix = [0.57, 0, 0.34, 1] as const
    expect(ease(FLY, 0.25)).toBeGreaterThan(ease(felix, 0.25))
    expect(ease(FLY, 0.75)).toBeGreaterThan(0.95)
  })

  it('settle launches at the finger speed, clamped', () => {
    expect(settleCurve(0)[1]).toBe(0)
    expect(settleCurve(2)[1]).toBeCloseTo(0.5)
    expect(settleCurve(99)[1]).toBe(1)
  })
})

const AGENTS = { machine: 'm', workspace: 'w' }
const TERMINAL = { ...AGENTS, agent: 'a' }
const oneStep = (R: Rect, C: Rect | null = null, dir: 1 | -1 = 1, into: 'workspaces' | 'terminal' = 'workspaces'): FlightGeometry => {
  const [shallow, deep] = into === 'terminal' ? [AGENTS, TERMINAL] : [{}, { machine: 'm' }]
  const plan = dir > 0 ? planFlight(shallow, deep) : planFlight(deep, shallow)
  if (plan.kind === 'none') throw new Error('no plan')
  return geometryOf(plan, [{ anchor: R, content: C }], V, false)
}

describe('timeline: a single step', () => {
  const R: Rect = { x: 900, y: 500, w: 240, h: 150 }
  const g = oneStep(R)

  it('is a zoom with a duration inside 450–650 ms', () => {
    expect(g.kind).toBe('zoom')
    expect(durationOf(g)).toBeGreaterThanOrEqual(450)
    expect(durationOf(g)).toBeLessThanOrEqual(650)
    expect(easingOf(g)).toBe('cubic-bezier(0.45, 0, 0.15, 1)')
  })

  it('starts on the outgoing level and ends on the incoming one', () => {
    const a = stateAt(g, 0)
    expect(parse(a.scenes[0].transform).s).toBe(1)
    expect(a.scenes[0].opacity).toBe(1)
    expect(a.scenes[1].opacity).toBe(0)
    const b = stateAt(g, 1)
    expect(parse(b.scenes[1].transform).s).toBe(1)
    expect(b.scenes[1].opacity).toBe(1)
    expect(b.scenes[0].opacity).toBe(0)
  })

  it('keeps the incoming level inside the anchor for the whole flight (B = A ∘ fit)', () => {
    for (const p of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
      const st = stateAt(g, p)
      const anchorNow = apply(st.scenes[0].transform, R)
      const incomingNow = apply(st.scenes[1].transform, V)
      close(incomingNow.x + incomingNow.w / 2, anchorNow.x + anchorNow.w / 2, 1)
      close(incomingNow.w, anchorNow.w, 1)
    }
  })

  it('out is in played backwards', () => {
    const out = oneStep(R, null, -1)
    for (const p of [0, 0.2, 0.5, 0.9, 1]) expect(stateAt(out, p)).toEqual(stateAt(g, 1 - p))
  })

  it('the paper doubles once per step and is the same picture at both ends', () => {
    const a = stateAt(g, 0)
    const b = stateAt(g, 1)
    expect(parse(a.coarse.transform).s).toBe(1)
    expect(a.coarse.opacity).toBe(1)
    expect(parse(b.fine.transform).s).toBe(2)
    expect(b.fine.opacity).toBe(1)
    expect(b.coarse.opacity).toBe(0)
  })

  it('the paper pivot sits on the lattice, so the doubled fine dots land on the coarse ones', () => {
    for (const F of [{ x: 1333.7, y: 411.2 }, { x: -500, y: 2000 }, { x: 13, y: 11 }]) {
      const G = gridPivot(F, V)
      // fine dots at 6 + 12i, doubled about G, must be coarse dots 12 + 24m
      for (const i of [0, 3, 17]) {
        const landed = 2 * (GRID_CELL / 4 + (GRID_CELL / 2) * i) - G.x
        expect(((landed - GRID_CELL / 2) % GRID_CELL + GRID_CELL) % GRID_CELL).toBeCloseTo(0, 6)
      }
      expect(G.x).toBeGreaterThanOrEqual(0)
      expect(G.x).toBeLessThanOrEqual(V.w)
    }
  })

  it('keyframes are ordered, cover 0..1 and agree with stateAt at the ends', () => {
    const f = framesFor(g)
    const offsets = f.scenes[0].map((k) => k.offset as number)
    expect(offsets[0]).toBe(0)
    expect(offsets[offsets.length - 1]).toBe(1)
    offsets.slice(1).forEach((o, i) => expect(o).toBeGreaterThanOrEqual(offsets[i]))
    expect(f.scenes[1][0].opacity).toBe(stateAt(g, 0).scenes[1].opacity)
    expect(f.scenes[1][offsets.length - 1].transform).toBe(stateAt(g, 1).scenes[1].transform)
  })

  it('a partial range (settle after a scrub) starts exactly where the finger left it', () => {
    const f = framesFor(g, 0.42, 1)
    expect(f.scenes[0][0].transform).toBe(stateAt(g, 0.42).scenes[0].transform)
    const back = framesFor(g, 0.42, 0)
    expect(back.scenes[1][back.scenes[1].length - 1].opacity).toBe(0)
  })

  it('a big push into a nested level stays aligned (a phone portal is ~10×)', () => {
    const portal: Rect = { x: 30, y: 200, w: 120, h: 80 }
    const phone: Rect = { x: 0, y: 0, w: 390, h: 844 }
    const t = oneStep(portal, phone)
    if (t.kind !== 'zoom') throw new Error('expected a zoom')
    expect(t.steps[0].pivot.K).toBeGreaterThan(9)
    expect(parse(stateAt(t, 1).scenes[0].transform).s).toBeCloseTo(t.steps[0].pivot.K, 3)
  })

  it('a terminal opens out of the avatar: the agents level only recedes', () => {
    const avatar: Rect = { x: 700, y: 430, w: 36, h: 36 }
    const terminal: Rect = { x: 270, y: 60, w: 900, h: 780 }
    const t = oneStep(avatar, terminal, 1, 'terminal')
    if (t.kind !== 'zoom') throw new Error('expected a zoom')
    expect(t.steps[0].pivot.K).toBeGreaterThan(12)
    expect(parse(stateAt(t, 1).scenes[0].transform).s).toBeCloseTo(PUSH_CAP, 3)
    const start = apply(stateAt(t, 0).scenes[1].transform, terminal)
    // 900×780 contain-fits a 36 px square by its width.
    close(start.w, 36, 1)
    expect(start.h).toBeLessThan(36)
  })
})

describe('timeline: dive-through', () => {
  const dive = planFlight({}, { machine: 'm', workspace: 'w', agent: 'a' })
  if (dive.kind === 'none') throw new Error('no plan')
  const rects = [
    { anchor: { x: 600, y: 300, w: 200, h: 125 }, content: null },
    { anchor: { x: 200, y: 200, w: 400, h: 300 }, content: { x: 120, y: 90, w: 1200, h: 900 } },
    { anchor: { x: 500, y: 400, w: 40, h: 40 }, content: { x: 270, y: 60, w: 900, h: 780 } }
  ]
  const g = geometryOf(dive, rects, V, false)

  it('takes 700–850 ms on the DIVE curve', () => {
    expect(g.kind).toBe('zoom')
    expect(durationOf(g)).toBeGreaterThanOrEqual(700)
    expect(durationOf(g)).toBeLessThanOrEqual(850)
    expect(easingOf(g)).toBe('cubic-bezier(0.4, 0, 0.2, 1)')
  })

  it('splits the timeline by log-zoom', () => {
    if (g.kind !== 'zoom') throw new Error('expected a zoom')
    const b = boundariesOf(g.steps)
    expect(b[0]).toBe(0)
    expect(b[3]).toBe(1)
    b.slice(1).forEach((x, i) => expect(x).toBeGreaterThan(b[i]))
  })

  it('never shows more than two levels at once', () => {
    for (let i = 0; i <= 100; i++) {
      const visible = stateAt(g, i / 100).scenes.filter((s) => s.opacity > 0)
      expect(visible.length).toBeLessThanOrEqual(2)
    }
  })

  it('emits both sides of each step boundary at one offset (the paper resets, scenes stay put)', () => {
    const f = framesFor(g)
    const offsets = f.coarse.map((k) => k.offset as number)
    const doubles = offsets.filter((o, i) => i > 0 && o === offsets[i - 1])
    expect(doubles.length).toBe(2)
    const at = offsets.findIndex((o, i) => i > 0 && o === offsets[i - 1])
    expect(f.coarse[at - 1].opacity).toBe(0)
    expect(f.coarse[at].opacity).toBe(1)
    expect(parse(f.scenes[1][at - 1].transform).s).toBeCloseTo(1, 4)
    expect(parse(f.scenes[1][at].transform).s).toBeCloseTo(1, 4)
  })

  it('rise is the dive reversed', () => {
    const rise = planFlight({ machine: 'm', workspace: 'w', agent: 'a' }, {})
    if (rise.kind === 'none') throw new Error('no plan')
    const r = geometryOf(rise, rects, V, false)
    for (const p of [0.1, 0.5, 0.77]) expect(stateAt(r, p)).toEqual(stateAt(g, 1 - p))
  })
})

describe('timeline: fallbacks', () => {
  it('a missing anchor flies a hop', () => {
    const plan = planFlight({}, { machine: 'm' })
    if (plan.kind === 'none') throw new Error('no plan')
    const g = geometryOf(plan, [{ anchor: null, content: null }], V, false)
    expect(g.kind).toBe('hop')
    expect(durationOf(g)).toBe(340)
    const mid = stateAt(g, 0.5)
    expect(mid.scenes[0].opacity).toBeGreaterThan(0)
    expect(mid.scenes[1].opacity).toBeGreaterThan(0)
  })

  it('reduced motion is a 120 ms crossfade with no transform', () => {
    const plan = planFlight({}, { machine: 'm', workspace: 'w', agent: 'a' })
    if (plan.kind === 'none') throw new Error('no plan')
    const g = geometryOf(plan, [], V, true)
    expect(g.kind).toBe('fade')
    expect(durationOf(g)).toBe(120)
    const mid = stateAt(g, 0.5)
    expect(mid.scenes.map((s) => s.opacity)).toEqual([0.5, 0, 0, 0.5])
    expect(mid.scenes.every((s) => s.transform === 'none')).toBe(true)
    expect(mid.coarse).toEqual({ transform: 'none', opacity: 1 })
  })

  it('a reduced out flight fades the deep level out', () => {
    const plan = planFlight({ machine: 'm', workspace: 'w' }, { machine: 'm' })
    if (plan.kind === 'none') throw new Error('no plan')
    const g = geometryOf(plan, [], V, true)
    expect(stateAt(g, 0).scenes.map((s) => s.opacity)).toEqual([0, 1])
    expect(stateAt(g, 1).scenes.map((s) => s.opacity)).toEqual([1, 0])
  })

  it('transformAbout is exact about its pivot', () => {
    expect(apply(transformAbout({ x: 100, y: 50 }, 3), { x: 100, y: 50, w: 10, h: 10 })).toEqual({ x: 100, y: 50, w: 30, h: 30 })
  })
})
