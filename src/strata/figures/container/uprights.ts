// Upright siblings of the surface family. A phone's columns hint stacks a
// workspace tall and narrow, and a surface (seats on top, rows running back
// to front) cannot trade width for seat size: each row it adds goes deeper,
// which on screen is wider. So on a hinted layout a surface archetype seats
// on an upright of the same vibe instead: the workbench on its pegboard, the
// sandbox on a toy shelf, the record crate on stacked crates, the pipe rack
// on a pipe wall. The name still picks the vibe; the hint only picks the face.
// Bleachers stay bleachers.
import { ellUV, hull, on, PX, PY, PZ, rectUV, rrUV, type V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { DARK, INK, matOf, METAL, PALS, tone, toneI, WOOD, type Mat } from '../iso/tone'
import type { ArchetypeDef } from './common'
import type { Archetype } from './name'
import { BOARD, corners, ends, shelfPlan, shell, type ShelfOpts, type ShelfPlan } from './shelves'

export const UPRIGHTS = ['pegboard', 'toyshelf', 'cratestack', 'pipewall'] as const
export type Upright = (typeof UPRIGHTS)[number]

/** The surface archetypes that turn upright on a hinted layout. */
export const UPRIGHT_OF: Partial<Record<Archetype, Upright>> = {
  workbench: 'pegboard',
  sandbox: 'toyshelf',
  crate: 'cratestack',
  pipes: 'pipewall'
}

/** Uprights stack like shelves. */
export const UPRIGHT_MAX_ROWS = 12

/** Many flat boxes (planks, brackets) as three shared fills and one ink path. */
const slabs = (p: Pen, bs: ReadonlyArray<readonly [number, number, number, number, number, number]>, m: Mat, w = 0.9): string => {
  if (bs.length === 0) return ''
  const faces = (pick: (b: readonly number[]) => V3[]) => bs.map((b) => p.d3(pick(b))).join('')
  const top = faces(([x0, y0, , x1, y1, z1]) => [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
  const front = faces(([, y0, z0, x1, y1, z1]) => [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]])
  const side = faces(([x0, , z0, x1, y1, z1]) => [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]])
  const outline = bs.map(([x0, y0, z0, x1, y1, z1]) => p.d2(hull(corners(x0, y0, z0, x1, y1, z1).map(p.P)))).join('')
  return (
    `<path d="${side}" fill="${tone([0, 1, 0], m)}"/>` +
    `<path d="${front}" fill="${tone([1, 0, 0], m)}"/>` +
    `<path d="${top}" fill="${tone([0, 0, 1], m)}"/>` +
    `<path d="${outline}" stroke="${INK}" stroke-width="${num(w * p.spec.k)}"/>`
  )
}

// ── pegboard over a bench (workbench) ───────────────────────────────────────
const PANEL = 1.4
const PEG_OPTS: ShelfOpts = { D: 9, side: 0.6, top: 10, base: 13, extra: 0, over: 0, front: 1.6 }

export const pegboard: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => {
    const pl = shelfPlan(tier, seats, PEG_OPTS)
    // the name goes on the bench's apron, under its top
    return { ...pl, plaque: { ...pl.plaque, x: PEG_OPTS.D + PEG_OPTS.front + 0.02, z0: 6.6, z1: 9.6 } }
  },
  draw(p, pl, ctx) {
    const { D, front } = pl.o
    const { W, H } = pl
    const bench = pl.rows[pl.rows.length - 1].z0
    const X = D + front
    const leg = (x: number, y: number) => p.box(x, y, 0, x + 1.8, y + 1.8, bench - 3, WOOD, tone, 0.9)
    const benchPts = corners(0, 0, bench - 3, X, W, bench)
    const panelPts = corners(0, 0, bench, PANEL, W, H)
    // a plank under every row but the bottom one, which sits on the bench
    const planks = pl.rows.slice(0, -1).map((r) => [PANEL, 0.6, r.z0 - BOARD, D, W - 0.6, r.z0] as const)
    const pegs = [...pl.rows.map((r) => r.z0 + 7.6), H - 3]
      .map((z) => p.d3([[PANEL + 0.02, W - 1.6, z], [PANEL + 0.02, 1.6, z]], false))
      .join('')
    const hy = W * 0.62
    const zt = H - PEG_OPTS.top
    const tools =
      p.shape(on(PX(PANEL + 0.2), rectUV(hy - 0.5, zt + 1, hy + 0.5, zt + 7.4)), WOOD.m, 0.8) +
      p.shape(on(PX(PANEL + 0.3), rectUV(hy - 2.2, zt + 6.6, hy + 2.2, zt + 8.6)), DARK.l, 0.9) +
      p.shape(on(PX(PANEL + 0.2), rectUV(hy - 7.4, zt + 1.4, hy - 6, zt + 8.6)), PALS.mustard.l, 0.8)
    return (
      p.castShadow([...benchPts, ...panelPts, ...corners(0, 0, 0, X, W, 0)], 0) +
      leg(0.6, W - 2.4) +
      leg(X - 2.4, W - 2.4) +
      leg(X - 2.4, 0.6) +
      p.box(X - 1, 2.4, 6, X, W - 2.4, bench - 3, WOOD, tone, 0.9) +
      p.box(0, 0, bench - 3, X, W, bench, WOOD, tone, 1.2) +
      p.hullInk(benchPts, 2.4) +
      p.box(0, 0, bench, PANEL, W, H, ctx.m, tone, 1) +
      `<path d="${pegs}" stroke="${ctx.m.d}" stroke-width="${num(1.1 * p.spec.k)}" stroke-dasharray="0 ${num(3.4 * p.spec.s)}"/>` +
      tools +
      slabs(p, planks, WOOD) +
      p.hullInk(panelPts, 2.2) +
      ends(p, pl, ctx)
    )
  }
}

// ── toy shelf (sandbox): sand at the back of every cubby, a bucket on top ───
const SAND = '#f1d9a0'
const TOY_EDGES = [PALS.tomato.l, PALS.mustard.l, PALS.cobalt.l, PALS.mint.l]
const TOY_OPTS: ShelfOpts = { D: 9, side: 2, top: 2.4, base: 4.4, extra: 0, over: 10, front: 1 }

export const toyshelf: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, TOY_OPTS),
  draw(p, pl, ctx) {
    const m = ctx.m
    const s = shell(p, pl, { body: m, wall: m.d, back: SAND })
    const top = pl.H
    const bx = pl.o.D * 0.5
    const by = pl.y0 + 4
    const bucket = PALS.cobalt
    const spade =
      p.rod([bx + 1.2, by + 4.6, top], [bx - 1, by + 5.6, top + 9], 0.45, WOOD, toneI, 0.9) +
      p.shape(on(PX(bx + 1.5), [[by + 3.4, top], [by + 5.8, top], [by + 5.6, top + 3.4], [by + 3.6, top + 3.4]]), METAL.m, 0.9)
    const pail = p.cyl(bx, by, top, top + 5, 2.6, bucket, tone, 1.2, 12) + p.fill(on(PZ(top + 5.02), ellUV(bx, by, 2, 2, 12)), SAND)
    // toy-box colours on the board edge under every row
    const F = pl.o.D + 0.02
    const edges = pl.rows
      .map((r, i) => p.shape(on(PX(F), rectUV(pl.y0, r.z0 - BOARD, pl.y1, r.z0)), TOY_EDGES[i % TOY_EDGES.length], 0.7))
      .join('')
    return s.shadow + s.body + s.holes + edges + s.ink + spade + pail + ends(p, pl, ctx)
  }
}

// ── stacked crates (record crate): one crate per row, records on top ────────
const CRATE_WOOD = matOf('#cf9a5c')
const STACK_OPTS: ShelfOpts = { D: 9, side: 1.2, top: 1.2, base: 3, extra: 0, over: 9, front: 1 }

export const cratestack: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, STACK_OPTS),
  draw(p, pl, ctx) {
    const wood = CRATE_WOOD
    const s = shell(p, pl, { body: wood, wall: wood.d, back: wood.m })
    const { D } = pl.o
    const { W } = pl
    // where one crate stands on the next (mid-board), and a slat line along each crate's side
    const seams = pl.rows.slice(1).map((r) => r.z1 + BOARD / 2)
    const slats = pl.rows.map((r) => (r.z0 + r.z1) / 2)
    const seamD = seams.map((z) => p.d3([[D, 0, z], [D, W, z], [0, W, z]], false)).join('')
    const slatD = slats.map((z) => p.d3([[D - 0.6, W, z], [0.6, W, z]], false)).join('')
    // a hand-hole in each crate's side, under its slat
    const holes = pl.rows.map((r) => p.d3(on(PY(W + 0.02), rrUV(D * 0.3, r.z0 + 1.6, D * 0.7, r.z0 + 3.4, 0.9, 2)))).join('')
    const sleeves = [ctx.m, PALS.mustard, matOf('#2b2824'), PALS.cobalt]
    const records = sleeves
      .map((c, i) => {
        const x = 1.4 + i * 2
        return p.box(x, 1.2, pl.H, x + 0.7, 9, pl.H + 8 - (i % 2) * 0.8, c, tone, 0.7)
      })
      .join('')
    return (
      s.shadow +
      s.body +
      s.holes +
      `<path d="${slatD}" stroke="${wood.d}" stroke-width="${num(1 * p.spec.k)}"/>` +
      `<path d="${holes}" fill="${wood.d}" stroke="${INK}" stroke-width="${num(0.7 * p.spec.k)}"/>` +
      `<path d="${seamD}" stroke="${INK}" stroke-width="${num(1.1 * p.spec.k)}"/>` +
      s.ink +
      records +
      ends(p, pl, ctx)
    )
  }
}

// ── pipe wall (pipe rack): one pipe per row, seats resting on top ───────────
const PIPE_R = 2.2
const WALL = 2
const PLINTH = 5
const PIPE_STEEL = matOf('#9aa3a8')
const WALL_STEEL = matOf('#7d8589')
const PIPE_OPTS: ShelfOpts = { D: 9, side: 2, top: 3, base: 9, extra: 0, over: 0, front: 1 }

/** A pipe along y at (x, z): its body, the lit upper band, the end cap facing left, and its ink, as path data. */
const pipeD = (p: Pen, x: number, z: number, y0: number, y1: number, r: number) => {
  const ring = (y: number) => on(PY(y), ellUV(x, z, r, r, 8))
  const upper = (y: number) => on(PY(y), ellUV(x, z, r, r, 8)).filter((q) => q[2] >= z - 0.01)
  const body = hull([...ring(y0), ...ring(y1)].map(p.P))
  const band = hull([...upper(y0), ...upper(y1)].map(p.P))
  const cap = ring(y1).map(p.P)
  return { body: p.d2(body), band: p.d2(band), cap: p.d2(cap), ink: p.d2(body) + p.d2(cap) }
}

export const pipewall: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => {
    const pl = shelfPlan(tier, seats, PIPE_OPTS)
    // the name goes on the plinth, which is lower than the shelf base the pipes clear
    return { ...pl, plaque: { ...pl.plaque, z0: 0.7, z1: PLINTH - 0.7 } }
  },
  draw(p, pl, ctx) {
    const m = ctx.m
    const { D } = pl.o
    const { W, H } = pl
    const x = D - 2.8 - 0.7
    const zs = pl.rows.map((r) => r.z0 - PIPE_R + 0.4)
    const pipes = zs.map((z) => pipeD(p, x, z, 1.2, W - 1.2, PIPE_R))
    const join = (k: 'body' | 'band' | 'cap' | 'ink') => pipes.map((q) => q[k]).join('')
    const wallPts = corners(0, 0, 0, WALL, W, H)
    const plinthPts = corners(0, 0, 0, D, W, PLINTH)
    const straps = [3.4, W - 5]
      .map((y) => p.shape(on(PX(WALL + 0.02), rectUV(y, PLINTH, y + 1.6, H - 1.2)), tone([1, 0, 0], METAL), 0.8))
      .join('')
    const zLow = zs[zs.length - 1]
    const valve = p.shape(on(PY(W - 1), ellUV(x, zLow, 1.7, 1.7, 10)), PALS.tomato.l, 1)
    return (
      p.castShadow([...wallPts, ...plinthPts], 0) +
      p.box(0, 0, 0, WALL, W, H, WALL_STEEL, tone, 1) +
      straps +
      p.hullInk(wallPts, 2.4) +
      p.box(0, 0, 0, D, W, PLINTH, WALL_STEEL, tone, 1) +
      p.hullInk(plinthPts, 2.4) +
      `<path d="${join('body')}" fill="${m.m}"/>` +
      `<path d="${join('band')}" fill="${m.l}"/>` +
      `<path d="${join('cap')}" fill="${m.d}"/>` +
      `<path d="${join('ink')}" stroke="${INK}" stroke-width="${num(1.4 * p.spec.k)}"/>` +
      valve +
      ends(p, pl, ctx)
    )
  }
}

export const UPRIGHT_DEFS: Record<Upright, ArchetypeDef<ShelfPlan>> = { pegboard, toyshelf, cratestack, pipewall }
