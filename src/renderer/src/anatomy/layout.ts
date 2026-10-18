// Fitting the board into the canvas area: how many slots, what camera, which
// card goes where, and where the cables run. All pure, so the awkward parts
// (the camera search and the cable lanes) are testable without a DOM.

import { CELL } from './cards'
import { iso, type Point3, type Projection } from './iso-kit'

export type AnatomyOrientation = 'landscape' | 'portrait'

/** The gap between two slots. Cables run in it, so it is not decoration. */
export const GUTTER = 15
export const PITCH = CELL + GUTTER

export interface AnatomyGrid {
  cols: number
  rows: number
  azimuth: number
  elevation: number
}

/**
 * An isometric floor projects to a diamond, and at the default azimuth of 45
 * that diamond's aspect is 1/sin(elevation) WHATEVER the grid's shape — so
 * making the grid narrower cannot make the picture taller. A phone held
 * upright therefore needs the camera to swing round as well, which is why
 * this searches azimuth and elevation together with the column count instead
 * of just reshaping the grid.
 *
 * The search prefers the kit's own 45/30 and only leaves it when the aspect
 * it is asked for cannot be reached from there, so a desktop window that
 * resizes a little does not swing the camera around.
 */
// 86 rather than a round 90: at 90 the y axis points straight down and the
// picture is a flat grid with no side faces at all, so the solids stop reading
// as solid. Just short of it keeps the lean small enough for a phone held
// upright while every card still has a visible side.
/**
 * ONE CAMERA PER ORIENTATION, fixed.
 *
 * Letting the search choose the camera as well as the grid was tried and is
 * wrong twice over. It always landed on a near-frontal, low camera, because a
 * squashed floor packs the most card into a screen — so the isometric look
 * the scene is built on went away; and it chose a different camera per
 * workspace, so the same board looked like a different room depending on how
 * many cards were on it.
 *
 * Landscape is the kit's own 45/30. Portrait cannot be: at azimuth 45 the
 * floor projects to a diamond whose aspect is 1/sin(elevation) for ANY grid,
 * which is always wider than tall, so a phone held upright needs the camera
 * swung most of the way round. 78 keeps a visible side face on both axes
 * (at 90 the solids would go flat) while running the long axis down the
 * screen.
 */
const CAMERA: Record<AnatomyOrientation, { azimuth: number; elevation: number }> = {
  landscape: { azimuth: 45, elevation: 30 },
  portrait: { azimuth: 78, elevation: 38 }
}

export function planGrid(
  count: number,
  aspect: number,
  orientation: AnatomyOrientation
): AnatomyGrid {
  const n = Math.max(1, count)
  const { azimuth, elevation } = CAMERA[orientation]
  // Score by the SIZE A CARD ENDS UP, not by how closely the floor's aspect
  // matches the screen's. Matching the aspect has a trap: with the camera
  // fixed, every column count scores the same, so the tie broke on wasted
  // slots — which a single row of fourteen wins outright, and then fourteen
  // cards cross a 1440px stage as a thin strip with the screen empty around
  // them. Fitting the card is the thing actually wanted.
  let best: { grid: AnatomyGrid; score: number } | null = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const grid = { cols, rows, azimuth, elevation }
    const box = unitBounds(grid)
    // The stage as (aspect x 1): the scale fitProjection would land on.
    const cell = PITCH * Math.min(aspect / box.w, 1 / box.h)
    // A mild dislike of empty slots, enough to break a tie and no more.
    const score = cell * Math.pow(n / (cols * rows), 0.08)
    if (best === null || score > best.score) best = { grid, score }
  }
  return best === null ? { cols: n, rows: 1, ...CAMERA[orientation] } : best.grid
}

/** The floor's bounding box in a scale-1 projection, for the fit search. */
function unitBounds(grid: AnatomyGrid): { w: number; h: number } {
  const unit: Projection = {
    origin: [0, 0],
    scale: 1,
    azimuth: grid.azimuth,
    elevation: grid.elevation
  }
  const flat = gridBounds(grid).map((p) => iso(p, unit))
  const xs = flat.map(([x]) => x)
  const ys = flat.map(([, y]) => y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** Every extreme point of the floor, for fitProjection. */
export function gridBounds(grid: AnatomyGrid): Point3[] {
  const w = grid.cols * PITCH
  const d = grid.rows * PITCH
  return [
    [0, 0, 0],
    [w, 0, 0],
    [0, d, 0],
    [w, d, 0],
    // The tallest card, so a standing agent in the far corner is not clipped.
    [0, 0, 22],
    [w, d, 22]
  ]
}

export function slotCentre(index: number, grid: AnatomyGrid): { x: number; y: number } {
  return {
    x: ((index % grid.cols) + 0.5) * PITCH,
    y: (Math.floor(index / grid.cols) + 0.5) * PITCH
  }
}

/* ---------- which card lands in which slot ---------- */

export interface AnatomyClusterInput {
  id: string
  kind: 'terminal' | 'note' | 'browser'
  /** The agent this note or browser is wired to, if any. */
  owner: string | null
}

/**
 * An agent followed by the cards it owns, as one block. The ownership cables
 * are 88% of the board's wiring and the longest of them, and a block keeps
 * them short enough that the picture does not need them drawn at all — which
 * is the whole reason the flat canvas reads as a hairball and this does not.
 *
 * A block that would straddle a row break starts the next row instead, so a
 * crew reads as a crew rather than as a wrapped sentence.
 */
export function orderCards(cards: readonly AnatomyClusterInput[], cols: number): string[] {
  const owned = new Map<string, string[]>()
  const agents: AnatomyClusterInput[] = []
  const loose: AnatomyClusterInput[] = []
  for (const card of cards) {
    if (card.kind === 'terminal') {
      agents.push(card)
      if (!owned.has(card.id)) owned.set(card.id, [])
    }
  }
  for (const card of cards) {
    if (card.kind === 'terminal') continue
    const bucket = card.owner === null ? undefined : owned.get(card.owner)
    if (bucket) bucket.push(card.id)
    else loose.push(card)
  }
  const blocks = agents
    .map((agent) => [agent.id, ...(owned.get(agent.id) ?? [])])
    .sort((a, b) => b.length - a.length)
  if (loose.length > 0) blocks.push(loose.map((card) => card.id))

  const out: string[] = []
  for (const block of blocks) {
    const room = (cols - (out.length % cols)) % cols
    // Only pad when the block would be split AND it could sit whole on a row.
    if (room > 0 && block.length > room && block.length <= cols) {
      for (let i = 0; i < room; i++) out.push('')
    }
    out.push(...block)
  }
  return out
}

/* ---------- cables ---------- */

export interface AnatomyCable {
  a: string
  b: string
  points: Array<[number, number]>
}

/**
 * Agent-to-agent cables routed in the gutters. Each cable leaves its slot
 * through its OWN port along the slot edge, a step further along than the
 * last one: ports shared at a slot's corner make every bundle meet in a knot,
 * which is the fault that spoiled the first drafts of this view.
 */
export function routeCables(
  links: ReadonlyArray<readonly [string, string]>,
  indexOf: (id: string) => number | undefined,
  grid: AnatomyGrid
): AnatomyCable[] {
  const lanes = new Map<string, number>()
  const ports = new Map<string, number>()
  const step = (map: Map<string, number>, key: string): number => {
    const n = map.get(key) ?? 0
    map.set(key, n + 1)
    return n
  }
  const laneOffset = (key: string): number => {
    const k = step(lanes, key) % Math.max(1, Math.floor((GUTTER - 3) / 2.6))
    return (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * 2.6
  }
  const cornersOf = (index: number): Array<[number, number, number, number]> => {
    const c = index % grid.cols
    const r = Math.floor(index / grid.cols)
    return [
      [c, r],
      [c + 1, r],
      [c, r + 1],
      [c + 1, r + 1]
    ].map(([gx, gy]) => [gx * PITCH, gy * PITCH, c, r] as [number, number, number, number])
  }
  const portAt = (
    id: string,
    corner: [number, number, number, number]
  ): [number, number] => {
    const [nx, ny, c, r] = corner
    const k = step(ports, `${id}@${nx},${ny}`)
    const sx = Math.sign((c + 0.5) * PITCH - nx)
    const sy = Math.sign((r + 0.5) * PITCH - ny)
    return [nx + sx * (GUTTER / 2 + 4 + k * 3.2), ny + sy * (GUTTER / 2)]
  }

  const out: AnatomyCable[] = []
  for (const [a, b] of links) {
    const ia = indexOf(a)
    const ib = indexOf(b)
    if (ia === undefined || ib === undefined || ia === ib) continue
    let pick: { d: number; na: [number, number, number, number]; nb: [number, number, number, number] } | null = null
    for (const na of cornersOf(ia)) {
      for (const nb of cornersOf(ib)) {
        const d = Math.abs(na[0] - nb[0]) + Math.abs(na[1] - nb[1])
        if (pick === null || d < pick.d) pick = { d, na, nb }
      }
    }
    if (pick === null) continue
    const pa = portAt(a, pick.na)
    const pb = portAt(b, pick.nb)
    const ya = pick.na[1] + laneOffset(`h${pick.na[1]}`)
    const points: Array<[number, number]> =
      pick.na[1] === pick.nb[1]
        ? [pa, [pa[0], ya], [pb[0], ya], pb]
        : (() => {
            const xb = pick.nb[0] + laneOffset(`v${pick.nb[0]}`)
            const yb = pick.nb[1] + laneOffset(`h${pick.nb[1]}`)
            return [pa, [pa[0], ya], [xb, ya], [xb, yb], [pb[0], yb], pb] as Array<[number, number]>
          })()
    out.push({ a, b, points })
  }
  return out
}

/** A polyline with its corners rounded, in screen space. */
export function roundedPath(points: ReadonlyArray<[number, number]>, radius: number): string {
  if (points.length < 3) return points.length === 0 ? '' : `M${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}`
  const at = (p: readonly [number, number]): string => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`
  let d = `M${at(points[0])}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1
    const k1 = Math.min(radius, l1 / 2) / l1
    const k2 = Math.min(radius, l2 / 2) / l2
    const p1: [number, number] = [b[0] + (a[0] - b[0]) * k1, b[1] + (a[1] - b[1]) * k1]
    const p2: [number, number] = [b[0] + (c[0] - b[0]) * k2, b[1] + (c[1] - b[1]) * k2]
    d += `L${at(p1)}Q${at(b)} ${at(p2)}`
  }
  return `${d}L${at(points[points.length - 1])}`
}
