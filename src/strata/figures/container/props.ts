// Theme props: small hand-inked vignettes on the table's back panel and the
// strip in front of it. Each one is centred at y and stays within ±7 units,
// so two fit a module; the table itself never changes for them. Each is kept
// to a dozen elements or so: a long table carries eight.
import { arcUV, ellUV, on, PX, PZ, rectUV, rrUV, type UV, type V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { CERAMIC, CLEAR, DARK, INK, matOf, METAL, mix, PALS, PAPER, SCREEN, SCREEN_TEXT, tone, WOOD, type Mat } from '../iso/tone'
import { HUTCH, PANEL, STRIP, TOP } from './desk'
import { flat, flats, lines, pipe, solid, stick } from './ink'
import type { Theme } from './themes'

export type Vignette = (p: Pen, y: number, m: Mat) => string

const Z = TOP
const FX = PANEL + 0.05
const SX = (STRIP.x0 + STRIP.x1) / 2
const X1 = STRIP.x1 + 0.03
const STEEL = matOf('#a9b1b5')
const POT = matOf('#c8603f')
const SAND = '#f1d9a0'
const FACETS = 10

/** Flat on the back panel's face. */
const face = (uv: readonly UV[]): V3[] => on(PX(FX), uv)

/** A frame centred at (cu, cv) and turned by deg, in a plane's (u, v). */
const turn = (cu: number, cv: number, deg: number) => {
  const a = (deg * Math.PI) / 180
  return ([u, v]: UV): UV => [cu + u * Math.cos(a) - v * Math.sin(a), cv + u * Math.sin(a) + v * Math.cos(a)]
}
const turnedRect = (cu: number, cv: number, w: number, h: number, deg: number): UV[] => rectUV(-w / 2, -h / 2, w / 2, h / 2).map(turn(cu, cv, deg))
const turnedEll = (cu: number, cv: number, ru: number, rv: number, deg: number): UV[] => ellUV(0, 0, ru, rv, 10).map(turn(cu, cv, deg))
const ring = (x: number, y: number, z: number, r: number): V3[] => on(PZ(z), ellUV(x, y, r, r, FACETS))
/** The half of a ring that faces the viewer (an open line round a cylinder). */
const frontArc = (x: number, y: number, z: number, r: number): V3[] => on(PZ(z), arcUV(x, y, r, -45, 135, 8))
const dot = (p: Pen, at: readonly [number, number], r: number, c: string) => p.stud([FX + 0.05, at[0], at[1]], r, c, 0.5)

// ── code ────────────────────────────────────────────────────────────────────
const pegboard: Vignette = (p, y, m) => {
  const holes = [2.6, 5, 7.4, 9.8].map((dz) => p.d3([[FX, y + 6.2, Z + dz], [FX, y - 6.2, Z + dz]], false)).join('')
  return (
    flat(p, face(rrUV(y - 7, Z + 1.4, y + 7, Z + 11, 0.6, 2)), mix(m.l, PAPER, 0.55)) +
    `<path d="${holes}" stroke="${m.d}" stroke-width="${num(0.9 * p.spec.k)}" stroke-dasharray="0 ${num(2.4 * p.spec.s)}"/>` +
    flat(p, face(rectUV(y + 3.6, Z + 2.4, y + 4.6, Z + 8.6)), WOOD.m, 0.8) +
    flat(p, face(rectUV(y + 2, Z + 8.2, y + 6.2, Z + 10.2)), DARK.l) +
    flat(p, face(rectUV(y - 1.2, Z + 2.2, y + 0.4, Z + 10.2)), PALS.mustard.l, 0.8) +
    lines(p, [4, 6, 8].map((dz) => face([[y - 1.2, Z + dz], [y - 0.5, Z + dz]])), 0.6) +
    flat(p, face(rectUV(y - 4.85, Z + 5.4, y - 4.35, Z + 9.8)), METAL.m, 0.6) +
    flat(p, face(rrUV(y - 5.5, Z + 2.2, y - 3.7, Z + 5.6, 0.6, 2)), PALS.tomato.l)
  )
}

const toolbox: Vignette = (p, y) => {
  const b = [STRIP.x0, y - 5, Z, STRIP.x1, y + 5, Z + 3.6] as const
  return (
    solid(p, b, PALS.tomato, 1) +
    lines(p, [[[X1, y + 5, Z + 2.5], [X1, y - 5, Z + 2.5]]], 0.8) +
    p.stud([X1, y, Z + 1.7], 0.5, METAL.l) +
    stick(p, [[SX, y - 2.4, Z + 3.6], [SX, y - 2.4, Z + 5.2], [SX, y + 2.4, Z + 5.2], [SX, y + 2.4, Z + 3.6]], 0.3, DARK) +
    p.hullInk(p.boxPts(...b), 1.6)
  )
}

// ── docs ────────────────────────────────────────────────────────────────────
const BOOK_TINTS = [PALS.cobalt, PALS.mustard, null, PALS.tomato, PALS.mint]
const books: Vignette = (p, y, m) => {
  const spines = BOOK_TINTS.map((_, i) => {
    const y0 = y - 5.4 + i * 2.1
    const h = 5.6 + ((i * 5) % 4) * 0.9
    return [[X1, y0, Z + h - 1.2], [X1, y0 + 1.8, Z + h - 1.2]] as V3[]
  })
  return (
    BOOK_TINTS.map((tint, i) => {
      const y0 = y - 5.4 + i * 2.1
      const h = 5.6 + ((i * 5) % 4) * 0.9
      return solid(p, [STRIP.x0 + (i % 2) * 0.3, y0, Z, STRIP.x1, y0 + 1.8, Z + h], tint ?? m, 0.8)
    }).join('') + lines(p, spines, 0.6)
  )
}

const pinned: Vignette = (p, y) =>
  (
    [
      [y + 3, Z + 5.8, -6],
      [y - 3, Z + 6.4, 5]
    ] as const
  )
    .map(([cy, cz, deg]) => {
      const at = turn(cy, cz, deg)
      return flat(p, face(turnedRect(cy, cz, 4.6, 6, deg)), PAPER) + lines(p, [1.2, 0, -1.2].map((v) => face([at([-1.5, v]), at([1.5, v])])), 0.6) + dot(p, at([0, 2.4]), 0.55, PALS.tomato.l)
    })
    .join('')

const lamp: Vignette = (p, y, m) => {
  const foot: V3 = [SX, y + 2.4, Z + 0.7]
  const elbow: V3 = [STRIP.x0 + 0.2, y + 1.2, Z + 8.4]
  const tip: V3 = [SX + 2.4, y - 2.4, Z + 9.4]
  return (
    p.cyl(SX, y + 2.4, Z, Z + 0.7, 1.7, DARK, tone, 1, FACETS) +
    stick(p, [foot, elbow, tip], 0.3, METAL, 1.2) +
    p.rod(tip, [tip[0] + 1.6, tip[1] - 0.8, tip[2] - 2.6], 0.7, m, tone, 1.2, 2.2, FACETS)
  )
}

// ── home ────────────────────────────────────────────────────────────────────
const LEAVES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2.8, 1.2, 64, 2.3],
  [2.8, 1.2, -64, 2.3],
  [-1.8, 2.6, 38, 2.9],
  [1.8, 2.6, -38, 2.9],
  [0, 3.4, 0, 3.4]
]
const plant: Vignette = (p, y) => {
  const leaf = (i: number) => {
    const [dy, dz, deg, len] = LEAVES[i]
    return on(PX(SX), turnedEll(y + dy, Z + 3.2 + dz, 0.95, len, deg))
  }
  return (
    p.rod([SX, y, Z], [SX, y, Z + 3.2], 1.5, POT, tone, 1.2, 1.9, FACETS) +
    p.fill(ring(SX, y, Z + 3.22, 1.6), '#5b4030') +
    flats(p, [0, 1, 4].map(leaf), PALS.mint.m, 0.8) +
    flats(p, [2, 3].map(leaf), PALS.mint.l, 0.8)
  )
}

const picture: Vignette = (p, y, m) =>
  flat(p, face(rectUV(y - 5, Z + 2.4, y + 5, Z + 10.4)), m.d, 1.1) +
  flat(p, face(rectUV(y - 4, Z + 3.4, y + 4, Z + 9.4)), '#cfe9f0', 0.6) +
  flat(p, face([[y + 4, Z + 3.4], [y + 4, Z + 5.6], [y + 1, Z + 7], [y - 2, Z + 5.2], [y - 4, Z + 6], [y - 4, Z + 3.4]]), PALS.mint.l, 0) +
  flat(p, face([[y + 2.6, Z + 6.3], [y + 0.6, Z + 6.3], [y + 0.6, Z + 7.6], [y + 1.6, Z + 8.5], [y + 2.6, Z + 7.6]]), PAPER, 0.6) +
  dot(p, [y - 2.2, Z + 8.1], 0.9, PALS.mustard.l)

// ── media ───────────────────────────────────────────────────────────────────
const vinyl: Vignette = (p, y, m) =>
  flat(p, face(ellUV(y + 2.6, Z + 6.2, 3.8, 3.8, 16)), DARK.m, 1.1) +
  lines(p, [[...face(ellUV(y + 2.6, Z + 6.2, 2.6, 2.6, 12)), face([[y + 5.2, Z + 6.2]])[0]]], 0.5, DARK.l) +
  dot(p, [y + 2.6, Z + 6.2], 1.2, PALS.tomato.l) +
  flat(p, face(rectUV(y - 6.6, Z + 2.2, y + 1.4, Z + 10.2)), m.l, 1.1) +
  flat(p, face([[y + 1.4, Z + 2.2], [y + 1.4, Z + 4.6], [y - 4.2, Z + 10.2], [y - 6.6, Z + 10.2]]), m.m, 0)

const camera: Vignette = (p, y) => {
  const b = [STRIP.x0, y - 3, Z, STRIP.x1, y + 3, Z + 3.6] as const
  return (
    solid(p, [STRIP.x0 + 0.4, y + 0.4, Z + 3.6, STRIP.x1 - 0.6, y + 2.4, Z + 4.6], DARK, 0.8) +
    solid(p, b, DARK, 1) +
    p.hullInk(p.boxPts(...b), 1.6) +
    p.rod([STRIP.x1, y - 0.6, Z + 1.8], [STRIP.x1 + 1.5, y - 0.6, Z + 1.8], 1.3, DARK, tone, 1, 1.3, FACETS) +
    p.stud([STRIP.x1 + 1.52, y - 0.6, Z + 1.8], 0.8, CLEAR.d, 0.5) +
    p.stud([X1, y + 2, Z + 2.8], 0.4, PALS.tomato.l, 0.4)
  )
}

// ── security ────────────────────────────────────────────────────────────────
const safe: Vignette = (p, y) => {
  const x1 = STRIP.x1 + 0.4
  const b = [STRIP.x0 - 0.1, y - 3.6, Z, x1, y + 3.6, Z + 6.6] as const
  return (
    solid(p, b, STEEL, 1) +
    lines(p, [[...on(PX(x1 + 0.02), rectUV(y - 3, Z + 0.6, y + 3, Z + 6)), [x1 + 0.02, y - 3, Z + 0.6]]], 0.9) +
    p.stud([x1 + 0.04, y + 0.8, Z + 3.4], 1.2, METAL.l, 0.9) +
    lines(p, [[[x1 + 0.06, y + 0.8, Z + 3.4], [x1 + 0.06, y + 0.8, Z + 4.4]]], 0.7) +
    stick(p, [[x1, y - 1.8, Z + 3.4], [x1 + 0.8, y - 1.8, Z + 3.4]], 0.35, DARK, 1) +
    p.hullInk(p.boxPts(...b), 1.8)
  )
}

const padlock: Vignette = (p, y) => {
  const shackle = p.d3(face(arcUV(y, Z + 7, 2, 0, 180, 8)), false)
  return (
    `<path d="${shackle}" stroke="${INK}" stroke-width="${num(1.5 * p.spec.s)}"/>` +
    `<path d="${shackle}" stroke="${METAL.m}" stroke-width="${num(0.8 * p.spec.s)}"/>` +
    p.shape(face(rrUV(y - 3, Z + 2, y + 3, Z + 7.2, 0.8, 2)), PALS.mustard.l, 1.4) +
    flat(p, [...face(ellUV(y, Z + 5, 0.6, 0.6, 8)), ...face(rectUV(y + 0.25, Z + 3.4, y - 0.25, Z + 4.6))], DARK.m, 0)
  )
}

// ── ops ─────────────────────────────────────────────────────────────────────
const clock: Vignette = (p, y, m) => {
  const c = Z + 6.4
  const ticks = ([[0, 3], [3, 0], [0, -3], [-3, 0]] as const).map(([dy, dz]) => face([[y + dy * 0.85, c + dz * 0.85], [y + dy, c + dz]]))
  return (
    p.shape(face(ellUV(y, c, 4.4, 4.4, 18)), m.m, 1.4) +
    flat(p, face(ellUV(y, c, 3.6, 3.6, 18)), CERAMIC.l, 0.6) +
    lines(p, ticks, 0.8) +
    lines(p, [face([[y, c + 2.6], [y, c], [y - 1.9, c - 0.8]])], 1.1)
  )
}

const lockers: Vignette = (p, y, m) => {
  const b = [STRIP.x0, y - 5, Z, STRIP.x1, y + 5, Z + 9] as const
  const doors = [-5 + 10 / 6, 0, 5 - 10 / 6].map((dy) => y + dy)
  const vents = doors.flatMap((yy) => [7.4, 6.8, 6.2].map((dz) => [[X1, yy + 1, Z + dz], [X1, yy - 1, Z + dz]] as V3[]))
  const seams = [-5 + 10 / 3, 5 - 10 / 3].map((dy) => [[X1, y + dy, Z + 0.3], [X1, y + dy, Z + 8.7]] as V3[])
  return solid(p, b, m, 1) + lines(p, seams, 0.8) + lines(p, vents, 0.5) + doors.map((yy, i) => p.stud([X1, yy - 1, Z + 4.2], 0.35, i === 1 ? PALS.mustard.l : METAL.l, 0.4)).join('') + p.hullInk(p.boxPts(...b), 1.8)
}

// ── data ────────────────────────────────────────────────────────────────────
const pipes: Vignette = (p, y) => {
  const x = PANEL + 1.2
  const hz = Z + 8.6
  const wx = x + 1.1
  return (
    flat(p, face(ellUV(y - 1.6, Z + 4.2, 1.9, 1.9, 14)), CERAMIC.l, 1.1) +
    lines(p, [face([[y - 1.6, Z + 4.2], [y - 2.6, Z + 5.2]])], 0.8, PALS.tomato.d) +
    stick(p, [[x, y - 1.6, Z + 6.1], [x, y - 1.6, hz]], 0.35, STEEL, 1) +
    pipe(p, [[x, y - 5, Z + 0.4], [x, y - 5, hz], [x, y + 7, hz]], 0.9, STEEL) +
    lines(p, [[...on(PX(wx), ellUV(y + 2.4, hz, 1.8, 1.8, 12)), [wx, y + 4.2, hz]]], 1.6, PALS.tomato.m) +
    lines(p, [on(PX(wx), [[y + 0.6, hz], [y + 4.2, hz]]), on(PX(wx), [[y + 2.4, hz - 1.8], [y + 2.4, hz + 1.8]])], 0.8, PALS.tomato.d)
  )
}

const database: Vignette = (p, y, m) => {
  const x = SX + 0.4
  return (
    p.cyl(x, y, Z, Z + 6, 2.4, STEEL, tone, 1.3, 12) +
    p.loft(ring(x, y, Z + 2, 2.4), ring(x, y, Z + 4, 2.4), (n) => tone(n, m)) +
    lines(p, [frontArc(x, y, Z + 2, 2.4), frontArc(x, y, Z + 4, 2.4)], 0.9) +
    [1, 3, 5].map((dz) => p.stud([x + 1.7, y - 1.7, Z + dz], 0.3, PALS.mint.l, 0.4)).join('')
  )
}

// ── play ────────────────────────────────────────────────────────────────────
const blocks: Vignette = (p, y) =>
  solid(p, [STRIP.x0, y - 4.4, Z, STRIP.x1, y - 1.8, Z + 2.6], PALS.cobalt, 1) +
  p.tx(X1, y - 3.1, Z + 0.6, 'A', 1.8, PAPER, 800) +
  solid(p, [STRIP.x0, y - 1.4, Z, STRIP.x1, y + 1.2, Z + 2.6], PALS.tomato, 1) +
  p.tx(X1, y - 0.1, Z + 0.6, 'B', 1.8, PAPER, 800) +
  solid(p, [STRIP.x0 + 0.2, y - 3, Z + 2.6, STRIP.x1 - 0.2, y - 0.6, Z + 4.8], PALS.mustard, 1) +
  p.tx(STRIP.x1 - 0.17, y - 1.8, Z + 3.1, 'C', 1.6, INK, 800) +
  p.sphere([SX, y + 4.2, Z + 1.9], 1.9, PALS.blush, { w: 1.2 })

const bucket: Vignette = (p, y) =>
  stick(p, [[SX + 0.6, y - 3.6, Z], [SX - 0.6, y - 4.8, Z + 7]], 0.35, WOOD, 1) +
  flat(p, on(PX(SX + 0.8), rrUV(y - 4.6, Z, y - 2.6, Z + 2.6, 0.6, 2)), METAL.m, 0.8) +
  p.rod([SX, y + 1.8, Z], [SX, y + 1.8, Z + 3.4], 1.6, PALS.mint, tone, 1.2, 2.1, FACETS) +
  p.fill(ring(SX, y + 1.8, Z + 3.1, 1.8), SAND) +
  lines(p, [on(PX(SX), arcUV(y + 1.8, Z + 3.4, 2.1, 0, 180, 8))], 0.9)

// ── design ──────────────────────────────────────────────────────────────────
const SWATCH = [PALS.tomato, PALS.mustard, PALS.mint, PALS.cobalt]
const swatches: Vignette = (p, y) => {
  const pivot = [y, Z + 2.6] as const
  return (
    SWATCH.map((c, i) => {
      const deg = 30 - i * 20
      const at = turn(pivot[0], pivot[1], deg)
      const [cu, cv] = at([0, 4])
      const [lu, lv] = at([0, 6.6])
      return flat(p, face(turnedRect(cu, cv, 2.6, 8, deg)), c.l) + flat(p, face(turnedRect(lu, lv, 2.2, 1.6, deg)), PAPER, 0)
    }).join('') + dot(p, pivot, 0.5, METAL.l)
  )
}

const PENCILS: ReadonlyArray<readonly [number, number, Mat]> = [
  [-0.6, -1.6, PALS.cobalt],
  [0.3, 0.2, PALS.tomato],
  [0.7, 1.8, PALS.mustard]
]
const pencils: Vignette = (p, y, m) =>
  p.cyl(SX, y, Z, Z + 3.2, 1.4, m, tone, 1.2, FACETS) +
  PENCILS.map(([dy, lean, c]) => {
    const b: V3 = [SX - 0.4, y + dy + lean, Z + 7.2]
    return stick(p, [[b[0] - 0.1, b[1] + lean * 0.2, b[2] + 1], b], 0.22, WOOD, 1) + stick(p, [[SX, y + dy, Z + 3.2], b], 0.32, c, 1.1)
  }).join('')

// ── ai ──────────────────────────────────────────────────────────────────────
const flasks: Vignette = (p, y, m) => {
  const fy = y - 2.6
  const glass = (n: V3) => tone(n, CLEAR)
  const tubes = [3.2, 4.6, 6]
    .map((dy, i) => {
      const at = y + dy
      return stick(p, [[SX, at, Z + 4.8], [SX, at, Z + 2.6]], 0.4, CLEAR, 1) + stick(p, [[SX, at, Z + 2.6], [SX, at, Z + 0.8]], 0.4, [PALS.mint, m, PALS.mustard][i], 1)
    })
    .join('')
  return (
    p.loft(ring(SX, fy, Z, 2.1), ring(SX, fy, Z + 1.8, 1.55), (n) => tone(n, PALS.mint)) +
    p.loft(ring(SX, fy, Z + 1.8, 1.55), ring(SX, fy, Z + 4, 0.65), glass) +
    stick(p, [[SX, fy, Z + 4], [SX, fy, Z + 5.6]], 0.65, CLEAR, 1) +
    p.hullInk([...ring(SX, fy, Z, 2.1), ...ring(SX, fy, Z + 4, 0.65)], 1.4) +
    tubes +
    solid(p, [STRIP.x0, y + 2.4, Z, STRIP.x1, y + 6.8, Z + 1.4], WOOD, 0.9)
  )
}

const chip: Vignette = (p, y) => {
  const pins = [3.8, 5.6, 7.4, 9.2].flatMap((dz) => [face([[y + 4, Z + dz], [y + 5.2, Z + dz]]), face([[y - 4, Z + dz], [y - 5.2, Z + dz]])])
  return (
    lines(p, pins, 0.9) +
    flat(p, face(rrUV(y - 4, Z + 2.6, y + 4, Z + 10.4, 0.8, 2)), DARK.m, 1.2) +
    flat(p, face(rectUV(y - 2.4, Z + 4.2, y + 2.4, Z + 8.8)), SCREEN, 0) +
    p.tx(FX + 0.06, y, Z + 5.6, 'AI', 2.6, SCREEN_TEXT, 800)
  )
}

// ── team ────────────────────────────────────────────────────────────────────
const FLAGS = [null, PALS.mustard, PALS.cobalt, PALS.tomato, PALS.mint]
const pennants: Vignette = (p, y, m) => {
  const top = Z + HUTCH - 1.4
  const at = (t: number): UV => [y + 7 - 14 * t, top - 6.4 * t * (1 - t)]
  return (
    lines(p, [face(Array.from({ length: 9 }, (_, i) => at(i / 8)))], 0.9) +
    FLAGS.map((c, i) => {
      const [fu, fv] = at(0.1 + i * 0.2)
      return flat(p, face([[fu + 1.2, fv], [fu - 1.2, fv], [fu, fv - 3]]), (c ?? m).l, 0.8)
    }).join('')
  )
}

const trophy: Vignette = (p, y) => {
  const gold = PALS.mustard
  return (
    solid(p, [STRIP.x0 + 0.2, y - 1.8, Z, STRIP.x1 - 0.2, y + 1.8, Z + 1.4], DARK, 1) +
    stick(p, [[SX, y, Z + 1.4], [SX, y, Z + 3.4]], 0.4, gold, 1) +
    lines(p, [on(PX(SX), arcUV(y + 1.9, Z + 5.4, 0.9, -90, 90, 6)), on(PX(SX), arcUV(y - 1.9, Z + 5.4, 0.9, 90, 270, 6))], 1) +
    p.rod([SX, y, Z + 3.4], [SX, y, Z + 6.8], 0.6, gold, tone, 1.2, 2.2, FACETS) +
    p.fill(ring(SX, y, Z + 6.82, 1.9), gold.d)
  )
}

/** Each theme's vignettes, the strongest first: a module shows two. */
export const VIGNETTES = {
  code: [pegboard, toolbox],
  docs: [books, pinned, lamp],
  home: [plant, picture],
  media: [vinyl, camera],
  security: [safe, padlock],
  ops: [clock, lockers],
  data: [pipes, database],
  play: [blocks, bucket],
  design: [swatches, pencils, lamp],
  ai: [flasks, chip],
  team: [pennants, trophy]
} satisfies Record<Theme, readonly Vignette[]>
