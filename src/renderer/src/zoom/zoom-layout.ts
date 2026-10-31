/**
 * WHERE EVERYTHING STANDS at each level of the zoom (zoom-path.ts), in scene
 * units around the workspace's centre. Pure: the frame loop in ZoomView.tsx
 * blends between these places by the path value, and the tests pin them.
 *
 *   device  — every workspace on this machine, a mark each, in a grid
 *   group   — the open workspace's agents as one stack in a ring
 *   crew    — its agents in rows, the orchestrators on top (the app keeps no
 *             lead/member relation, so there is no tree to draw)
 *   thumbs  — its browsers and notes in a grid, the most shared first; the
 *             agents step up into a shelf above them
 */

export interface Pos {
  x: number
  y: number
}
export interface Box {
  w: number
  h: number
  cy: number
}

export interface CrewAgent {
  id: string
  orch: boolean
}
export interface CrewItem {
  id: string
  owners: readonly string[]
}

const COL = 200
const ROW = 175

/** The stack in the ring: drawn bottom → top, the first agent (an orchestrator if there is one) on top. */
export function stackOf(agents: readonly CrewAgent[]): Record<string, Pos & { s: number; r: number }> {
  const order = [...agents].reverse()
  const mid = (order.length - 1) / 2
  const out: Record<string, Pos & { s: number; r: number }> = {}
  const step = order.length > 9 ? 72 / order.length : 8
  order.forEach((a, i) => {
    const k = i - mid
    out[a.id] = { x: k * step, y: -10 - (mid - Math.abs(k)) * 2.5, s: 0.84, r: k * 6 }
  })
  return out
}

/** Orchestrators first, then the rest in their given order. */
export const crewOrder = (agents: readonly CrewAgent[]): CrewAgent[] => [...agents.filter((a) => a.orch), ...agents.filter((a) => !a.orch)]

/** The crew: orchestrators in a row on top, everyone else in rows under them. */
export function crewOf(agents: readonly CrewAgent[], narrow: boolean): { at: Record<string, Pos>; next: Pos; box: Box } {
  // Two on a phone: three at 200px apart drew every face at 0.4 (owner, 2026-11-01).
  const cols = narrow ? 2 : 5
  const leads = agents.filter((a) => a.orch)
  const rest = agents.filter((a) => !a.orch)
  const rows: CrewAgent[][] = []
  if (leads.length) for (let i = 0; i < leads.length; i += cols) rows.push(leads.slice(i, i + cols))
  for (let i = 0; i < rest.length; i += cols) rows.push(rest.slice(i, i + cols))
  if (rows.length === 0) rows.push([])
  const at: Record<string, Pos> = {}
  const top = -((rows.length - 1) * ROW) / 2 - 10
  rows.forEach((row, r) => {
    row.forEach((a, c) => {
      at[a.id] = { x: (c - (row.length - 1) / 2) * COL, y: top + r * ROW }
    })
  })
  // A seat at the end of the crew, for the agent that is not there yet: it is
  // how one is made when there is no canvas to click on (owner, 2026-10-31).
  const last = rows.length - 1
  const lastRow = rows[last]
  // On a phone a full last row sends the seat to a row of its own, under the
  // first column: beside the row it stood in a third column, and the phone's
  // camera, which frames every seat, drew the crew small and off-centre (Gauge,
  // 2026-11-01: 15 agents at 0.64, centred on x=139 of 412).
  const next = lastRow.length < cols
    ? { x: (lastRow.length - (lastRow.length - 1) / 2 - 0.5) * COL, y: top + last * ROW }
    : narrow
      ? { x: (-(cols - 1) / 2) * COL, y: top + (last + 1) * ROW }
      : { x: ((lastRow.length - 1) / 2 + 1) * COL, y: top + last * ROW }
  const wideRow = Math.max(1, ...rows.map((r) => r.length)) + (lastRow.length < cols ? 1 : 0)
  // Room for the orbiting coins on the right and a card opening down and right.
  return { at, next, box: { w: Math.max(560, wideRow * COL + 360), h: Math.max(420, rows.length * ROW + 300), cy: 40 } }
}

/** The items' grid, most shared first, and the shelf the agents step up into. */
export function thumbsOf(
  items: readonly CrewItem[],
  agents: readonly CrewAgent[],
  narrow: boolean
): { order: string[]; at: Record<string, Pos>; shelf: Record<string, Pos>; box: Box; shelfY: number } {
  const order = [...items].sort((a, b) => b.owners.length - a.owners.length).map((i) => i.id)
  const cols = narrow ? 2 : 3
  const dx = narrow ? 200 : 230
  const rowH = narrow ? 196 : 190
  const rows = Math.max(1, Math.ceil(order.length / cols))
  const at: Record<string, Pos> = {}
  order.forEach((id, g) => {
    const row = Math.floor(g / cols)
    const inRow = Math.min(cols, order.length - row * cols)
    at[id] = { x: ((g % cols) - (inRow - 1) / 2) * dx, y: row * rowH }
  })
  const shelfY = -170
  // The shelf: the agents that carry something, then a gap, then those that carry nothing.
  const carrying = new Set(items.flatMap((i) => i.owners))
  const linked = agents.filter((a) => carrying.has(a.id))
  const loose = agents.filter((a) => !carrying.has(a.id))
  if (narrow) return { order, at, ...phoneShelf([...linked, ...loose], rows, rowH, shelfY) }
  const step = Math.min(80, 900 / Math.max(1, agents.length))
  const slots = linked.length + (loose.length ? 0.6 + loose.length : 0)
  const shelf: Record<string, Pos> = {}
  linked.forEach((a, i) => (shelf[a.id] = { x: (i - (slots - 1) / 2) * step, y: shelfY }))
  loose.forEach((a, i) => (shelf[a.id] = { x: (linked.length + 0.6 + i - (slots - 1) / 2) * step, y: shelfY }))
  const gridH = (rows - 1) * rowH
  return {
    order,
    at,
    shelf,
    shelfY,
    box: { w: Math.max(820, slots * step + 120), h: gridH + 520, cy: (shelfY - 80 + gridH + 160) / 2 }
  }
}

/** A phone's shelf: rows of SHELF_PER_ROW, a name's width apart (zoom.css caps a phone's names at 112px, 87 at the shelf's 0.78), stacked up from the grid (2026-11-01 phone evals). */
const SHELF_PER_ROW = 4
const SHELF_DX = 88
const SHELF_DY = 68
function phoneShelf(agents: readonly CrewAgent[], rows: number, rowH: number, bottomY: number): { shelf: Record<string, Pos>; shelfY: number; box: Box } {
  const shelfRows = Math.max(1, Math.ceil(agents.length / SHELF_PER_ROW))
  const shelfY = bottomY - (shelfRows - 1) * SHELF_DY
  const shelf: Record<string, Pos> = {}
  agents.forEach((a, k) => {
    const row = Math.floor(k / SHELF_PER_ROW)
    const inRow = Math.min(SHELF_PER_ROW, agents.length - row * SHELF_PER_ROW)
    shelf[a.id] = { x: ((k % SHELF_PER_ROW) - (inRow - 1) / 2) * SHELF_DX, y: shelfY + row * SHELF_DY }
  })
  const gridH = (rows - 1) * rowH
  return { shelf, shelfY, box: { w: 400, h: gridH + 520 + (bottomY - shelfY), cy: (shelfY - 80 + gridH + 160) / 2 } }
}

/** The device: a mark per workspace, the open one where its slot is. */
export function deviceOf(ids: readonly string[], narrow: boolean): { at: Record<string, Pos>; box: Box; labelY: number; dx: number } {
  const cols = narrow ? 2 : 3
  const dx = narrow ? 260 : 330
  const dy = narrow ? 260 : 320
  const rows = Math.max(1, Math.ceil(ids.length / cols))
  const at: Record<string, Pos> = {}
  ids.forEach((id, g) => {
    const row = Math.floor(g / cols)
    const inRow = Math.min(cols, ids.length - row * cols)
    at[id] = { x: ((g % cols) - (inRow - 1) / 2) * dx, y: (row - (rows - 1) / 2) * dy }
  })
  const h = rows * dy + 120
  return { at, box: { w: Math.max(cols, Math.min(cols, ids.length)) * dx + 120, h, cy: -20 }, labelY: -((rows - 1) / 2) * dy - 200, dx }
}

/** The account's other machines: a row (wrapping) under this Mac's screen, inside the devices camera. */
export const MACHINE_CARD = { w: 380, h: 220, gap: 40 }
export function machinesAt(count: number, device: Box, narrow: boolean): { at: Pos[]; rows: number } {
  const perRow = narrow ? 1 : 3
  const rows = Math.ceil(count / perRow)
  const top = device.h / 2 + 120
  const at: Pos[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, count - row * perRow)
    at.push({ x: ((i % perRow) - (inRow - 1) / 2) * (MACHINE_CARD.w + MACHINE_CARD.gap), y: top + row * (MACHINE_CARD.h + MACHINE_CARD.gap) })
  }
  return { at, rows }
}

/** Fit a box into the view, never above natural size. */
export const fitScale = (box: Box, vw: number, vh: number): number => Math.min(1, (vw - 32) / box.w, (vh - 32) / box.h)

/** A thumbnail's tint: steady per id, from the app's warm inks. */
const TINTS = ['#6f8a5c', '#5d6b7a', '#7d6a9a', '#4f7f7a', '#a8692b', '#7a5c8a', '#8a6a4f']
export function tintOf(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]
}

/** A browser's host for its little address bar ("github.com/cookrew"); a bare word stays as it is. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return `file://${u.pathname.split('/').slice(-2, -1)[0] ?? ''}`
    return `${u.host}${u.pathname === '/' ? '' : u.pathname.split('/').slice(0, 2).join('/')}`
  } catch {
    return url
  }
}
