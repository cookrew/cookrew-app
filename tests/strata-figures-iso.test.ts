import { describe, expect, it } from 'vitest'
import {
  C,
  clipConvex,
  finish,
  frameFit,
  frameScale,
  hash,
  hull,
  isoRaw,
  makePen,
  memo,
  num,
  on,
  PALS,
  PX,
  rrUV,
  S,
  signedArea,
  tone,
  toneI,
  type V2
} from '../src/strata/figures/iso'

const pen = (wob = 0) => makePen({ s: 2, ox: 100, oy: 100, k: 1, vw: 240, wob, seed: 7 })

/** A tiny scene through every primitive: board, shadow, box, extrusion, cylinder, rod, sphere, text. */
const scene = (wob = 0) => {
  const f = frameFit({ vw: 240, vh: 180, fit: [[0, 0, 0], [40, 40, 0], [40, 40, 30], [0, 0, 30]], shadowZ: 0, wob, seed: 3 })
  const p = f.pen
  const prof = rrUV(5, 0, 35, 20, 4)
  const body =
    p.board(0, 0, 40, 40, 2, 4) +
    p.castShadow([...on(PX(10), prof), ...on(PX(30), prof)], 2, p.boardTop(0, 0, 40, 40, 2, 4)) +
    p.extrude(prof, 10, 30, PALS.mustard) +
    p.shape(on(PX(30), prof), PALS.mustard.l, 2.2) +
    p.hullInk([...on(PX(10), prof), ...on(PX(30), prof)], 2.8) +
    p.box(2, 2, 2, 8, 8, 10, PALS.cobalt) +
    p.cyl(34, 6, 2, 12, 3, PALS.mint) +
    p.rod([20, 20, 22], [30, 30, 28], 1, PALS.tomato) +
    p.sphere([20, 20, 26], 3, PALS.blush, { dashed: true }) +
    p.tx(30, 20, 8, 'A&B', 3)
  return finish(f, body, { portal: p.rectOf(on(PX(30), prof)) })
}

describe('iso projection and light', () => {
  it('projects the colorfigures basis: x to lower right, y to lower left, z up', () => {
    expect(isoRaw([1, 0, 0])).toEqual([C, S])
    expect(isoRaw([0, 1, 0])).toEqual([-C, S])
    expect(isoRaw([0, 0, 1])).toEqual([0, -1])
  })

  it('shades the front lit, the left side dark and the top lit', () => {
    const m = PALS.mustard
    expect(tone([1, 0, 0], m)).toBe(m.l)
    expect(tone([0, 1, 0], m)).toBe(m.d)
    expect(tone([0, 0, 1], m)).toBe(m.l)
    expect(toneI([0, 0, 1], m)).toBe(m.l)
    expect(toneI([1, 0, 0], m)).toBe(m.m)
  })

  it('casts shadows toward the lower left of the screen', () => {
    const p = pen()
    const base = p.P([0, 0, 0])
    const tip = p.shadowOf([0, 0, 10], 0)
    expect(tip[0]).toBeLessThan(base[0])
    expect(tip[1]).toBeGreaterThan(base[1])
  })
})

describe('iso geometry', () => {
  it('hulls points and clips a polygon by a convex one', () => {
    const square = (a: number, b: number): V2[] => [[a, a], [b, a], [b, b], [a, b]]
    expect(hull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]])).toHaveLength(4)
    const clipped = clipConvex(square(0, 10), square(5, 15))
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(25)
    expect(clipConvex(square(0, 1), square(5, 6))).toHaveLength(0)
  })

  it('writes short numbers', () => {
    expect(num(12)).toBe('12')
    expect(num(-0.04)).toBe('0')
    expect(num(3.14159)).toBe('3.1')
  })
})

describe('iso output', () => {
  it('is deterministic', () => {
    expect(scene()).toEqual(scene())
    expect(scene(0.8)).toEqual(scene(0.8))
  })

  it('carries no ids, external refs, filters or scripts', () => {
    const { svg } = scene(0.8)
    expect(svg).not.toMatch(/\bid=|url\(|href|<filter|<script|clip-path|NaN|undefined/)
    expect(svg).toContain('&#38;B')
  })

  it('wobbles only heavy ink, and only when asked', () => {
    const flat = pen(0)
    const wobbly = pen(0.8)
    const square: [number, number, number][] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]]
    expect(wobbly.ink(square, 0.9)).toBe(flat.ink(square, 0.9))
    expect(wobbly.ink(square, 2.8)).not.toBe(flat.ink(square, 2.8))
    expect(wobbly.ink(square, 2.8)).toBe(pen(0.8).ink(square, 2.8))
  })

  it('inks the silhouette in currentColor so a dark page can lift it', () => {
    const { svg } = scene()
    expect(svg).toMatch(/stroke="currentColor"/)
    expect(svg).toMatch(/^<svg [^>]*color="#231e16"/)
  })

  it('frames anchors inside the viewBox', () => {
    const art = scene()
    const r = art.anchors.portal
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(art.viewBox.w)
    expect(r.y + r.h).toBeLessThanOrEqual(art.viewBox.h)
  })

  it('grows the viewBox with the model at a fixed scale', () => {
    const small = frameScale({ scale: 2, fit: [[0, 0, 0], [10, 10, 10]] })
    const big = frameScale({ scale: 2, fit: [[0, 0, 0], [10, 40, 10]] })
    expect(big.vw).toBeGreaterThan(small.vw)
    expect(big.pen.spec.s).toBe(small.pen.spec.s)
  })
})

describe('memo and hash', () => {
  it('returns the very same output for the same input', () => {
    let calls = 0
    const draw = memo((i: { a: number }) => ({ v: i.a, n: ++calls }))
    expect(draw({ a: 1 })).toBe(draw({ a: 1 }))
    expect(calls).toBe(1)
  })

  it('hashes stably', () => {
    expect(hash('Monorepo')).toBe(hash('Monorepo'))
    expect(hash('Monorepo')).not.toBe(hash('monorepo'))
  })
})
