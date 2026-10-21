// The surface family: seats stand on top of something, rows running back to
// front. Workbench, sandbox tray, bleachers, record crate and pipe rack.
// Back rows are drawn first, so creation order is also painter's order.
import { clipConvex, ellUV, on, PX, PY, PZ, rectUV, rrUV, type V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { DARK, INK, matOf, METAL, mix, PALS, PAPER, tone, toneI, WOOD } from '../iso/tone'
import { plaque, seatY, tray, type ArchetypeDef, type Ctx, type Plan } from './common'
import { SEAT_R, type Seat, type Tier } from './layout'

const PY_ = 8.4
const PX_ = 10

interface SurfOpts {
  /** x room behind the first row and in front of the last. */
  back: number
  front: number
  side: number
  /** y room at the right end (low y) for props. */
  extra: number
  /** Height of the surface a row stands on. */
  zRow: (row: number, rows: number) => number
  plaque: (D: number, W: number) => { z0: number; z1: number }
  /** Height above the surface (props, boards), for framing. */
  over: number
}

export interface SurfPlan extends Plan {
  o: SurfOpts
  tier: Tier
  W: number
  D: number
}

const corners = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): V3[] =>
  [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [z0, z1].map((z) => [x, y, z] as V3)))

const surfPlan = (tier: Tier, seats: Seat[], o: SurfOpts): SurfPlan => {
  const W = 2 * o.side + o.extra + tier.cols * PY_
  const D = o.back + tier.rows * PX_ + o.front
  const top = Math.max(...Array.from({ length: tier.rows }, (_, r) => o.zRow(r, tier.rows)))
  const pq = o.plaque(D, W)
  const tr = { x0: D - 12, x1: D, y0: -15, y1: -3 }
  return {
    o,
    tier,
    W,
    D,
    seats: seats.map((s) => [o.back + (s.row + 0.5) * PX_, seatY(o.side + o.extra, tier.cols, PY_, s.col), o.zRow(s.row, tier.rows) + SEAT_R] as V3),
    plaque: { x: D + 0.02, y: W / 2, w: Math.min(W - 8, 44), ...pq },
    tray: tr,
    fit: [...corners(0, 0, 0, D, W, top + o.over), ...corners(tr.x0, tr.y0, 0, tr.x1, tr.y1, 0)]
  }
}

const ends = (p: Pen, pl: SurfPlan, ctx: Ctx) => tray(p, pl.tray) + plaque(p, pl.plaque, ctx)

// ── workbench with a pegboard ───────────────────────────────────────────────
const BENCH_Z = 13
const BENCH: SurfOpts = {
  back: 3,
  front: 2,
  side: 2.4,
  extra: 0,
  zRow: () => BENCH_Z,
  plaque: () => ({ z0: 6.6, z1: 9.6 }),
  over: 16
}

export const workbench: ArchetypeDef<SurfPlan> = {
  plan: (tier, seats) => surfPlan(tier, seats, BENCH),
  draw(p, pl, ctx) {
    const { D, W } = pl
    const wood = WOOD
    const leg = (x: number, y: number) => p.box(x, y, 0, x + 2, y + 2, BENCH_Z - 3, wood, tone, 0.9)
    const topPts = corners(0, 0, BENCH_Z - 3, D, W, BENCH_Z)
    const board = corners(0, 0, BENCH_Z, 1.4, W, BENCH_Z + 16)
    const pegs = [3, 6.5, 10, 13.5]
      .map((dz) => p.d3([[1.42, W - 2, BENCH_Z + dz], [1.42, 2, BENCH_Z + dz]], false))
      .join('')
    const hy = W - 6
    const hammer =
      p.shape(on(PX(1.6), rectUV(hy - 0.5, BENCH_Z + 3, hy + 0.5, BENCH_Z + 11)), WOOD.m, 0.8) +
      p.shape(on(PX(1.7), rectUV(hy - 2.4, BENCH_Z + 10.2, hy + 2.4, BENCH_Z + 12.4)), DARK.l, 0.9)
    const ruler = p.shape(on(PX(1.6), rectUV(hy - 9, BENCH_Z + 4, hy - 7.6, BENCH_Z + 13)), PALS.mustard.l, 0.8)
    return (
      p.castShadow([...topPts, ...corners(0, 0, 0, D, W, 0), ...board], 0) +
      leg(1, 1) +
      leg(1, W - 3) +
      leg(D - 3.5, 1) +
      leg(D - 3.5, W - 3) +
      p.box(D - 1, 2.5, 6, D, W - 2.5, BENCH_Z - 3, wood, tone, 0.9) +
      p.box(0, 0, BENCH_Z - 3, D, W, BENCH_Z, wood, tone, 1.2) +
      p.hullInk(topPts, 2.4) +
      p.box(0, 0, BENCH_Z, 1.4, W, BENCH_Z + 16, ctx.m, tone, 1) +
      `<path d="${pegs}" stroke="${ctx.m.d}" stroke-width="${num(1.1 * p.spec.k)}" stroke-dasharray="0 ${num(3.4 * p.spec.s)}"/>` +
      hammer +
      ruler +
      p.hullInk(board, 2.2) +
      ends(p, pl, ctx)
    )
  }
}

// ── sandbox tray ────────────────────────────────────────────────────────────
const SAND = { l: '#f1d9a0', m: '#dcbf80', d: '#b39557' }
const SB: SurfOpts = {
  back: 2.6,
  front: 2.6,
  side: 2.6,
  extra: 6,
  zRow: () => 3.2,
  plaque: () => ({ z0: 0.6, z1: 3.9 }),
  over: 10
}

export const sandbox: ArchetypeDef<SurfPlan> = {
  plan: (tier, seats) => surfPlan(tier, seats, SB),
  draw(p, pl, ctx) {
    const { D, W } = pl
    const m = ctx.m
    const h = 4.4
    const pts = p.slabPts(0, 0, D, W, 0, h, 2.4)
    const opening = on(PZ(h), rrUV(2.4, 2.4, D - 2.4, W - 2.4, 1.2, 2))
    const sand = on(PZ(3.2), rrUV(2.4, 2.4, D - 2.4, W - 2.4, 1.2, 2))
    const win = opening.map(p.P)
    // a spade stuck in the sand by the right edge
    const sx = D * 0.6
    const sy = 1.2
    const spade =
      p.rod([sx, sy + 3.6, 3.2], [sx - 2, sy + 4, 13], 0.45, WOOD, toneI, 0.9) +
      p.shape(on(PX(sx + 0.3), rrUV(sy + 2.4, 0.2, sy + 4.8, 4, 1, 2)), METAL.m, 0.9)
    return (
      p.castShadow(pts, 0) +
      p.slab(0, 0, D, W, 0, h, 2.4, m, tone, 2.6) +
      p.fill(opening, m.d) +
      p.fill2(clipConvex(sand.map(p.P), win), SAND.l) +
      p.ink(opening, 1.1) +
      spade +
      ends(p, pl, ctx)
    )
  }
}

// ── bleachers ───────────────────────────────────────────────────────────────
const STEP = 4.4
const BL: SurfOpts = {
  back: 0,
  front: 0,
  side: 1.6,
  extra: 0,
  zRow: (r, rows) => 4.2 + (rows - 1 - r) * STEP,
  plaque: () => ({ z0: 0.6, z1: 3.6 }),
  over: 14
}

export const bleachers: ArchetypeDef<SurfPlan> = {
  plan: (tier, seats) => {
    const pl = surfPlan(tier, seats, BL)
    // seats sit toward the front edge of each step
    return { ...pl, seats: pl.seats.map(([x, y, z]) => [x + PX_ / 2 - SEAT_R - 1.4, y, z] as V3) }
  },
  draw(p, pl, ctx) {
    const { W, tier } = pl
    const m = ctx.m
    const cream = { l: mix(PAPER, m.l, 0.15), m: mix(PAPER, m.m, 0.3), d: mix(PAPER, m.d, 0.55) }
    const steps = Array.from({ length: tier.rows }, (_, r) => {
      const z = BL.zRow(r, tier.rows)
      const x0 = r * PX_
      const riser = r % 2 === 0 ? m : cream
      return (
        p.box(x0, 0, 0, x0 + PX_, W, z, riser, tone, 1) +
        p.shape(on(PZ(z + 0.02), rectUV(x0, 0, x0 + PX_, W)), WOOD.l, 1) +
        p.hullInk(corners(x0, 0, 0, x0 + PX_, W, z), 2.4)
      )
    }).join('')
    const all = corners(0, 0, 0, pl.D, W, BL.zRow(0, tier.rows))
    const z0 = BL.zRow(0, tier.rows)
    const pole = p.rod([1.2, W - 1.2, z0], [1.2, W - 1.2, z0 + 13], 0.4, METAL, toneI, 0.9)
    const flag = p.shape(on(PY(W - 1.2), [[1.2, z0 + 12.6], [1.2, z0 + 8.4], [8.4, z0 + 10.5]]), m.l, 1)
    return p.castShadow(all, 0) + steps + pole + flag + ends(p, pl, ctx)
  }
}

// ── record crate ────────────────────────────────────────────────────────────
const CRATE_H = 7
const BED = 4.4
const CR: SurfOpts = {
  back: 2,
  front: 1.6,
  side: 1.6,
  extra: 10,
  zRow: () => BED,
  plaque: () => ({ z0: 1.2, z1: 5.6 }),
  over: 6
}

export const crate: ArchetypeDef<SurfPlan> = {
  plan: (tier, seats) => surfPlan(tier, seats, CR),
  draw(p, pl, ctx) {
    const { D, W } = pl
    const t = 1.2
    const wood = matOf('#cf9a5c')
    const pts = corners(0, 0, 0, D, W, CRATE_H)
    const backWall = on(PX(t), rectUV(t, BED, W - t, CRATE_H))
    const sideWall = on(PY(t), rectUV(t, BED, D - t, CRATE_H))
    const bed = on(PZ(BED), rectUV(t, t, D - t, W - t))
    const sleeves = [ctx.m, PALS.mustard, matOf('#2b2824'), PALS.cobalt, PALS.tomato]
    // records filed at the right end, front to back
    const records = sleeves
      .map((c, i) => {
        const x = t + 1.4 + i * 2.6
        return p.box(x, t + 0.6, BED, x + 0.7, t + 9, BED + 8.6 - (i % 2) * 0.8, c, tone, 0.7)
      })
      .join('')
    const rim = `<path d="${p.d3(on(PZ(CRATE_H), rectUV(0, 0, D, W)))}${p.d3(on(PZ(CRATE_H), rectUV(t, t, D - t, W - t)))}" fill="${wood.l}" fill-rule="evenodd" stroke="${INK}" stroke-width="${num(0.9 * p.spec.k)}"/>`
    const slats = [2.4, 4.8]
      .map((z) => p.d3([[D, 0.4, z], [D, W, z], [0.4, W, z]], false))
      .join('')
    return (
      p.castShadow(pts, 0) +
      p.fill(backWall, wood.m) +
      p.fill(sideWall, wood.d) +
      p.shape(bed, mix(ctx.m.l, PAPER, 0.45), 0.8) +
      records +
      p.shape(on(PX(D), rectUV(0, 0, W, CRATE_H)), tone([1, 0, 0], wood), 1) +
      p.shape(on(PY(W), rectUV(0, 0, D, CRATE_H)), tone([0, 1, 0], wood), 1) +
      `<path d="${slats}" stroke="${wood.d}" stroke-width="${num(1 * p.spec.k)}"/>` +
      rim +
      p.hullInk(pts, 2.6) +
      ends(p, pl, ctx)
    )
  }
}

// ── pipe rack ───────────────────────────────────────────────────────────────
const PIPE_R = 2.2
const PLATE_H = 3.5
const pipeZ = (r: number, rows: number) => PLATE_H + 4.4 + (rows - 1 - r) * 5.2
const PI: SurfOpts = {
  back: 2,
  front: 2,
  side: 2,
  extra: 0,
  zRow: (r, rows) => pipeZ(r, rows) + PIPE_R - 0.4,
  plaque: () => ({ z0: 0.5, z1: PLATE_H - 0.5 }),
  over: 2
}

export const pipes: ArchetypeDef<SurfPlan> = {
  plan: (tier, seats) => surfPlan(tier, seats, PI),
  draw(p, pl, ctx) {
    const { D, W, tier } = pl
    const m = ctx.m
    const steel = matOf('#9aa3a8')
    const platePts = p.slabPts(0, 0, D, W, 0, PLATE_H, 1.6)
    const xs = Array.from({ length: tier.rows }, (_, r) => PI.back + (r + 0.5) * PX_)
    // more than four pipes: six facets each keep the rack in budget
    const facets = tier.rows > 4 ? 6 : 8
    // a stepped stand at each end, its profile running under every pipe
    const profile = xs.flatMap((x, r) => {
      const top = pipeZ(r, tier.rows) - PIPE_R + 0.6
      return [[x - 1.6, top], [x + 1.6, top]] as Array<[number, number]>
    })
    const stand = (y: number) => {
      const face = on(PY(y), [[xs[0] - 1.6, PLATE_H], ...profile, [xs[xs.length - 1] + 1.6, PLATE_H]])
      return p.fill(face, tone([0, 1, 0], steel)) + p.ink(face, 1)
    }
    const rows = stand(5) + stand(W - 3.4) + xs.map((x, r) => {
      const z = pipeZ(r, tier.rows)
      return (
        p.rod([x, W - 1.6, z], [x, 1.6, z], PIPE_R, m, tone, 1.6, PIPE_R, facets) +
        (r === tier.rows - 1 ? p.rod([x, W / 2 + 0.6, z], [x, W / 2 - 0.6, z], PIPE_R + 0.6, steel, tone, 1, PIPE_R + 0.6, facets) : '')
      )
    }).join('')
    const valve = p.shape(on(PY(1.4), ellUV(PI.back + (tier.rows - 0.5) * PX_, pipeZ(tier.rows - 1, tier.rows), 1.6, 1.6, 10)), PALS.tomato.l, 1)
    const all = [...platePts, [0, 0, pipeZ(0, tier.rows) + PIPE_R] as V3, [0, W, pipeZ(0, tier.rows) + PIPE_R] as V3]
    return (
      p.castShadow(all, 0) +
      p.slab(0, 0, D, W, 0, PLATE_H, 1.6, matOf('#7d8589'), tone, 2.4) +
      rows +
      valve +
      ends(p, pl, ctx)
    )
  }
}
