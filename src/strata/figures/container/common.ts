// Parts every container shares: the name plaque, the tray for loose notes and
// browsers, shelf openings seen into (by geometry, no clipPath), and the "+K"
// token on the last seat when a workspace has more agents than seats.
import type { Rect } from '../../../shared/strata'
import { clipConvex, hull, on, PX, PZ, rectUV, rrUV, type V2, type V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { CERAMIC, INK, mix, PAPER, tone, type Mat } from '../iso/tone'
import { SEAT_R, type Seat, type Tier } from './layout'
import { plaqueText } from './name'

export interface Ctx {
  name: string
  m: Mat
  /** "+K" on the last seat; 0 = none. */
  overflow: number
}

/** A plaque on the front plane x, centred at y, between z0 and z1. */
export interface Plaque {
  x: number
  y: number
  w: number
  z0: number
  z1: number
}

/** A tray on the ground for loose notes and browsers. */
export interface Tray {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** What an archetype lays out before it draws: framing and anchors come from this. */
export interface Plan {
  fit: V3[]
  seats: V3[]
  plaque: Plaque
  tray: Tray
}

export interface ArchetypeDef<P extends Plan = Plan> {
  plan(tier: Tier, seats: Seat[]): P
  draw(p: Pen, plan: P, ctx: Ctx): string
}

export const TRAY_H = 1.6

/** The plaque with the workspace's name, in iso on its front plane. */
export const plaque = (p: Pen, q: Plaque, ctx: Ctx): string => {
  const h = q.z1 - q.z0
  const size = Math.min(2.6, h * 0.62)
  const face = on(PX(q.x), rrUV(q.y - q.w / 2, q.z0, q.y + q.w / 2, q.z1, Math.min(1, h * 0.25), 2))
  const text = plaqueText(ctx.name, Math.max(3, Math.floor(q.w / (size * 0.64))))
  return p.shape(face, mix(ctx.m.l, PAPER, 0.72), 0.9) + p.tx(q.x + 0.02, q.y, q.z0 + h / 2 - size * 0.36, text, size, INK, 800)
}

export const plaqueCorners = (q: Plaque): V3[] => on(PX(q.x), rectUV(q.y - q.w / 2, q.z0, q.y + q.w / 2, q.z1))

/** A shallow paper tray on the ground. */
export const tray = (p: Pen, t: Tray): string => {
  const pts = p.boxPts(t.x0, t.y0, 0, t.x1, t.y1, TRAY_H)
  const inner = on(PZ(TRAY_H + 0.02), rectUV(t.x0 + 1, t.y0 + 1, t.x1 - 1, t.y1 - 1))
  return p.castShadow(pts, 0) + p.box(t.x0, t.y0, 0, t.x1, t.y1, TRAY_H, CERAMIC, tone, 0) + p.shape(inner, CERAMIC.m, 0.7) + p.hullInk(pts, 1.4)
}

/** The tray's anchor: its footprint plus room above for a fan of cards. */
export const trayRect = (p: Pen, t: Tray): Rect => p.rectOf([...on(PZ(0), rectUV(t.x0, t.y0, t.x1, t.y1)), [t.x0, t.y1, TRAY_H + 9]])

/**
 * Openings on a front plane seen into: the dark sides and floor, the lit back
 * wall (the opening shifted back by `depth`, clipped to the opening), then ink.
 * All openings share three paths, so 48 cubbies cost three elements.
 */
export const openings = (p: Pen, faces: ReadonlyArray<readonly V3[]>, depth: number, wall: string, back: string, w = 1.2): string => {
  const back2 = p.Dv([-depth, 0, 0])
  const fronts = faces.map((f) => f.map(p.P))
  const backs = fronts.map((f) => clipConvex(f.map(([x, y]) => [x + back2[0], y + back2[1]] as V2), f))
  const d = (polys: ReadonlyArray<readonly V2[]>) => polys.map((poly) => p.d2(poly)).join('')
  if (fronts.length === 0) return ''
  return (
    `<path d="${d(fronts)}" fill="${wall}"/>` +
    `<path d="${d(backs.filter((b) => b.length > 2))}" fill="${back}"/>` +
    `<path d="${d(fronts)}" stroke="${INK}" stroke-width="${num(w * p.spec.k)}"/>`
  )
}

/** The "+K" token on the last seat: everyone past capacity, in one ball. */
export const overflowToken = (p: Pen, at: V3, k: number): string => {
  if (k <= 0) return ''
  const [cx, cy] = p.P(at)
  const R = SEAT_R * 1.2247 * p.spec.s
  const label = `+${k > 999 ? '999' : k}`
  const size = R * (label.length > 3 ? 0.62 : 0.78)
  return (
    p.sphere(at, SEAT_R, CERAMIC, { w: 1.4 }) +
    `<text x="${num(cx)}" y="${num(cy + size * 0.36)}" font-size="${num(size)}" text-anchor="middle" font-weight="800" fill="${INK}">${label}</text>`
  )
}

/** Seat i's position on a row of `cols` columns starting at y0 (left on screen = high y). */
export const seatY = (y0: number, cols: number, pitch: number, col: number): number => y0 + (cols - col - 0.5) * pitch

/**
 * An axis-aligned box seen through an opening: each visible face clipped to
 * the opening's screen polygon (convex), then filled and inked.
 */
export const boxIn = (p: Pen, b: readonly [number, number, number, number, number, number], m: Mat, clip: readonly V2[], w = 0.7): string => {
  const [x0, y0, z0, x1, y1, z1] = b
  const faces: Array<[V3, V3[]]> = [
    [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]]
  ]
  const polys = faces.map(([n, q]) => [n, clipConvex(q.map(p.P), clip)] as const).filter(([, poly]) => poly.length > 2)
  if (polys.length === 0) return ''
  return polys.map(([n, poly]) => p.fill2(poly, tone(n, m))).join('') + p.ink2(hull(polys.flatMap(([, poly]) => poly)), w)
}
