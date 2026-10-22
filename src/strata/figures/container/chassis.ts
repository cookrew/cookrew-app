// THE STANDARD TABLE: every workspace is this one piece of furniture, one to
// four 12-seat modules long, at one scale. Legs at each end and at every
// joint, a top, a front apron with the name plaque, a back panel painted in
// the workspace's colour, and the theme's materials and props on it. Agents
// stand on the top; empty places show as mats, so a table reads its size.
import type { V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { DARK, INK, matOf, METAL, tone, WOOD, type Mat } from '../iso/tone'
import { plaque, seatY, tray, type Ctx, type Plan } from './common'
import { APRON, BACK, CAP, DEPTH, HUTCH, MODULE_W, moduleY, PANEL, PITCH_X, PITCH_Y, SIDE, SLAB, tableWidth, TOP } from './desk'
import { boxFaces, solid } from './ink'
import { MODULE, SEAT_R, type Seat } from './layout'
import { VIGNETTES, type Vignette } from './props'
import type { Theme } from './themes'

export interface DeskPlan extends Plan {
  modules: number
  D: number
  W: number
  /** The places nobody sits at: each gets a mat, so the table reads its size. */
  places: V3[]
}

const corners = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): V3[] =>
  [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [z0, z1].map((z) => [x, y, z] as V3)))

export const deskPlan = (modules: number, seats: readonly Seat[]): DeskPlan => {
  const D = DEPTH
  const W = tableWidth(modules)
  const cols = MODULE.cols * modules
  const at = (row: number, col: number, z: number): V3 => [BACK + (row + 0.5) * PITCH_X, seatY(SIDE, cols, PITCH_Y, col), z]
  const tr = { x0: D - 12, x1: D, y0: -15, y1: -3 }
  return {
    modules,
    D,
    W,
    seats: seats.map((s) => at(s.row, s.col, TOP + SEAT_R)),
    places: Array.from({ length: MODULE.rows * cols }, (_, i) => ({ row: Math.floor(i / cols), col: i % cols }))
      .filter((q) => !seats.some((s) => s.row === q.row && s.col === q.col))
      .map((q) => at(q.row, q.col, TOP)),
    plaque: { x: D + 0.02, y: W / 2, w: Math.min(W - 10, 44), z0: APRON.z0 + 0.4, z1: APRON.z1 - 0.4 },
    tray: tr,
    fit: [...corners(0, 0, 0, D, W, TOP), ...corners(0, 0, TOP, PANEL + CAP, W, TOP + HUTCH + CAP), ...corners(tr.x0, tr.y0, 0, tr.x1, tr.y1, 0)]
  }
}

// ── materials ───────────────────────────────────────────────────────────────
const WALNUT: Mat = { l: '#b98256', m: '#97633d', d: '#5f3b22' }
const OAK: Mat = { l: '#ead2a6', m: '#cfae7c', d: '#9a7a4c' }
const PINE: Mat = { l: '#e3bd84', m: '#c99e60', d: '#93703e' }
const STEEL: Mat = { l: '#d5dadc', m: '#a9b1b5', d: '#737c80' }
const BIRCH: Mat = { l: '#f3e6c9', m: '#dccaa2', d: '#ab9670' }
const LAB: Mat = { l: '#fbfaf3', m: '#e3e0d2', d: '#bdb8a6' }
const SOOT = matOf('#4a4642')

/** A theme's table: the top and apron's material, and the legs'. `paint` = the workspace's own colour. */
export const LOOKS: Record<Theme, { top: Mat; legs: Mat | 'paint' }> = {
  code: { top: WOOD, legs: WOOD },
  docs: { top: WALNUT, legs: WALNUT },
  home: { top: OAK, legs: 'paint' },
  media: { top: PINE, legs: SOOT },
  security: { top: STEEL, legs: DARK },
  ops: { top: STEEL, legs: 'paint' },
  data: { top: STEEL, legs: METAL },
  play: { top: BIRCH, legs: 'paint' },
  design: { top: BIRCH, legs: METAL },
  ai: { top: LAB, legs: METAL },
  team: { top: WOOD, legs: 'paint' }
}

/**
 * Two props per module: even places take the first theme's (rotated by the
 * name, so two tables of one theme differ), odd places the second theme's
 * when there is one.
 */
export const propsFor = (themes: readonly Theme[], modules: number, seed: number): Vignette[] => {
  const first: readonly Vignette[] = VIGNETTES[themes[0]]
  const second: readonly Vignette[] = themes[1] ? VIGNETTES[themes[1]] : []
  return Array.from({ length: 2 * modules }, (_, i) => {
    const k = Math.floor(i / 2)
    if (i % 2 === 1 && second.length) return second[k % second.length]
    return first[(seed + i) % first.length]
  })
}

// ── drawing ─────────────────────────────────────────────────────────────────
/** A mat on the top, as one path of iso ellipses (a circle on z = const is an axis-aligned ellipse on screen). */
const mats = (p: Pen, places: readonly V3[], r: number, colour: string): string => {
  const rx = r * 1.2247 * p.spec.s
  const ry = r * 0.7071 * p.spec.s
  const d = places
    .map((c) => {
      const [cx, cy] = p.P(c)
      return `M${num(cx - rx)} ${num(cy)}a${num(rx)} ${num(ry)} 0 1 0 ${num(2 * rx)} 0a${num(rx)} ${num(ry)} 0 1 0 ${num(-2 * rx)} 0`
    })
    .join('')
  return `<path d="${d}" fill="${colour}"/>`
}

/**
 * Every leg in three elements: their two visible sides by tone, then their
 * ink (the tops hide under the table). Back legs first: painter's order.
 */
const legsOf = (p: Pen, xs: readonly number[], ys: readonly number[], h: number, m: Mat): string => {
  const legs = xs.flatMap((x) => ys.map((y) => boxFaces(x, y, 0, x + 2, y + 2, h)))
  const side = (i: number) => legs.map((faces) => p.d3(faces[i][1])).join('')
  return (
    `<path d="${side(0)}" fill="${tone([0, 1, 0], m)}"/>` +
    `<path d="${side(1)}" fill="${tone([1, 0, 0], m)}"/>` +
    `<path d="${side(0)}${side(1)}" stroke="${INK}" stroke-width="${num(1.1 * p.spec.k)}"/>`
  )
}

export const drawDesk = (p: Pen, pl: DeskPlan, ctx: Ctx, themes: readonly Theme[], seed: number): string => {
  const { D, W, modules } = pl
  const look = LOOKS[themes[0]]
  const legs = look.legs === 'paint' ? ctx.m : look.legs
  const under = TOP - SLAB
  const legYs = [0.6, ...Array.from({ length: modules - 1 }, (_, k) => moduleY(k + 1) - 1), W - 2.6]
  const topPts = corners(0, 0, under, D, W, TOP)
  const panelPts = corners(0, 0, TOP, PANEL, W, TOP + HUTCH)
  const capPts = corners(0, 0, TOP + HUTCH, PANEL + CAP, W, TOP + HUTCH + CAP)
  const seams = legYs
    .slice(1, -1)
    .map((y) => p.line([[0.2, y + 1, TOP], [D, y + 1, TOP], [D, y + 1, under + 0.3]], 0.8))
    .join('')
  const props = propsFor(themes, modules, seed)
    .map((draw, i) => draw(p, moduleY(Math.floor(i / 2)) + MODULE_W * (i % 2 === 0 ? 0.25 : 0.75), ctx.m))
    .join('')
  return (
    p.castShadow([...corners(0, 0, 0, D, W, 0), ...topPts, ...panelPts], 0) +
    legsOf(p, [1, D - 3.6], legYs, under, legs) +
    solid(p, [D - 3.2, 2.6, 2, D - 2.2, W - 2.6, 3], legs, 0.8) +
    solid(p, [D - 1.2, 1.6, APRON.z0, D, W - 1.6, under], look.top, 1) +
    solid(p, [0, 0, under, D, W, TOP], look.top, 1.1) +
    seams +
    mats(p, pl.places, 3, look.top.m) +
    p.hullInk(topPts, 2.4) +
    solid(p, [0, 0, TOP, PANEL, W, TOP + HUTCH], ctx.m, 1) +
    solid(p, [0, 0, TOP + HUTCH, PANEL + CAP, W, TOP + HUTCH + CAP], look.top, 0.9) +
    p.hullInk([...panelPts, ...capPts], 2.2) +
    props +
    tray(p, pl.tray) +
    plaque(p, pl.plaque, ctx)
  )
}
