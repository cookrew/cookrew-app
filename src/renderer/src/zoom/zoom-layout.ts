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
 *             agents step up into a shelf above them, one row in the
 *             troop's form, a page at a time
 */
import { stripPage } from '../pets/pet-dock'

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
/**
 * Where a workspace's newest browser stands beside its agents' stack, and its
 * scale (draft group-motion-pivot.html · NEW_POSE), as the group opens.
 */
export const NEW_POSE = { x: 132, y: 34, s: 1.5 } as const
/** A workspace's mark on the device is its group at this scale. */
export const SWS = 0.62
/**
 * A WORKSPACE'S TILE (owner, 2026-11-04: "how the agents group and the
 * artifacts group show on one page"). One bench: the agents' faces on the left,
 * the artifacts' deck on the right, a name over both, each group its own door.
 * No ring round the faces (owner, 2026-11-04): they stand on the tile. In a
 * mark's units (the group's own, drawn at SWS on the device), around the
 * group's centre, so the open workspace's real faces stand in its tile.
 */
export const TILE = { left: -112, top: -174, w: 430, h: 318 } as const
/** A tile's words on screen at a phone's picks, in px: its name's line over the bench, its counts' under it, and only a margin where it has no counts. */
const TILE_HEAD_PX = { name: 28, caption: 21 }
const TILE_FOOT_PX = { counts: 26, none: 8 }
/** The picks where a phone's tile has room for its counts, and where its name is still set as a name. */
const COUNTS_COLS = 3
/** The width a phone's picks are reckoned at: the words' room is a few px off at any other. */
const PHONE_REF_W = 350
/** What the words stand clear of: the deck, the taller of the two groups, at its deepest. */
export const BENCH = { top: -88, bottom: 60 } as const

/**
 * A tile's frame at a pick: the faces and the deck stay in their places, its
 * words stay one size on screen, so the fewer pixels a mark's unit gets, the
 * more units they take (owner, 2026-11-04: at 3 and 5 to a row the names sat
 * on the groups).
 */
export function tileOf(narrow: boolean, cols: number): { top: number; h: number } {
  if (!narrow || cols <= 2) return { top: TILE.top, h: TILE.h }
  const px = (PHONE_REF_W - 32 - (cols - 1) * 12) / cols / TILE.w
  const head = (cols > COUNTS_COLS ? TILE_HEAD_PX.caption : TILE_HEAD_PX.name) / px
  const foot = (cols > COUNTS_COLS ? TILE_FOOT_PX.none : TILE_FOOT_PX.counts) / px
  return { top: BENCH.top - head, h: BENCH.bottom - BENCH.top + head + foot }
}

/** The deck's centre and scale in the tile: a thumbnail of the artifacts' grid, as large as the ring can stand beside. */
export const DECK_POSE = { x: 194, y: -10, s: 1.08 } as const
/** Where the agents' door ends and the artifacts' begins. */
export const TILE_SPLIT = 98
export const ROW = 175

/** The most faces a fan shows: past them it is a swirl of coins, not people (owner, 2026-11-04). */
const FAN_SHOWN = 6
/** The fan's reach (the agents' door less a face), and its steepest lean. */
const FAN_REACH = 116
const FAN_STEP = 23
const FAN_LEAN = 16
/** A face in the fan, of its size at the crew. */
const FAN_FACE = 1.05

/** The fan of `n` faces, bottom → top: never more than FAN_SHOWN, a face's width apart at most. */
export function fanOf(n: number): (Pos & { s: number; r: number })[] {
  const m = Math.min(n, FAN_SHOWN)
  const mid = (m - 1) / 2
  const step = m > 1 ? Math.min(FAN_STEP, FAN_REACH / (m - 1)) : 0
  const lean = mid > 0 ? Math.min(6, FAN_LEAN / mid) : 0
  return Array.from({ length: m }, (_, i) => {
    const k = i - mid
    return { x: k * step, y: -10 - (mid - Math.abs(k)) * 2.5, s: FAN_FACE, r: k * lean }
  })
}

/** The stack on the tile: drawn bottom → top, the first agent (an orchestrator if there is one) on top; those the fan does not show wait under its first face. */
export function stackOf(agents: readonly CrewAgent[]): Record<string, Pos & { s: number; r: number }> {
  const order = [...agents].reverse()
  const fan = fanOf(order.length)
  const under = order.length - fan.length
  return Object.fromEntries(order.map((a, i) => [a.id, fan[Math.max(0, i - under)]]))
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
/** A crew row: its agents, and empty slots that keep a child under its parent's column. */
export type CrewSlot = CrewAgent | null
/**
 * One row of the crew. Slot c stands at column c - (width - 1) / 2: `width` is
 * the row the slots are aligned to (its parent row's, for children), and slots
 * past it continue to the right (the ones tied to nobody, as the draft's Scout).
 */
export interface CrewRow {
  slots: CrewSlot[]
  width: number
}

const rowOf = (slots: CrewSlot[]): CrewRow => ({ slots, width: slots.length })
/** How far a row reaches from the crew's centre, in columns. */
const reach = (r: CrewRow): number => Math.max((r.width - 1) / 2, r.slots.length - 1 - (r.width - 1) / 2)

/**
 * THE CREW AS A TREE (owner 2026-11-02, the draft group-motion-pivot.html):
 * the leads on top, the agents tied to them in the row below, and each of
 * theirs under them, in their parent's column. The ties are the cables
 * between agents; the ones tied to nobody close the last row.
 *
 * It never takes more rows, nor a wider row, than creation order does (the
 * leads, then everyone else, `cols` to a row): the camera frames the crew, so
 * a taller crew would draw every word smaller. When the tree would, the crew
 * keeps that shape and only takes the tree's order, which still brings tied
 * agents together. Without a lead tied to anyone it is creation order.
 */
export function crewRows(agents: readonly CrewAgent[], ties: readonly { a: string; b: string }[], cols: number): CrewRow[] {
  const chunk = (list: readonly CrewAgent[]): CrewRow[] => {
    const out: CrewRow[] = []
    for (let i = 0; i < list.length; i += cols) out.push(rowOf(list.slice(i, i + cols)))
    return out
  }
  const leads = agents.filter((a) => a.orch)
  const rest = agents.filter((a) => !a.orch)
  const shaped = (order: readonly CrewAgent[]): CrewRow[] => {
    const rows = [...chunk(leads), ...chunk(order)]
    return rows.length ? rows : [rowOf([])]
  }
  const known = new Set(agents.map((a) => a.id))
  const near = new Map<string, string[]>()
  for (const t of ties) {
    if (t.a === t.b || !known.has(t.a) || !known.has(t.b)) continue
    near.set(t.a, [...(near.get(t.a) ?? []), t.b])
    near.set(t.b, [...(near.get(t.b) ?? []), t.a])
  }
  if (!leads.some((l) => (near.get(l.id) ?? []).length > 0)) return shaped(rest)

  const placed = new Set(leads.map((a) => a.id))
  const tree: CrewRow[] = chunk(leads)
  const bfs: CrewAgent[] = []
  let level = tree.slice()
  for (;;) {
    // The level above, in reading order, and each of its agents' slot.
    const order = new Map<string, number>()
    const slotOf = new Map<string, number>()
    level.forEach((row) => row.slots.forEach((a, c) => a && (order.set(a.id, order.size), slotOf.set(a.id, c))))
    const parentOf = (a: CrewAgent): string | null =>
      (near.get(a.id) ?? []).filter((p) => order.has(p)).sort((x, y) => order.get(x)! - order.get(y)!)[0] ?? null
    const kids = rest
      .filter((a) => !placed.has(a.id) && parentOf(a) !== null)
      .map((a, i) => ({ a, p: parentOf(a)!, i }))
      .sort((x, y) => order.get(x.p)! - order.get(y.p)! || x.i - y.i)
    if (kids.length === 0) break
    for (const k of kids) {
      placed.add(k.a.id)
      bfs.push(k.a)
    }
    const above = level.length === 1 ? level[0] : null
    let next: CrewRow[]
    if (above && above.width > 1 && kids.length <= above.width) {
      // Under the parents: each child takes the free slot nearest its parent's.
      const slots: CrewSlot[] = Array.from({ length: above.width }, () => null)
      for (const { a, p } of kids) {
        const want = slotOf.get(p) ?? 0
        const free = [...slots.keys()].filter((c) => slots[c] === null).sort((x, y) => Math.abs(x - want) - Math.abs(y - want) || y - x)[0]
        slots[free] = a
      }
      next = [{ slots, width: above.width }]
    } else next = chunk(kids.map((k) => k.a))
    tree.push(...next)
    level = next
  }
  // Tied to nobody: at the end of the last row while it has room, then rows of their own.
  const loose = rest.filter((a) => !placed.has(a.id))
  const last = tree[tree.length - 1]
  if (last && last !== tree[0] && last.slots.some((a) => a !== null)) {
    // Its filled slots, then as many more as stay within a full row's reach of the centre.
    const filled = last.slots.length - [...last.slots].reverse().findIndex((a) => a !== null)
    const most = Math.floor((cols - 1) / 2 + (last.width - 1) / 2) + 1
    const into = loose.splice(0, Math.max(0, most - filled))
    last.slots = [...last.slots.slice(0, filled), ...into]
  }
  tree.push(...chunk(loose))

  const plain = shaped(rest)
  const fits = tree.length <= plain.length && Math.max(...tree.map(reach)) <= Math.max(...plain.map(reach))
  return fits ? tree : shaped([...bfs, ...rest.filter((a) => !placed.has(a.id))])
}

export function crewOf(
  agents: readonly CrewAgent[],
  narrow: boolean,
  picked?: number,
  ties: readonly { a: string; b: string }[] = []
): { at: Record<string, Pos>; next: Pos; box: Box } {
  const cols = picked ?? defaultCrewCols(narrow)
  const rows = crewRows(agents, ties, cols)
  const at: Record<string, Pos> = {}
  const top = -((rows.length - 1) * ROW) / 2 - 10
  rows.forEach((row, r) => {
    row.slots.forEach((a, c) => {
      if (a) at[a.id] = { x: (c - (row.width - 1) / 2) * COL, y: top + r * ROW }
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
  const lastLen = lastRow.slots.length
  const lastMid = (lastRow.width - 1) / 2
  const next = lastLen < cols
    ? { x: (lastLen - lastMid - 0.5) * COL, y: top + last * ROW }
    : narrow
      ? { x: (-(cols - 1) / 2) * COL, y: top + (last + 1) * ROW }
      : { x: (lastLen - 1 - lastMid + 1) * COL, y: top + last * ROW }
  const wideRow = Math.max(1, ...rows.map((r) => 2 * reach(r) + 1)) + (lastLen < cols ? 1 : 0)
  // Room for the orbiting coins on the right and a card opening down and right.
  return { at, next, box: { w: Math.max(560, wideRow * COL + 360), h: Math.max(420, rows.length * ROW + 300), cy: 40 } }
}

/** The items' grid, most shared first, and the shelf the agents step up into. */
export interface Thumbs {
  order: string[]
  at: Record<string, Pos>
  /** The grid's row pitch in scene px: the view mounts only the rows on screen (ZoomView). */
  rowH: number
  /**
   * The shelf, one row in the troop's form (shelfPage): who stands on it in
   * order, its first face's x and its y, and how many faces a page holds.
   */
  shelf: { order: string[]; left: number; y: number; per: number }
  /** Where the shelf's band is anchored: the workspace's label stands above it (zoom-frame.ts · paint). */
  shelfY: number
  box: Box
}

/** A thumbnail's width (zoom.css · .zv-ip > .zv-th, 168x108). */
const THUMB_W = 168
/** A face on the shelf, in scene px: zoom.css · .zv-av, 64px drawn at the shelf's 0.5. */
export const SHELF_FACE = 32
/**
 * THE SHELF IS THE AGENTS' GROUP (owner, 2026-11-03: "the agents over the
 * artifacts in the agents group's form"): each face lies over the one before
 * it as the troop's do (pets.css · STACKED: 16 of a 28 px face seen), and the
 * "+N" chip stands after the last, the troop's gap away.
 */
export const SHELF_STEP = Math.round((SHELF_FACE * 16) / 28)
export const SHELF_MORE_GAP = 8
/** The faces stand lower than the band's anchor, where their names stood: the label's counts above them stay clear. */
const SHELF_DROP = 30

/**
 * How many faces a page of the shelf holds across `span` scene px: all of
 * them when they fit, else as many as leave room for the "+N" chip (owner,
 * 2026-11-03: "more agents a page, four is too few").
 */
export function shelfPer(count: number, span: number): number {
  const fit = (room: number): number => Math.max(1, Math.floor((room - SHELF_FACE) / SHELF_STEP) + 1)
  return count <= fit(span) ? Math.max(1, count) : fit(span - SHELF_MORE_GAP - SHELF_FACE)
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
  // The shelf: the agents that carry something, then those that carry nothing,
  // from the grid's left edge across its full width.
  const carrying = new Set(items.flatMap((i) => i.owners))
  const linked = agents.filter((a) => carrying.has(a.id))
  const loose = agents.filter((a) => !carrying.has(a.id))
  const span = (cols - 1) * dx + THUMB_W
  const gridH = (rows - 1) * rowH
  return {
    order,
    at,
    rowH,
    shelf: { order: [...linked, ...loose].map((a) => a.id), left: -span / 2 + SHELF_FACE / 2, y: shelfY + SHELF_DROP, per: shelfPer(agents.length, span) },
    shelfY,
    // The box is the grid's: a long shelf turns pages (shelfPage), it never widens the view.
    box: { w: narrow ? 400 : 820, h: gridH + 520, cy: (shelfY - 80 + gridH + 160) / 2 }
  }
}

/** One page of the shelf: each shown face's x, and the "+N" chip (null when every face fits). */
export interface ShelfPage {
  x: Record<string, number>
  more: { x: number; rest: number; last: boolean } | null
}

/**
 * A PAGE OF THE SHELF, as the troop's strip turns one (pets/pet-dock.ts ·
 * stripPage): the same row, the next `per` faces, the chip saying how many
 * are still behind it, and "–" on the last page, back to the first. `page`
 * counts taps on the chip and wraps.
 */
export function shelfPage(shelf: Thumbs['shelf'], page: number): ShelfPage {
  const { start, end, rest, last } = stripPage(shelf.order.length, shelf.per, page)
  const x: Record<string, number> = {}
  shelf.order.slice(start, end).forEach((id, k) => (x[id] = shelf.left + k * SHELF_STEP))
  if (shelf.order.length <= Math.max(1, shelf.per)) return { x, more: null }
  const lastX = shelf.left + (end - start - 1) * SHELF_STEP
  return { x, more: { x: lastX + SHELF_FACE + SHELF_MORE_GAP, rest, last } }
}

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

/** The device's title stands this far over the first row of tiles, and has this room above it (device units). */
const TITLE_GAP = 14
const TITLE_ROOM = { wide: 64, narrow: 46 }
const TILE_GAP = { wide: 32, narrow: 24 }
const FOOT = { wide: 12, narrow: 0 }
const SIDE = { wide: 60, narrow: 0 }

/**
 * The device: a tile per workspace, `cols` to a row (the pick, else the
 * default) in columns from the left, the open one where its slot is. `at` is
 * each ring's place (the mark's origin); `gridTop` and `left` are the tiles'
 * top and left edges; its title ends `titleBottom`, clear of the first row;
 * `screen` holds it at the display's proportions.
 */
export function deviceOf(
  ids: readonly string[],
  narrow: boolean,
  aspect = DEFAULT_SCREEN_ASPECT,
  picked?: number
): { at: Record<string, Pos>; box: Box; screen: Box; titleBottom: number; dx: number; gridTop: number; gridH: number; rowH: number; left: number; tile: { top: number; h: number } } {
  const pick = picked ?? defaultDeviceCols(narrow)
  const cols = Math.max(1, Math.min(pick, ids.length))
  const form = narrow ? 'narrow' : 'wide'
  const tile = tileOf(narrow, cols)
  const tw = SWS * TILE.w
  const th = SWS * tile.h
  const gap = TILE_GAP[form]
  const dx = tw + gap
  const dy = th + gap
  const rows = Math.max(1, Math.ceil(ids.length / cols))
  const gridW = cols * dx - gap
  const gridH = rows * dy - gap
  const left = -gridW / 2
  const gridTop = -gridH / 2
  const at: Record<string, Pos> = {}
  ids.forEach((id, g) => {
    at[id] = { x: left + (g % cols) * dx - SWS * TILE.left, y: gridTop + Math.floor(g / cols) * dy - SWS * tile.top }
  })
  const titleBottom = gridTop - TITLE_GAP
  const top = titleBottom - TITLE_ROOM[form]
  const bottom = -gridTop + FOOT[form]
  const box = { w: gridW + SIDE[form], h: bottom - top, cy: (top + bottom) / 2 }
  return { at, box, screen: screenOf(box, aspect), titleBottom, dx, gridTop, gridH, rowH: dy, left, tile }
}

/** The account's other machines: a row (wrapping) under this Mac's screen (deviceOf · screen), inside the devices camera. */
export const MACHINE_CARD = { w: 380, h: 220, gap: 40 }
/**
 * Room under the machine's screen, in scene units, before the other machines
 * start: its name and its "Remote desktop" pill are drawn there at a thumb's
 * size whatever the camera's scale (zoom-frame.ts · paintDeviceWords), and
 * stood over the first machine without it, on a phone and on a desk alike
 * (owner screenshot, 2026-11-10). A phone's camera draws smaller: more units.
 */
export const LABEL_ROOM = { narrow: 220, desk: 110 } as const

/** The other machines under this one's screen: two a row on a phone, three on a desk. */
export function machinesAt(count: number, screen: Box, narrow: boolean): { at: Pos[]; rows: number; perRow: number; top: number } {
  const perRow = narrow ? 2 : 3
  const rows = Math.ceil(count / perRow)
  const top = screen.h / 2 + 120 + LABEL_ROOM[narrow ? 'narrow' : 'desk']
  const at: Pos[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, count - row * perRow)
    at.push({ x: ((i % perRow) - (inRow - 1) / 2) * (MACHINE_CARD.w + MACHINE_CARD.gap), y: top + row * (MACHINE_CARD.h + MACHINE_CARD.gap) })
  }
  return { at, rows, perRow, top }
}

/** Fit a box into the view, never above natural size. */
export const fitScale = (box: Box, vw: number, vh: number): number => Math.min(1, (vw - 32) / box.w, (vh - 32) / box.h)

/** A thumbnail's tint: steady per id, from the app's warm inks. */
export { hostOf, tintOf } from '../../../shared/item-look'
