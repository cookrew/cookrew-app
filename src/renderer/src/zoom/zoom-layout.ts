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
 *             agents step up into a shelf above them, one row
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

/** The crew's column and row pitch, in scene px (scene-words.ts reads them to fit the words under a face). */
export const COL = 200
export const ROW = 175

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

/**
 * Agents per row the owner can pick (owner, 2026-11-01: "a row of 3, 4 or 5
 * columns to choose from"). A phone keeps 2 among them: it is its default.
 */
export const CREW_COLS = { wide: [3, 4, 5], narrow: [2, 3, 4, 5] } as const

/** Two on a phone: three at 200px apart drew every face at 0.4 (owner, 2026-11-01). */
export const defaultCrewCols = (narrow: boolean): number => (narrow ? 2 : 5)

/** The crew: orchestrators in a row on top, everyone else in rows under them, `cols` to a row (the pick, else the default). */
export function crewOf(agents: readonly CrewAgent[], narrow: boolean, picked?: number): { at: Record<string, Pos>; next: Pos; box: Box } {
  const cols = picked ?? defaultCrewCols(narrow)
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
export interface Thumbs {
  order: string[]
  at: Record<string, Pos>
  /** The grid's row pitch in scene px: the view mounts only the rows on screen (ZoomView). */
  rowH: number
  /** The shelf, one row: who stands on it in order, and where the ones that carry nothing start (shelfRow places them). */
  shelf: { order: string[]; looseFrom: number }
  shelfY: number
  box: Box
}

export function thumbsOf(items: readonly CrewItem[], agents: readonly CrewAgent[], narrow: boolean): Thumbs {
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
  const gridH = (rows - 1) * rowH
  return {
    order,
    at,
    rowH,
    shelf: { order: [...linked, ...loose].map((a) => a.id), looseFrom: linked.length },
    shelfY,
    // The box is the grid's: a long shelf scrolls sideways (zoom-frame.ts · shelfFrame), it never widens the view.
    box: { w: narrow ? 400 : 820, h: gridH + 520, cy: (shelfY - 80 + gridH + 160) / 2 }
  }
}

/** A phone's name on the shelf is cut to fit this pitch (scene-words.ts · nameMax: zoom.css caps it at 112px, 87 at the shelf's 0.78). */
export const SHELF_DX = 88
/** A face's room on the shelf (zoom.css · .zv-av, 64px drawn at the shelf's 0.5, plus air), and the air between two names. */
export const SHELF_FACE = 44
export const SHELF_GAP = 20
/** More air before the agents that carry nothing. */
const SHELF_LOOSE_GAP = 36

/**
 * THE SHELF IS ONE ROW (owner, 2026-11-02: the agents over the artifacts in a
 * single row that scrolls sideways; packed into 900px, 21 names ran into each
 * other). Each agent takes its own name's width as drawn on the shelf
 * (`width`, scene px), at least a face's, so no two names touch. The row is
 * centred on 0; `w` is its whole length.
 */
export function shelfRow(shelf: Thumbs['shelf'], width: (id: string) => number): { x: Record<string, number>; slot: Record<string, number>; w: number } {
  const slots = shelf.order.map((id, i) => ({
    id,
    w: Math.max(SHELF_FACE, width(id) || 0),
    before: i === 0 ? 0 : SHELF_GAP + (i === shelf.looseFrom ? SHELF_LOOSE_GAP : 0)
  }))
  const total = slots.reduce((sum, k) => sum + k.before + k.w, 0)
  const centres = slots.reduce<{ left: number; at: [string, number][] }>(
    (acc, k) => ({ left: acc.left + k.before + k.w, at: [...acc.at, [k.id, acc.left + k.before + k.w / 2]] }),
    { left: -total / 2, at: [] }
  )
  return { x: Object.fromEntries(centres.at), slot: Object.fromEntries(slots.map((k) => [k.id, k.w])), w: total }
}

/** How far a mark's tile (its wash, zoom-frame.ts · SWS) reaches above its centre on the device. */
const TILE_TOP = 100
/**
 * Room kept over the first row for the machine's name and hint, which grow to
 * be read and wrap (zoom-frame.ts · deviceWords): on a phone up to four lines
 * at ~1.7x (Gauge, 2026-11-01: the hint's second line ran into the first tile).
 */
const TITLE_ROOM = { wide: 100, narrow: 180 }

/** A machine's screen when its display is not known: a MacBook's 16:10. */
export const DEFAULT_SCREEN_ASPECT = 16 / 10

/** A display's width over its height, kept to shapes a screen has (a portrait monitor down to 0.4, an ultrawide up to 4). */
export function screenAspectOf(display: { w: number; h: number } | null | undefined): number {
  if (!display || !(display.w > 0) || !(display.h > 0)) return DEFAULT_SCREEN_ASPECT
  return Math.min(4, Math.max(0.4, display.w / display.h))
}

/**
 * THE MACHINE'S SCREEN around the device view: the view's box grown, about
 * the same centre, to the real display's proportions (owner, 2026-11-01: the
 * screen drew as tall as its grid of workspaces, near square, on a 16:10 Mac).
 * The camera at the device stop still frames the view alone.
 */
export function screenOf(box: Box, aspect: number): Box {
  return box.w / box.h < aspect ? { ...box, w: box.h * aspect } : { ...box, h: box.w / aspect }
}

/**
 * Workspaces per row on the device: the same pick as the crew's (owner,
 * 2026-11-01: "per row 3 4 5 at the workspaces view too"), remembered apart
 * from it. Unpicked, the device keeps its old 2 on a phone and 3 on a desk.
 */
export const DEVICE_COLS = CREW_COLS
export const defaultDeviceCols = (narrow: boolean): number => (narrow ? 2 : 3)

/** The device: a mark per workspace, `cols` to a row (the pick, else the default), the open one where its slot is; its title ends `titleBottom`, clear of the first row's tiles; `screen` holds it at the display's proportions. */
export function deviceOf(
  ids: readonly string[],
  narrow: boolean,
  aspect = DEFAULT_SCREEN_ASPECT,
  picked?: number
): { at: Record<string, Pos>; box: Box; screen: Box; titleBottom: number; dx: number } {
  const cols = picked ?? defaultDeviceCols(narrow)
  const dx = narrow ? 260 : 330
  const dy = narrow ? 260 : 320
  const rows = Math.max(1, Math.ceil(ids.length / cols))
  const at: Record<string, Pos> = {}
  ids.forEach((id, g) => {
    const row = Math.floor(g / cols)
    const inRow = Math.min(cols, ids.length - row * cols)
    at[id] = { x: ((g % cols) - (inRow - 1) / 2) * dx, y: (row - (rows - 1) / 2) * dy }
  })
  const titleBottom = -((rows - 1) / 2) * dy - TILE_TOP - 14
  const bottom = -20 + (rows * dy + 120) / 2
  const top = Math.min(-20 - (rows * dy + 120) / 2, titleBottom - (narrow ? TITLE_ROOM.narrow : TITLE_ROOM.wide))
  const box = { w: cols * dx + 120, h: bottom - top, cy: (top + bottom) / 2 }
  return { at, box, screen: screenOf(box, aspect), titleBottom, dx }
}

/** The account's other machines: a row (wrapping) under this Mac's screen (deviceOf · screen), inside the devices camera. */
export const MACHINE_CARD = { w: 380, h: 220, gap: 40 }
export function machinesAt(count: number, screen: Box, narrow: boolean): { at: Pos[]; rows: number } {
  const perRow = narrow ? 1 : 3
  const rows = Math.ceil(count / perRow)
  const top = screen.h / 2 + 120
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
