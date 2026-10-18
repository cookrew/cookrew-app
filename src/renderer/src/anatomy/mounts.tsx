// TWO MOUNTS THAT ARE NOT A FLOOR.
//
// The floor grid has one unfixable fault: an isometric floor projects to a
// DIAMOND, and a diamond inscribed in a 16:9 rectangle leaves almost half the
// screen in the four corners. No amount of regridding gets that back — the
// waste is in the shape, so a denser board needs a different surface.
//
//   WALL — a cabinet of pigeonholes facing the viewer. A vertical plane
//   projects to a PARALLELOGRAM, which fills a rectangle nearly completely,
//   so this is the densest mount there is. Every agent is a box in the wall.
//
//   CAN — a tin you can spin. Rotation is not decoration here: it changes
//   what "the available area" means. A cylinder's surface is about three
//   times its own silhouette, so the can HOLDS far more than the screen can
//   show, and a drag brings the rest round. Fewer agents visible at once than
//   the wall, each of them bigger, and nothing is ever off the edge of a map.
//
// Both keep the rules the floor keeps: words live on the glass, a settled
// agent is quiet, and only an agent waiting on a person raises anything.

import { brandMark } from '../nodes/AgentAvatar'
import { Line, Solid } from './draw'
import type { StationAgent } from './station'
import {
  cylinder,
  haloOf,
  iso,
  pathOf,
  ring,
  sideArc,
  sideMatrix,
  slabOf,
  towardViewer,
  type Flat,
  type Point3,
  type Projection
} from './iso-kit'

export interface MountSeat {
  agent: StationAgent
  /** Where the glass label hangs, in screen px. */
  label: Flat
  depth: number
  node: React.ReactNode
}
export interface MountScene {
  P: Projection
  furniture: React.ReactNode
  seats: MountSeat[]
  cables: Array<{ a: string; b: string; d: string }>
  /** Roughly how wide one unit is on screen: drives the label ladder. */
  cellPx: number
  /**
   * Where the glass hangs a label. A floor unit has sky above it; a wall unit
   * has the row above, so its label goes INSIDE the hole and reads as the
   * card's own caption — which also stops the leftmost column's labels being
   * clipped by the edge of the stage.
   */
  labelAnchor: 'above' | 'inside'
}

const MARK_INK = '#f3efe4'
const MARK_BOX = 26
const faceQuad = (points: Point3[], P: Projection): string =>
  pathOf(
    points.map((p) => iso(p, P)),
    true
  )

/** The unit projection a plan is measured in before fitProjection scales it. */
const unitP = (azimuth: number, elevation: number): Projection => ({
  origin: [0, 0],
  scale: 1,
  azimuth,
  elevation
})
function boxOf(points: Point3[], P: Projection): { w: number; h: number } {
  const flat = points.map((p) => iso(p, P))
  const xs = flat.map(([x]) => x)
  const ys = flat.map(([, y]) => y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/* ===================== WALL ===================== */

const WALL_AZ = 80
const WALL_EL = 12
const HOLE_W = 42
const HOLE_H = 27
const HOLE_D = 11
const WALL_GAP_X = 4
const WALL_GAP_Z = 9

export interface WallPlan {
  cols: number
  rows: number
  w: number
  h: number
}

/**
 * Columns chosen the way the floor chooses them — by the size a cell ends up
 * on screen, not by matching an aspect — because with the camera fixed every
 * column count matches the aspect equally and the tie would break on empty
 * slots, which a single long row wins.
 */
export function planWall(n: number, aspect: number): WallPlan {
  const count = Math.max(1, n)
  let best: { plan: WallPlan; score: number } | null = null
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const w = cols * (HOLE_W + WALL_GAP_X) + WALL_GAP_X
    const h = rows * (HOLE_H + WALL_GAP_Z) + WALL_GAP_Z
    const box = boxOf(wallCorners({ cols, rows, w, h }), unitP(WALL_AZ, WALL_EL))
    const cell = HOLE_W * Math.min(aspect / box.w, 1 / box.h)
    const score = cell * Math.pow(count / (cols * rows), 0.1)
    if (best === null || score > best.score) best = { plan: { cols, rows, w, h }, score }
  }
  return best?.plan ?? { cols: count, rows: 1, w: count * HOLE_W, h: HOLE_H }
}

/**
 * Every extreme the cabinet reaches, and that is more than the holes: the
 * plinth below, the cornice and its engraved name above, and the flag a
 * waiting agent leans OUT of its hole (+y). Fitting the holes alone pushed
 * the top of the carcass off the stage.
 */
const wallCorners = (plan: WallPlan): Point3[] => {
  const xs = [-4, plan.w + 4]
  const ys = [-HOLE_D - 4, 14]
  const zs = [-11, plan.h + 10]
  return xs.flatMap((x) => ys.flatMap((y) => zs.map((z) => [x, y, z] as Point3)))
}
export const wallExtent = wallCorners

/** Reading order: top-left first, because a wall is read like a page. */
function wallSlot(i: number, plan: WallPlan): { x: number; z: number } {
  const c = i % plan.cols
  const r = Math.floor(i / plan.cols)
  return {
    x: WALL_GAP_X + c * (HOLE_W + WALL_GAP_X),
    z: plan.h - WALL_GAP_Z - (r + 1) * HOLE_H - r * WALL_GAP_Z
  }
}

function wallFurniture(plan: WallPlan, P: Projection, title: string): React.ReactNode {
  const back = { x: -3, y: -HOLE_D - 3, w: plan.w + 6, d: 3, r: 0 }
  const rails = Array.from({ length: plan.rows + 1 }, (_, r) => {
    const z = plan.h - WALL_GAP_Z - r * (HOLE_H + WALL_GAP_Z) + 1
    return (
      <Solid
        key={r}
        paths={slabOf({ x: -3, y: -HOLE_D - 1, w: plan.w + 6, d: HOLE_D + 1, r: 0.3 }, z, 2.4, P, 1, 0.3)}
        tone="lo"
        crease="none"
        className="an-rail"
      />
    )
  })
  return (
    <>
      <path className="iso-halo" d={haloOf({ x: -6, y: -HOLE_D - 8, w: plan.w + 12, d: HOLE_D + 12, r: 2 }, -8, 8, P)} />
      {/* The carcass: back panel, two cheeks, a plinth. */}
      <Solid paths={slabOf(back, -6, plan.h + 12, P, 1, 0.8)} tone="mid" className="an-carcass" />
      <Solid paths={slabOf({ x: -3, y: -HOLE_D - 3, w: 3, d: HOLE_D + 3, r: 0 }, -6, plan.h + 12, P, 1, 0.6)} tone="mid" />
      <Solid paths={slabOf({ x: plan.w, y: -HOLE_D - 3, w: 3, d: HOLE_D + 3, r: 0 }, -6, plan.h + 12, P, 1, 0.6)} tone="mid" />
      {rails}
      <Solid
        paths={slabOf({ x: -3, y: -HOLE_D - 3, w: plan.w + 6, d: HOLE_D + 3, r: 0 }, -10, 4, P, 1, 0.5)}
        tone="lo"
      />
      {/* Engraved on the plinth, not the cornice: the view's own controls sit
          at the top left of the stage and were clipping it there. */}
      <text
        className="iso-face-text"
        transform={sideMatrix([6, -HOLE_D - 3], -3, P, 'left')}
        fontSize={5}
        data-tone="mid"
      >
        {title.toUpperCase()}
      </text>
    </>
  )
}

function WallUnit({
  agent,
  x,
  z,
  P,
  selected
}: {
  agent: StationAgent
  x: number
  z: number
  P: Projection
  selected: boolean
}): React.JSX.Element {
  const plan = { x, y: -HOLE_D, w: HOLE_W, d: HOLE_D, r: 0.8 }
  const f = 0.06 // a hair in front of the face plane, so lines are not z-fought
  const waiting = agent.phase === 'waiting'
  // The face reads as the terminal card it stands for: dark panel, scanlines.
  const screen: Point3[] = [
    [x + 3, f, z + 7],
    [x + HOLE_W - 15, f, z + 7],
    [x + HOLE_W - 15, f, z + HOLE_H - 4],
    [x + 3, f, z + HOLE_H - 4]
  ]
  const rows = [0, 1, 2].map((i) => {
    const zz = z + HOLE_H - 7.5 - i * 3.4
    const len = [18, 11, 15][i]
    return pathOf([iso([x + 5.5, f, zz], P), iso([x + 5.5 + len, f, zz], P)])
  })
  const bars = ([
    ['note', agent.notes, z + 2.4],
    ['browser', agent.browsers, z + 2.4]
  ] as const).map(([kind, n], i) => {
    if (n === 0) return null
    const w = Math.min(14, 3 + Math.log2(n + 1) * 3.4)
    const x0 = x + 3 + i * 16
    return (
      <path
        key={kind}
        className={`an-bar an-${kind}`}
        d={faceQuad(
          [
            [x0, f, z + 2],
            [x0 + w, f, z + 2],
            [x0 + w, f, z + 4.4],
            [x0, f, z + 4.4]
          ],
          P
        )}
      />
    )
  })
  const markScale = 10 / MARK_BOX
  return (
    <g className={`an-hole st-${agent.phase}${selected ? ' sel' : ''}`} data-unit={agent.id}>
      <Solid paths={slabOf(plan, z, HOLE_H, P, 2, 0.5)} tone="hi" crease="lo" className="an-box" />
      <path className="an-screen" d={faceQuad(screen, P)} />
      {rows.map((d, i) => (
        <path key={i} className="an-scanline" data-row={i} d={d} />
      ))}
      <g className="an-mark" transform={sideMatrix([x + HOLE_W - 12, 0], z + HOLE_H - 5, P, 'left')}>
        <g transform={`scale(${markScale.toFixed(3)})`}>{brandMark(agent.harness, MARK_INK)}</g>
      </g>
      {bars}
      <circle
        className="an-lens"
        cx={iso([x + HOLE_W - 5.5, f, z + 4.5], P)[0].toFixed(1)}
        cy={iso([x + HOLE_W - 5.5, f, z + 4.5], P)[1].toFixed(1)}
        r="3.1"
      />
      {/* On a wall there is no sky to raise a mast into, so the flag leans out
          of the hole instead — still the only thing breaking the surface. */}
      {waiting ? (
        <path
          className="an-flag"
          d={faceQuad(
            [
              [x + HOLE_W - 2, 0, z + HOLE_H],
              [x + HOLE_W - 2, 13, z + HOLE_H - 2],
              [x + HOLE_W - 2, 0, z + HOLE_H - 6]
            ],
            P
          )}
        />
      ) : null}
    </g>
  )
}

export function buildWall(
  agents: readonly StationAgent[],
  placed: readonly string[],
  links: ReadonlyArray<readonly [string, string]>,
  w: number,
  h: number,
  title: string,
  fit: (points: Point3[], azimuth: number, elevation: number) => Projection,
  selectedId: string | null
): MountScene {
  const plan = planWall(agents.length, w / h)
  const P = fit(wallCorners(plan), WALL_AZ, WALL_EL)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const where = new Map<string, { x: number; z: number }>()
  const seats: MountSeat[] = []
  placed.forEach((id, i) => {
    const agent = byId.get(id)
    if (!agent) return
    const slot = wallSlot(i, plan)
    where.set(id, slot)
    seats.push({
      agent,
      label: iso([slot.x + 2.5, 0.1, slot.z + HOLE_H - 1.5], P),
      depth: -slot.z * 100 + slot.x,
      node: (
        <WallUnit key={id} agent={agent} x={slot.x} z={slot.z} P={P} selected={selectedId === id} />
      )
    })
  })
  // Top rows first, so a box never paints over the one above it.
  seats.sort((a, b) => a.depth - b.depth)
  const cables = links.flatMap(({ 0: a, 1: b }) => {
    const pa = where.get(a)
    const pb = where.get(b)
    if (!pa || !pb) return []
    // Cords hanging on the face, in the gap below each hole.
    const from = iso([pa.x + HOLE_W / 2, 0.1, pa.z - 1], P)
    const to = iso([pb.x + HOLE_W / 2, 0.1, pb.z - 1], P)
    const sag = Math.min(26, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.18)
    return [
      {
        a,
        b,
        d: `M${from[0].toFixed(1)} ${from[1].toFixed(1)}Q${((from[0] + to[0]) / 2).toFixed(1)} ${(
          Math.max(from[1], to[1]) + sag
        ).toFixed(1)} ${to[0].toFixed(1)} ${to[1].toFixed(1)}`
      }
    ]
  })
  const span = boxOf(
    [
      [0, 0, 0],
      [HOLE_W, 0, 0]
    ],
    P
  )
  return {
    P,
    furniture: wallFurniture(plan, P, title),
    seats,
    cables,
    cellPx: span.w,
    labelAnchor: 'inside'
  }
}

/* ===================== CAN ===================== */

const CAN_AZ = 45
const CAN_EL = 14
const TILE_H = 24
const TILE_GAP = 7
const CAN_LIP = 5

export interface CanPlan {
  cols: number
  rows: number
  r: number
  z0: number
  height: number
}

export function planCan(n: number): CanPlan {
  const count = Math.max(1, n)
  const rows = Math.min(4, Math.max(1, Math.ceil(count / 11)))
  const cols = Math.max(6, Math.ceil(count / rows))
  // The radius follows the circumference the tiles need, so a bigger crew
  // makes a fatter can rather than a crowded one.
  const r = Math.max(34, (cols * 34) / (2 * Math.PI))
  const height = rows * (TILE_H + TILE_GAP) + TILE_GAP + CAN_LIP * 2
  return { cols, rows, r, z0: 0, height }
}

export const canExtent = (plan: CanPlan): Point3[] => [
  [-plan.r - 4, -plan.r - 4, -2],
  [plan.r + 4, plan.r + 4, -2],
  [-plan.r - 4, plan.r + 4, plan.height + 3],
  [plan.r + 4, -plan.r - 4, plan.height + 3],
  [plan.r + 4, plan.r + 4, plan.height + 3],
  [-plan.r - 4, -plan.r - 4, plan.height + 3]
]

function canFurniture(plan: CanPlan, P: Projection): React.ReactNode {
  const bandTop = plan.height - CAN_LIP
  return (
    <>
      <path className="iso-halo" d={haloOf({ x: -plan.r, y: -plan.r, w: plan.r * 2, d: plan.r * 2, r: plan.r }, 0, 2, P)} />
      <Solid paths={cylinder(0, 0, plan.r + 1.6, 0, CAN_LIP, P, 64, 0.6)} tone="mid" className="an-rim" />
      <Solid paths={cylinder(0, 0, plan.r, CAN_LIP, plan.height - CAN_LIP * 2, P, 64)} tone="hi" className="an-tin" />
      <Solid
        paths={cylinder(0, 0, plan.r + 1.6, bandTop - CAN_LIP, CAN_LIP, P, 64, 0.6)}
        tone="mid"
        className="an-rim"
      />
      <Line d={ring(0, 0, plan.r - 2.4, plan.height, P, 64)} tone="lo" />
      <Line
        d={[CAN_LIP + 1, bandTop - CAN_LIP - 1].map((z) => sideArc(0, 0, plan.r, z, P, 48)).join('')}
        tone="lo"
      />
    </>
  )
}

function CanTile({
  agent,
  theta,
  span,
  z,
  plan,
  P,
  selected
}: {
  agent: StationAgent
  theta: number
  span: number
  z: number
  plan: CanPlan
  P: Projection
  selected: boolean
}): React.JSX.Element {
  const r = plan.r + 0.2
  const steps = 5
  const arc = (zz: number): Point3[] =>
    Array.from({ length: steps + 1 }, (_, k) => {
      const t = theta - span / 2 + (span * k) / steps
      return [Math.cos(t) * r, Math.sin(t) * r, zz] as Point3
    })
  const outline = [...arc(z), ...arc(z + TILE_H).reverse()]
  const mid = theta
  const lamp: Point3 = [Math.cos(mid) * (r + 0.1), Math.sin(mid) * (r + 0.1), z + 4.4]
  const bar = (n: number, k: number): React.ReactNode => {
    if (n === 0) return null
    const frac = Math.min(0.78, 0.12 + Math.log2(n + 1) * 0.1)
    const pts = [
      ...Array.from({ length: 4 }, (_, i) => {
        const t = theta - span / 2 + span * 0.08 + (span * frac * i) / 3
        return [Math.cos(t) * (r + 0.1), Math.sin(t) * (r + 0.1), z + 1.6 + k * 3] as Point3
      }),
      ...Array.from({ length: 4 }, (_, i) => {
        const t = theta - span / 2 + span * 0.08 + (span * frac * (3 - i)) / 3
        return [Math.cos(t) * (r + 0.1), Math.sin(t) * (r + 0.1), z + 3.6 + k * 3] as Point3
      })
    ]
    return <path className={`an-bar an-${k === 0 ? 'note' : 'browser'}`} d={faceQuad(pts, P)} />
  }
  return (
    <g className={`an-tile st-${agent.phase}${selected ? ' sel' : ''}`} data-unit={agent.id}>
      <path className="an-tile-face" d={faceQuad(outline, P)} />
      {bar(agent.notes, 0)}
      {bar(agent.browsers, 1)}
      <circle className="an-lens" cx={iso(lamp, P)[0].toFixed(1)} cy={iso(lamp, P)[1].toFixed(1)} r="3" />
      {agent.phase === 'waiting' ? (
        <path
          className="an-flag"
          d={faceQuad(
            [
              [Math.cos(mid) * r, Math.sin(mid) * r, z + TILE_H],
              [Math.cos(mid) * (r + 12), Math.sin(mid) * (r + 12), z + TILE_H - 2],
              [Math.cos(mid) * r, Math.sin(mid) * r, z + TILE_H - 6]
            ],
            P
          )}
        />
      ) : null}
    </g>
  )
}

export function buildCan(
  agents: readonly StationAgent[],
  placed: readonly string[],
  links: ReadonlyArray<readonly [string, string]>,
  w: number,
  h: number,
  spin: number,
  fit: (points: Point3[], azimuth: number, elevation: number) => Projection,
  selectedId: string | null
): MountScene {
  const plan = planCan(agents.length)
  const P = fit(canExtent(plan), CAN_AZ, CAN_EL)
  const [vx, vy] = towardViewer(P)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const step = (Math.PI * 2) / plan.cols
  const span = step * 0.84
  const seats: MountSeat[] = []
  const centre = new Map<string, Flat>()
  placed.forEach((id, i) => {
    const agent = byId.get(id)
    if (!agent) return
    const col = i % plan.cols
    const row = Math.floor(i / plan.cols)
    const theta = spin + col * step
    // Only the half turned toward the viewer is drawn: a tile on the far side
    // would paint over the tin it is supposed to be behind.
    const facing = Math.cos(theta) * vx + Math.sin(theta) * vy
    if (facing <= 0.08) return
    const z = plan.height - CAN_LIP - TILE_GAP - (row + 1) * TILE_H - row * TILE_GAP
    const mid: Point3 = [Math.cos(theta) * plan.r, Math.sin(theta) * plan.r, z + TILE_H]
    seats.push({
      agent,
      label: iso(mid, P),
      depth: facing,
      node: (
        <CanTile
          key={id}
          agent={agent}
          theta={theta}
          span={span}
          z={z}
          plan={plan}
          P={P}
          selected={selectedId === id}
        />
      )
    })
    centre.set(id, iso([Math.cos(theta) * plan.r, Math.sin(theta) * plan.r, z + TILE_H / 2], P))
  })
  // Edge-on tiles first so the ones facing us land on top of them.
  seats.sort((a, b) => a.depth - b.depth)
  const cables = links.flatMap(({ 0: a, 1: b }) => {
    const pa = centre.get(a)
    const pb = centre.get(b)
    if (!pa || !pb) return []
    const mx = (pa[0] + pb[0]) / 2
    const my = (pa[1] + pb[1]) / 2 - Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * 0.12
    return [
      {
        a,
        b,
        d: `M${pa[0].toFixed(1)} ${pa[1].toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${pb[0].toFixed(1)} ${pb[1].toFixed(1)}`
      }
    ]
  })
  const tileSpan = Math.abs(
    iso([Math.cos(0) * plan.r, Math.sin(0) * plan.r, 0], P)[0] -
      iso([Math.cos(span) * plan.r, Math.sin(span) * plan.r, 0], P)[0]
  )
  return {
    P,
    furniture: canFurniture(plan, P),
    seats,
    cables,
    cellPx: Math.max(60, tileSpan),
    labelAnchor: 'above'
  }
}
