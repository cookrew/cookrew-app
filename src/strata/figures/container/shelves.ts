// The shelf family: seats stand on shelf boards behind a front face, one long
// opening per row. Bookshelf, house shelf, lockers, vault, craft drawers and
// the open lab rack differ in body, trim and props, not in seating.
import { ellUV, on, PX, PY, PZ, rectUV, rrUV, type V2, type V3 } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { CERAMIC, CLEAR, INK, matOf, METAL, mix, PALS, PAPER, tone, toneI, WOOD, type Mat } from '../iso/tone'
import { boxIn, openings, plaque, seatY, tray, type ArchetypeDef, type Ctx, type Plan } from './common'
import { SEAT_R, seatGrid, type Seat, type Tier } from './layout'

const CW = 8.4
const CH = 11
const BOARD = 1.2
const BACK = 1.2

interface ShelfOpts {
  D: number
  side: number
  top: number
  base: number
  /** Room at the right end of every row for props (books). */
  extra: number
  /** Height above the body (roof, props), for framing. */
  over: number
  /** Extra room in front (an open door), for framing. */
  front: number
}

interface Row {
  z0: number
  z1: number
}

export interface ShelfPlan extends Plan {
  o: ShelfOpts
  tier: Tier
  W: number
  H: number
  rows: Row[]
  y0: number
  y1: number
}

const corners = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): V3[] =>
  [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [z0, z1].map((z) => [x, y, z] as V3)))

const shelfPlan = (tier: Tier, seats: Seat[], o: ShelfOpts): ShelfPlan => {
  const W = 2 * o.side + o.extra + tier.cols * CW
  const H = o.base + tier.rows * CH + o.top
  const rows = Array.from({ length: tier.rows }, (_, r) => {
    const z1 = H - o.top - r * CH
    return { z0: z1 - CH + BOARD, z1 }
  })
  const tr = { x0: o.D - 11, x1: o.D + 1, y0: -15, y1: -3 }
  return {
    o,
    tier,
    W,
    H,
    rows,
    y0: o.side,
    y1: W - o.side,
    seats: seats.map((s) => [o.D - SEAT_R - 0.7, seatY(o.side + o.extra, tier.cols, CW, s.col), rows[s.row].z0 + SEAT_R] as V3),
    plaque: { x: o.D + 0.02, y: W / 2, w: Math.min(W - 6, 44), z0: 0.7, z1: o.base + BOARD - 0.7 },
    tray: tr,
    fit: [...corners(0, 0, 0, o.D + o.front, W, H + o.over), ...corners(tr.x0, tr.y0, 0, tr.x1, tr.y1, 0)]
  }
}

const rowFace = (pl: ShelfPlan, r: Row): V3[] => on(PX(pl.o.D + 0.01), rectUV(pl.y0, r.z0, pl.y1, r.z1))

interface Finish {
  body: Mat
  wall: string
  back: string
}

/** Shadow, body, the row openings: what every closed shelf starts with. */
const shell = (p: Pen, pl: ShelfPlan, f: Finish) => {
  const pts = corners(0, 0, 0, pl.o.D, pl.W, pl.H)
  return {
    pts,
    shadow: p.castShadow(pts, 0),
    body: p.box(0, 0, 0, pl.o.D, pl.W, pl.H, f.body, tone, 1),
    holes: openings(p, pl.rows.map((r) => rowFace(pl, r)), pl.o.D - BACK, f.wall, f.back),
    ink: p.hullInk(pts, 2.6)
  }
}

const opening2 = (p: Pen, pl: ShelfPlan, r: Row): V2[] => rowFace(pl, r).map(p.P)
const ends = (p: Pen, pl: ShelfPlan, ctx: Ctx) => tray(p, pl.tray) + plaque(p, pl.plaque, ctx)

// ── bookshelf ───────────────────────────────────────────────────────────────
const BOOK_OPTS: ShelfOpts = { D: 9, side: 2.2, top: 2.2, base: 4, extra: 6, over: 1.4, front: 1 }

export const bookshelf: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, BOOK_OPTS),
  draw(p, pl, ctx) {
    const wood = WOOD
    const s = shell(p, pl, { body: wood, wall: wood.d, back: wood.m })
    const tints = [ctx.m, PALS.mustard, PALS.cobalt]
    const books = pl.rows
      .map((r, ri) => {
        // a tall case gets books on every third shelf only (bytes, and calm)
        if (pl.rows.length > 4 && ri % 3 !== 0) return ''
        const clip = opening2(p, pl, r)
        return [0, 1, 2]
          .map((i) => {
            const h = (r.z1 - r.z0) * (0.58 + ((i + ri) % 3) * 0.08)
            const y = pl.y0 + 0.5 + i * 1.8
            return boxIn(p, [2, y, r.z0, pl.o.D - 1.8, y + 1.5, r.z0 + h], tints[(i + ri) % 3], clip)
          })
          .join('')
      })
      .join('')
    const crown = p.box(0, -0.8, pl.H, pl.o.D + 0.8, pl.W + 0.8, pl.H + 1.2, wood, tone, 1.2)
    return s.shadow + s.body + s.holes + books + crown + s.ink + ends(p, pl, ctx)
  }
}

// ── house shelf ─────────────────────────────────────────────────────────────
const HOUSE_OPTS: ShelfOpts = { D: 10, side: 2.4, top: 2.2, base: 4, extra: 0, over: 9, front: 1 }
const ROOF = matOf('#c8553d')

export const house: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, HOUSE_OPTS),
  draw(p, pl, ctx) {
    const m = ctx.m
    const { D } = pl.o
    const s = shell(p, pl, { body: m, wall: m.d, back: mix(m.m, '#000000', 0.25) })
    const H = pl.H
    const R = 8
    const ridge = D / 2
    const chimney = p.box(1.4, pl.W * 0.22, H + 2, 3.8, pl.W * 0.22 + 2.6, H + R + 2.2, ROOF, tone, 1)
    const gable = on(PY(pl.W), [[0, H], [D, H], [ridge, H + R - 0.6]])
    const slope: V3[] = [[D + 1.2, -1, H - 0.6], [D + 1.2, pl.W + 1, H - 0.6], [ridge, pl.W + 1, H + R], [ridge, -1, H + R]]
    const edge: V3[] = [[D + 1.2, pl.W + 1, H - 0.6], [ridge, pl.W + 1, H + R], [ridge, pl.W + 1, H + R - 1.2], [D + 1.2, pl.W + 1, H - 1.8]]
    const roof =
      chimney +
      p.fill(gable, tone([0, 1, 0], m)) +
      p.ink(gable, 1) +
      p.shape(on(PY(pl.W + 0.02), ellUV(ridge, H + R * 0.38, 1.4, 1.4, 10)), mix(m.d, '#000000', 0.2), 0.8) +
      p.shape(edge, ROOF.d, 1) +
      p.shape(slope, tone([1, 0, 1], ROOF), 1.2) +
      p.line([[ridge, -1, H + R], [ridge, pl.W + 1, H + R]], 1.4) +
      p.hullInk([...slope, ...edge, ...s.pts], 2.6)
    return s.shadow + s.body + s.holes + roof + ends(p, pl, ctx)
  }
}

// ── lockers ─────────────────────────────────────────────────────────────────
const LOCKER_OPTS: ShelfOpts = { D: 9, side: 1.6, top: 5, base: 4, extra: 0, over: 0, front: 1 }

export const lockers: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, LOCKER_OPTS),
  draw(p, pl, ctx) {
    const m = ctx.m
    const s = shell(p, pl, { body: m, wall: m.d, back: mix(m.m, '#000000', 0.3) })
    const F = pl.o.D + 0.03
    const front = tone([1, 0, 0], m)
    const cols = pl.tier.cols
    const ys = Array.from({ length: cols - 1 }, (_, i) => pl.y0 + (i + 1) * CW)
    // column dividers across every row, as one path
    const dividers = pl.rows
      .flatMap((r) => ys.map((y) => p.d3(on(PX(F), rectUV(y - 0.5, r.z0, y + 0.5, r.z1)))))
      .join('')
    // three vent slots per column in the top band
    const zt = pl.H - pl.o.top
    const vents = Array.from({ length: cols }, (_, c) => pl.y0 + (c + 0.5) * CW)
      .flatMap((y) => [1.2, 2.4, 3.6].map((dz) => p.d3([[F, y + 2.2, zt + dz], [F, y - 2.2, zt + dz]], false)))
      .join('')
    return (
      s.shadow +
      s.body +
      s.holes +
      `<path d="${dividers}" fill="${front}" stroke="${INK}" stroke-width="${(0.7 * p.spec.k).toFixed(2)}"/>` +
      `<path d="${vents}" stroke="${mix(m.d, '#000000', 0.2)}" stroke-width="${(1.1 * p.spec.k).toFixed(2)}"/>` +
      s.ink +
      ends(p, pl, ctx)
    )
  }
}

// ── vault ───────────────────────────────────────────────────────────────────
const VAULT_OPTS: ShelfOpts = { D: 11, side: 4, top: 4, base: 5, extra: 0, over: 0, front: 0 }
const STEEL = matOf('#aeb6ba')

/** The open door's radius: smaller on a tall, narrow (phone) vault so it does not eat the width. */
const doorR = (pl: ShelfPlan) => Math.min(pl.H * 0.42, pl.tier.rows > 4 ? 6.5 : 15)

const vaultDoor = (p: Pen, pl: ShelfPlan, m: Mat) => {
  const r = doorR(pl)
  const cx = pl.o.D + r + 0.6
  const cz = r + 0.6
  const disc = (y: number) => on(PY(y), ellUV(cx, cz, r, r, 14))
  const face = disc(-0.4)
  const bolts = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2
    return p.stud([cx + Math.cos(a) * r * 0.78, -0.35, cz + Math.sin(a) * r * 0.78], 0.8, STEEL.l, 0)
  }).join('')
  const pts = [...face, ...disc(-3.4)]
  return {
    pts,
    svg:
      p.castShadow(pts, 0) +
      p.loft(disc(-3.4), face, (n) => tone(n, STEEL)) +
      p.fill(face, tone([0, 1, 0], STEEL)) +
      p.ink(on(PY(-0.38), ellUV(cx, cz, r * 0.9, r * 0.9, 14)), 0.8) +
      bolts +
      p.shape(on(PY(-0.35), ellUV(cx, cz, r * 0.22, r * 0.22, 12)), m.m, 1) +
      p.hullInk(pts, 2.4)
  }
}

export const vault: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => {
    const pl = shelfPlan(tier, seats, VAULT_OPTS)
    const r = doorR(pl)
    // the open door stands to the right, swung out toward the viewer; the tray moves past it
    const tr = { x0: pl.o.D + 2 * r + 3, x1: pl.o.D + 2 * r + 15, y0: -13, y1: -1 }
    return { ...pl, tray: tr, fit: [...pl.fit, ...corners(pl.o.D, -3.4, 0, pl.o.D + 2 * r + 15, -13, 2 * r + 1.2)] }
  },
  draw(p, pl, ctx) {
    const s = shell(p, pl, { body: STEEL, wall: STEEL.d, back: mix(STEEL.m, '#000000', 0.18) })
    const F = pl.o.D + 0.02
    const frame = on(PX(F), rrUV(pl.y0 - 1.6, pl.rows[pl.rows.length - 1].z0 - 1.6, pl.y1 + 1.6, pl.rows[0].z1 + 1.6, 1.4, 2))
    const stripe = p.fill(on(PX(F), rectUV(0.6, pl.H - 2.6, pl.W - 0.6, pl.H - 1.4)), ctx.m.l)
    const door = vaultDoor(p, pl, ctx.m)
    return s.shadow + s.body + p.ink(frame, 1.6) + stripe + s.holes + s.ink + door.svg + ends(p, pl, ctx)
  }
}

// ── craft drawers ───────────────────────────────────────────────────────────
const DRAWER_OPTS: ShelfOpts = { D: 9, side: 2, top: 4, base: 8, extra: 0, over: 8, front: 1 }

export const drawers: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => {
    const pl = shelfPlan(tier, seats, DRAWER_OPTS)
    // the name goes on the top band; the base is a row of little drawers
    return { ...pl, plaque: { ...pl.plaque, z0: pl.H - DRAWER_OPTS.top + 0.6, z1: pl.H - 0.6 } }
  },
  draw(p, pl, ctx) {
    const m = ctx.m
    const s = shell(p, pl, { body: m, wall: m.d, back: mix(m.m, '#000000', 0.22) })
    const F = pl.o.D + 0.03
    const n = Math.max(3, Math.round(pl.tier.cols / 1.5))
    const w = (pl.y1 - pl.y0) / n
    const knobs = [PALS.mustard, PALS.tomato, PALS.cobalt, PALS.mint, PALS.blush]
    const front = tone([1, 0, 0], m)
    const drawerRow = Array.from({ length: n }, (_, i) => {
      const y0 = pl.y0 + i * w + 0.5
      const y1 = y0 + w - 1
      return (
        p.shape(on(PX(F), rrUV(y0, 1.2, y1, BOARD + DRAWER_OPTS.base - 1.4, 0.6, 2)), mix(front, PAPER, 0.25), 0.9) +
        p.stud([F + 0.02, (y0 + y1) / 2, BOARD + DRAWER_OPTS.base / 2 - 0.2], 0.9, knobs[i % knobs.length].m)
      )
    }).join('')
    // a pencil cup on top, at the right end
    const cx = pl.o.D / 2
    const cy = pl.y0 + 3
    const top = pl.H
    const pencils = [[-0.8, 0.4, 7, PALS.mustard], [0.6, -0.6, 8, PALS.tomato], [0.2, 0.9, 6.4, PALS.cobalt]] as const
    const cup =
      pencils.map(([dx, dy, h, c]) => p.tube([cx + dx * 0.3, cy + dy * 0.3, top + 1], [cx + dx, cy + dy, top + h], 0, 0.4, c)).join('') +
      p.cyl(cx, cy, top, top + 4.6, 2.2, CERAMIC, tone, 1.2, 10)
    return s.shadow + s.body + s.holes + drawerRow + s.ink + cup + ends(p, pl, ctx)
  }
}

// ── lab rack: an open metal rack with flasks on top ─────────────────────────
const LAB_OPTS: ShelfOpts = { D: 10, side: 1.4, top: 1.2, base: 4, extra: 0, over: 10, front: 1 }

export const lab: ArchetypeDef<ShelfPlan> = {
  plan: (tier, seats) => shelfPlan(tier, seats, LAB_OPTS),
  draw(p, pl, ctx) {
    const { D } = pl.o
    const steel = METAL
    const W = pl.W
    const post = (x: number, y: number) =>
      p.box(x, y, 0, x + 1.2, y + 1.2, pl.H, steel, tone, 0) + p.hullInk(p.boxPts(x, y, 0, x + 1.2, y + 1.2, pl.H), 1, { edge: false })
    // a tall rack draws its plates as top and front edge only: same look at that size, half the bytes
    const lean = pl.tier.rows > 4
    const plate = (z: number) =>
      lean
        ? p.shape(on(PZ(z), rectUV(0, 0, D, W)), tone([0, 0, 1], steel), 0.9) + p.shape(on(PX(D), rectUV(0, z - 0.8, W, z)), tone([1, 0, 0], steel), 0.9)
        : p.box(0, 0, z - 0.8, D, W, z, steel, tone, 0) + p.hullInk(p.boxPts(0, 0, z - 0.8, D, W, z), 1, { edge: false })
    const basePts = corners(0, 0, 0, D, W, LAB_OPTS.base + BOARD)
    const allPts = corners(0, 0, 0, D, W, pl.H)
    const base = p.box(0, 0, 0, D, W, LAB_OPTS.base + BOARD, matOf('#8f989b'), tone, 1)
    // plates bottom to top (a higher plate never covers the row below it), posts in front last
    const plates = [...pl.rows].reverse().slice(1).map((r) => plate(r.z0)).join('') + plate(pl.H)
    const liquid = [ctx.m, PALS.mint, PALS.blush]
    const flasks = (lean ? [0.3, 0.7] : [0.25, 0.5, 0.75])
      .map((t, i) => {
        const y = W * (1 - t)
        const x = D * 0.45
        const z = pl.H
        const glass = CLEAR
        return (
          p.sphere([x, y, z + 2.6], 2.4, liquid[i], { w: 1 }) +
          p.rod([x, y, z + 4.4], [x, y, z + 8 - i], 0.8, glass, tone, 0.9, 0.8, 8) +
          p.fill(on(PZ(z + 0.05), ellUV(x, y, 2.6, 2.6, 10)), mix(glass.d, '#000000', 0.1), 'opacity=".25"')
        )
      })
      .join('')
    return (
      p.castShadow(allPts, 0, null, 'opacity=".6"') +
      post(0, 0) +
      post(0, W - 1.2) +
      base +
      plates +
      post(D - 1.2, 0) +
      post(D - 1.2, W - 1.2) +
      flasks +
      p.hullInk(basePts, 2.4) +
      ends(p, pl, ctx)
    )
  }
}
