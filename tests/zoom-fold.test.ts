// THE FOLD (owner 2026-11-12): hovering an agent bends the crew's space along
// its ties, a slight, angled fold the others move with, so the agent and its
// ties stand out in depth.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FOLD, foldAt, foldFaces, foldFacesSvg, foldHeight, layoutOf, paint, terrainFaces, type AgentEls, type FoldLight, type FrameEls, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

const peak = { x: 0, y: 0 }
const right = { x: 200, y: 0 }
const down = { x: 0, y: 200 }

describe('the fold', () => {
  it('lifts the hovered agent highest, where it stands, and grows it most', () => {
    const f = foldAt(peak, peak, [right, down])
    expect(f.dx).toBe(0)
    expect(f.dy).toBe(0)
    expect(f.k).toBeCloseTo(1 / (1 - FOLD.depth), 6)
  })

  it('raises each tied agent part-way, up its ridge, and carries it out from the peak', () => {
    for (const r of [right, down]) expect(foldHeight(r, peak, [right, down])).toBeCloseTo(FOLD.ridge, 6)
    const f = foldAt(right, peak, [right, down])
    expect(f.k).toBeGreaterThan(1)
    expect(f.dx).toBeGreaterThan(0)
  })

  it('creases along the ties: one flat face between two of them, the faces meeting on the tie', () => {
    const ridges = [right, down, { x: -200, y: 0 }]
    // On the face between right and down, heights fall evenly: a plane.
    const a = foldHeight({ x: 50, y: 50 }, peak, ridges)
    const b = foldHeight({ x: 100, y: 100 }, peak, ridges)
    expect(FOLD.peak - b).toBeCloseTo(2 * (FOLD.peak - a), 6)
    // Either side of the tie to `down`, at its middle, the two faces meet.
    const left = foldHeight({ x: -0.001, y: 100 }, peak, ridges)
    const rightSide = foldHeight({ x: 0.001, y: 100 }, peak, ridges)
    expect(left).toBeCloseTo(rightSide, 3)
    expect(left).toBeCloseTo((FOLD.peak + FOLD.ridge) / 2, 3)
  })

  it('sinks the far ground a little and draws it in, never under the ground', () => {
    const f = foldAt({ x: 900, y: 900 }, peak, [right, down])
    expect(foldHeight({ x: 900, y: 900 }, peak, [right, down])).toBe(FOLD.ground)
    expect(f.k).toBeLessThan(1)
    expect(f.dx).toBeLessThan(0)
    expect(f.dy).toBeLessThan(0)
  })

  it('falls as a cone on its open side, and round an agent with fewer than two ties', () => {
    const open = foldHeight({ x: -100, y: -100 }, peak, [right, down])
    const cone = foldHeight({ x: -100, y: -100 }, peak, [])
    expect(open).toBeCloseTo(FOLD.peak - ((FOLD.peak - FOLD.ridge) * Math.hypot(100, 100)) / 200, 6)
    expect(cone).toBeCloseTo(FOLD.peak - ((FOLD.peak - FOLD.ridge) * Math.hypot(100, 100)) / FOLD.reach, 6)
  })
})

describe("the fold's faces, in light", () => {
  it('raises a face in each angle two ties close, and a narrow one on a tie\'s open side', () => {
    // Right and down close a quarter turn: one face there, and the open side gets one beside each tie.
    expect(foldFaces(peak, [right, down])).toHaveLength(3)
    // One tie: a face either side of it.
    expect(foldFaces(peak, [right])).toHaveLength(2)
    expect(foldFaces(peak, [])).toEqual([])
  })

  it('lights each face by the way it turns: faces turned apart catch different light', () => {
    const faces = foldFaces(peak, [right, down, { x: -200, y: 0 }, { x: 0, y: -200 }])
    expect(faces).toHaveLength(4)
    expect(new Set(faces.map((f) => f.light)).size).toBeGreaterThan(1)
    for (const f of faces) {
      expect(f.light).toBeGreaterThanOrEqual(0)
      expect(f.light).toBeLessThanOrEqual(1)
    }
  })

  it('draws each face in the paper itself, lighter to the light and darker away, never in a colour of its own', () => {
    const svg = foldFacesSvg(foldFaces(peak, [right, down]))
    expect((svg.match(/<path /g) ?? []).length).toBe(3)
    expect((svg.match(/<linearGradient /g) ?? []).length).toBe(3)
    const colours = [...svg.matchAll(/stop-color:([^;]+);/g)].map((m) => m[1])
    for (const c of colours) expect(c).toMatch(/^color-mix\(in srgb, var\(--zv-paper, var\(--sumi-paper, #f4efe4\)\) \d+%, #(fff|000) \d+%\)$/)
    expect(svg).not.toMatch(/hsl\(/)
    expect(foldFacesSvg([{ pts: [peak, right, down], light: 1 }])).toContain('#fff')
    expect(foldFacesSvg([{ pts: [peak, right, down], light: 0 }])).toContain('#000')
    expect(foldFacesSvg([])).toBe('')
  })
})

describe('the crew as one terrain', () => {
  const at = { hub: { x: 0, y: 0 }, e: { x: 200, y: 0 }, s: { x: 0, y: 200 }, w: { x: -200, y: 0 }, end: { x: 400, y: 0 } }
  const ties = [{ a: 'hub', b: 'e' }, { a: 'hub', b: 's' }, { a: 'hub', b: 'w' }, { a: 'e', b: 'end' }]

  it('raises a face in each angle an agent\'s ties close, out to the ties\' middles, and none round an end', () => {
    const faces = terrainFaces(at, ties)
    // The hub closes two quarter turns (e–s, s–w); e's ties run straight on, an open half turn; the ends have one tie.
    expect(faces).toHaveLength(2)
    for (const f of faces) {
      expect(f.pts[0]).toEqual(at.hub)
      for (const p of f.pts.slice(1)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6)
    }
  })

  it('lights its faces as the fold\'s are, and leaves a crew with no ties dark', () => {
    for (const f of terrainFaces(at, ties)) expect(f.light).toBeGreaterThanOrEqual(0)
    expect(terrainFaces(at, [])).toEqual([])
  })
})

describe('the painter, with the pointer on an agent', () => {
  type Part = HTMLElement & { _t?: string; _o?: number }
  const part = (): Part => ({ style: { setProperty: () => undefined } }) as unknown as Part
  const agentEls = (): AgentEls =>
    ({
      node: part(), cardl: part(), card: part(), av: part(), nm: part(), st: part(), cnt: part(), dft: part(),
      body: part(), reply: part(), emp: part(), dot: null, nmW: 60, stW: 50, cntW: 40, nmH: 18, stH: 13
    }) as unknown as AgentEls
  const nums = (t: string, fn: string): number[] => (t.match(new RegExp(`${fn}\\(([^)]*)\\)`))?.[1] ?? '').split(',').map((n) => parseFloat(n))

  const run = (model: FrameModel, hover: { id: string; amt: number } | null, sv = 1, light?: FoldLight) => {
    const agents = new Map(model.agents.map((a) => [a.id, agentEls()] as const))
    const fold = part() as Part & { innerHTML: string }
    const glow = part() as Part & { innerHTML: string }
    const els = {
      devices: part(), device: part(), scene: part(), panel: part(), wash: part(), label: part(), newCap: part(), machine: part(),
      labelW: 200, labelH: 24, agents, links: new Map(), items: new Map(), ties: new Map(), fold, glow, marks: new Map(), next: null
    } as unknown as FrameEls
    paint(model, layoutOf(model, false), els, { dir: 'agents', sv, focus: model.agents[0].id, leaving: null, leavingAmt: 0, focusItem: null, w: 1400, h: 900, narrow: false, hover, light })
    const face = (id: string) => ({ at: nums(agents.get(id)!.node.style.transform, 'translate'), o: Number(agents.get(id)!.node.style.opacity), s: nums(agents.get(id)!.av.style.transform, 'scale')[0] })
    return Object.assign(face, { faces: (fold.innerHTML ?? '').match(/<path /g)?.length ?? 0, glow: (glow.innerHTML ?? '').match(/<path /g)?.length ?? 0, glowO: Number(glow.style.opacity), foldO: Number(fold.style.opacity), foldSvg: fold.innerHTML ?? '', glowSvg: glow.innerHTML ?? '' })
  }
  const crew = (): FrameModel => ({ ...modelOf(6), ties: [{ key: 't1', a: 'a0', b: 'a1' }, { key: 't2', a: 'a0', b: 'a2' }] })

  it('grows the hovered agent, moves the crew with the fold, and sets back what is not on it', () => {
    const flat = run(crew(), null)
    const folded = run(crew(), { id: 'a0', amt: 1 })
    expect(folded('a0').s).toBeGreaterThan(flat('a0').s)
    expect(folded('a0').at).toEqual(flat('a0').at)
    expect(folded('a1').at).not.toEqual(flat('a1').at)
    expect(folded('a1').o).toBe(flat('a1').o)
    expect(folded('a5').o).toBeLessThan(flat('a5').o)
  })

  it('draws the fold\'s faces in their light while it folds, and none when it lies flat', () => {
    expect(run(crew(), { id: 'a0', amt: 1 }).faces).toBeGreaterThan(0)
    expect(run(crew(), null).faces).toBe(0)
  })

  it('lights the crew at rest only when asked: every agent its own peak, or one terrain', () => {
    const lit = (): FrameModel => ({ ...modelOf(4), ties: [{ key: 't1', a: 'a0', b: 'a1' }, { key: 't2', a: 'a0', b: 'a2' }, { key: 't3', a: 'a1', b: 'a3' }] })
    expect(run(lit(), null).glow).toBe(0)
    expect(run(lit(), null, 1, 'hover').glow).toBe(0)
    expect(run(lit(), null, 1, 'every').glow).toBeGreaterThan(0)
    expect(run(lit(), null, 1, 'terrain').glow).toBeGreaterThan(0)
  })

  it('gives the light at rest up as a hovered fold comes, so the two never disagree', () => {
    const still = run(crew(), null, 1, 'every').glowO
    const coming = run(crew(), { id: 'a0', amt: 0.5 }, 1, 'every').glowO
    const hovered = run(crew(), { id: 'a0', amt: 1 }, 1, 'every').glowO
    expect(coming).toBeLessThan(still)
    expect(coming).toBeGreaterThan(0)
    expect(hovered).toBe(0)
  })

  // A PHONE LEFT PARTS OF THE PAGE UNDRAWN (owner, 2026-11-13): the faces were drawn anew on every
  // frame of a fold and of a zoom, more than its raster could keep up with. Now one drawing each.
  it('draws the fold once: easing in or out it is the same drawing, only its opacity moves', () => {
    const part = run(crew(), { id: 'a0', amt: 0.3 })
    const full = run(crew(), { id: 'a0', amt: 1 })
    expect(part.foldSvg).not.toBe('')
    expect(part.foldSvg).toBe(full.foldSvg)
    expect(part.foldO).toBeLessThan(full.foldO)
  })

  it('draws the light at rest where the crew rests: the same drawing on every frame of a zoom into it', () => {
    const lit = (): FrameModel => ({ ...modelOf(8), ties: [{ key: 't1', a: 'a0', b: 'a1' }, { key: 't2', a: 'a0', b: 'a2' }, { key: 't3', a: 'a6', b: 'a7' }, { key: 't4', a: 'a6', b: 'a5' }] })
    for (const light of ['every', 'terrain'] as const) {
      const arriving = run(lit(), null, 0.9, light)
      const there = run(lit(), null, 1, light)
      expect(there.glowSvg, light).not.toBe('')
      expect(arriving.glowSvg, light).toBe(there.glowSvg)
    }
  })

  it('never folds for a finger: a tap focuses the face, and only a focus the keyboard brought folds', () => {
    const parts = readFileSync(new URL('../src/renderer/src/zoom/ZoomParts.tsx', import.meta.url), 'utf8')
    expect(parts).toMatch(/onPointerEnter=\{\(e\) => e\.pointerType !== 'touch' && onHoverIn\?\.\(\)\}/)
    expect(parts).toMatch(/onFocus=\{\(e\) => e\.currentTarget\.matches\(':focus-visible'\) && onHoverIn\?\.\(\)\}/)
  })

  it('folds only at the crew: on the way to a card the crew lies flat', () => {
    const flat = run(crew(), null, 2)
    const folded = run(crew(), { id: 'a0', amt: 1 }, 2)
    expect(folded('a1').at).toEqual(flat('a1').at)
  })
})
