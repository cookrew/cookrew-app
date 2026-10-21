// PURE LAYOUTS of the four levels: the same data and viewport always give the
// same rects. A level's miniature inside its parent is that level's own layout
// mapped by one uniform transform (miniatureTransform), so a zoom from the
// miniature lands exactly on the level.
import type { FigureArt, MachineKind, MachineLink, Rect } from '../../shared/strata'
import type { FigureKit } from '../seams'
import { fitTransform, mapRect, type Transform } from './geometry'

/** Smallest hit target an avatar may have before the loupe takes over (px). */
export const MIN_TARGET = { pointer: 24, touch: 44 } as const

/** Room above a figure for attention pins, and below it for its name and status. */
export const PIN_ROOM = 34
export const LABEL_ROOM = 44
/** Under a container: the background chip. */
const CHIP_ROOM = 24
const MAX_MACHINE_SCALE = 2.2
/** Seats never grow past this, so a 2-agent workspace does not become balloons. */
export const MAX_SEAT = 88

// ── L0 machines ─────────────────────────────────────────────────────────────

export interface MachineInput {
  id: string
  kind: MachineKind
  link: MachineLink
}

export interface MachineCell {
  id: string
  art: FigureArt
  /** The figure, in viewport px. */
  rect: Rect
  /** Where its workspaces' miniature sits. */
  portal: Rect
  /** Name + status, under the figure. */
  label: Rect
  /** Pins sit in this strip above the figure. */
  pins: Rect
}

const bestGrid = (count: number, viewport: Rect, fits: (cellW: number, cellH: number) => number) => {
  let best = { cols: 1, rows: count, scale: -Infinity }
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const scale = fits(viewport.w / cols, viewport.h / rows)
    if (scale > best.scale + 1e-9) best = { cols, rows, scale }
  }
  return best
}

export const layoutMachines = (machines: readonly MachineInput[], viewport: Rect, kit: FigureKit): MachineCell[] => {
  if (machines.length === 0) return []
  const arts = machines.map((m) => kit.machine({ kind: m.kind, link: m.link }))
  const maxW = Math.max(...arts.map((a) => a.viewBox.w))
  const maxH = Math.max(...arts.map((a) => a.viewBox.h))
  const gap = 16
  const grid = bestGrid(machines.length, viewport, (cw, ch) =>
    Math.min((cw - gap) / maxW, (ch - gap - PIN_ROOM - LABEL_ROOM) / maxH, MAX_MACHINE_SCALE)
  )
  const scale = Math.max(0.05, grid.scale)
  const cellW = viewport.w / grid.cols
  const cellH = viewport.h / grid.rows
  // The last row is centred when it is short.
  const lastRowCount = machines.length - (grid.rows - 1) * grid.cols
  return machines.map((m, i) => {
    const art = arts[i]
    const row = Math.floor(i / grid.cols)
    const col = i % grid.cols
    const rowOffset = row === grid.rows - 1 ? ((grid.cols - lastRowCount) * cellW) / 2 : 0
    const w = art.viewBox.w * scale
    const h = art.viewBox.h * scale
    const blockH = PIN_ROOM + maxH * scale + LABEL_ROOM
    const cellX = viewport.x + rowOffset + col * cellW
    const cellY = viewport.y + row * cellH
    const top = cellY + (cellH - blockH) / 2 + PIN_ROOM + (maxH * scale - h)
    const rect = { x: cellX + (cellW - w) / 2, y: top, w, h }
    const toView: Transform = { s: scale, dx: rect.x - art.viewBox.x * scale, dy: rect.y - art.viewBox.y * scale }
    const portalArt = art.anchors.portal ?? { x: art.viewBox.x, y: art.viewBox.y, w: art.viewBox.w, h: art.viewBox.h }
    return {
      id: m.id,
      art,
      rect,
      portal: mapRect(portalArt, toView),
      label: { x: cellX + 4, y: rect.y + h + 4, w: cellW - 8, h: LABEL_ROOM - 6 },
      pins: { x: rect.x, y: rect.y - PIN_ROOM, w, h: PIN_ROOM - 4 }
    }
  })
}

// ── L1 workspaces, L2 one workspace ─────────────────────────────────────────

export interface WorkspaceInput {
  id: string
  name: string
  agents: number
}

export type ContainerArt = FigureArt & { archetype: string; capacity: number }

export interface ContainerCell {
  id: string
  art: ContainerArt
  rect: Rect
  /** One per seated agent, in creation order (at most capacity). */
  seats: Rect[]
  tray: Rect | null
  label: Rect | null
  /** Strip above the container for pins. */
  pins: Rect
  /** Viewport px per art unit. */
  scale: number
}

const seatSize = (art: ContainerArt) => art.anchors['slot:0']?.w ?? 32

interface Shelf {
  items: Array<{ index: number; w: number; h: number }>
  w: number
  h: number
}

const shelve = (sizes: Array<{ w: number; h: number }>, width: number, gap: number): Shelf[] => {
  const shelves: Shelf[] = []
  let current: Shelf = { items: [], w: 0, h: 0 }
  sizes.forEach((size, index) => {
    const nextW = current.items.length === 0 ? size.w : current.w + gap + size.w
    if (current.items.length > 0 && nextW > width) {
      shelves.push(current)
      current = { items: [], w: 0, h: 0 }
    }
    current = {
      items: [...current.items, { index, ...size }],
      w: current.items.length === 0 ? size.w : current.w + gap + size.w,
      h: Math.max(current.h, size.h)
    }
  })
  return current.items.length ? [...shelves, current] : shelves
}

const shelvesHeight = (shelves: Shelf[]) => shelves.reduce((sum, s) => sum + PIN_ROOM + s.h + CHIP_ROOM, 0)

/**
 * Containers packed in order on shelves, all at one scale (so seat size is the
 * same across a machine and a container's size shows its crew), the largest
 * scale that fits, capped so a seat stays ≤ maxSeat.
 */
export const layoutWorkspaces = (
  workspaces: readonly WorkspaceInput[],
  viewport: Rect,
  kit: FigureKit,
  opts: { gap?: number; maxSeat?: number } = {}
): ContainerCell[] => {
  if (workspaces.length === 0) return []
  const gap = opts.gap ?? 28
  const arts = workspaces.map((w) => kit.container({ name: w.name, slots: w.agents }))
  const maxScale = (opts.maxSeat ?? MAX_SEAT) / Math.max(...arts.map(seatSize))
  const sizesAt = (s: number) => arts.map((a) => ({ w: a.viewBox.w * s, h: a.viewBox.h * s }))
  const fits = (s: number) => {
    const sizes = sizesAt(s)
    if (sizes.some((size) => size.w > viewport.w)) return false
    return shelvesHeight(shelve(sizes, viewport.w, gap)) <= viewport.h
  }
  let lo = 0.01
  let hi = maxScale
  if (fits(hi)) lo = hi
  else for (let i = 0; i < 30; i++) (fits((lo + hi) / 2) ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2))
  const scale = lo
  const shelves = shelve(sizesAt(scale), viewport.w, gap)
  const cells: ContainerCell[] = []
  let y = viewport.y + (viewport.h - shelvesHeight(shelves)) / 2
  for (const shelf of shelves) {
    let x = viewport.x + (viewport.w - shelf.w) / 2
    for (const item of shelf.items) {
      const art = arts[item.index]
      const rect = { x, y: y + PIN_ROOM + (shelf.h - item.h), w: item.w, h: item.h }
      const toView: Transform = { s: scale, dx: rect.x - art.viewBox.x * scale, dy: rect.y - art.viewBox.y * scale }
      const seated = Math.min(workspaces[item.index].agents, art.capacity)
      cells.push({
        id: workspaces[item.index].id,
        art,
        rect,
        seats: Array.from({ length: seated }, (_, i) => art.anchors[`slot:${i}`]).filter(Boolean).map((r) => mapRect(r, toView)),
        tray: art.anchors.tray ? mapRect(art.anchors.tray, toView) : null,
        label: art.anchors.label ? mapRect(art.anchors.label, toView) : null,
        pins: { x: rect.x, y: rect.y - PIN_ROOM, w: rect.w, h: PIN_ROOM - 4 },
        scale
      })
      x += item.w + gap
    }
    y += PIN_ROOM + shelf.h + CHIP_ROOM
  }
  return cells
}

/** L2: one workspace, as large as it may be. */
export const layoutAgents = (workspace: WorkspaceInput, viewport: Rect, kit: FigureKit): ContainerCell | null =>
  layoutWorkspaces([workspace], viewport, kit, { gap: 0 })[0] ?? null

/**
 * The miniature of a level drawn inside `portal`: the level's own viewport
 * mapped uniformly into it. Apply it to the level's rects for the miniature.
 */
export const miniatureTransform = (levelViewport: Rect, portal: Rect): Transform => fitTransform(levelViewport, portal)

// ── L3 terminal ─────────────────────────────────────────────────────────────

export interface TerminalLayout {
  terminal: Rect
  /** Notes (left) and browsers (right) panels; null when the gutter is too narrow. */
  notes: Rect | null
  browsers: Rect | null
  /** Narrow gutters: vertical tab rails instead of panels. */
  rails: { notes: Rect; browsers: Rect } | null
  /** Phone: everything rides in a sheet raised from a handle. */
  sheet: boolean
}

export const TERMINAL_MAX_W = 880
export const PANEL_MIN_W = 260
const RAIL_W = 36
const PHONE_MAX_W = 600

export const layoutTerminal = (viewport: Rect): TerminalLayout => {
  if (viewport.w < PHONE_MAX_W) return { terminal: viewport, notes: null, browsers: null, rails: null, sheet: true }
  const pad = 12
  const w = Math.min(TERMINAL_MAX_W, viewport.w - 2 * (RAIL_W + pad))
  const x = viewport.x + (viewport.w - w) / 2
  const terminal = { x, y: viewport.y + pad, w, h: viewport.h - 2 * pad }
  const gutter = x - viewport.x - pad
  if (gutter >= PANEL_MIN_W) {
    return {
      terminal,
      notes: { x: viewport.x + pad, y: terminal.y, w: gutter - pad, h: terminal.h },
      browsers: { x: x + w + pad, y: terminal.y, w: gutter - pad, h: terminal.h },
      rails: null,
      sheet: false
    }
  }
  return {
    terminal,
    notes: null,
    browsers: null,
    rails: {
      notes: { x: viewport.x + pad / 2, y: terminal.y, w: RAIL_W, h: terminal.h },
      browsers: { x: viewport.x + viewport.w - pad / 2 - RAIL_W, y: terminal.y, w: RAIL_W, h: terminal.h }
    },
    sheet: false
  }
}

// ── the attachment fan ──────────────────────────────────────────────────────

export interface FanCard {
  /** Index into the attachment list, or 'more' for the +N card. */
  item: number | 'more'
  /** Card centre and its tilt, relative to the avatar centre. */
  x: number
  y: number
  angle: number
}

/** Connection order, never sorted; past `cap` the last card is "+N". */
export const fanLayout = (count: number, cap: number, radius: number): { cards: FanCard[]; more: number } => {
  if (count === 0) return { cards: [], more: 0 }
  const shown = count > cap ? cap - 1 : count
  const total = count > cap ? cap : count
  const spread = Math.min(150, 28 * total)
  const cards = Array.from({ length: total }, (_, i): FanCard => {
    const deg = total === 1 ? 0 : -spread / 2 + (spread * i) / (total - 1)
    const rad = (deg * Math.PI) / 180
    return { item: i < shown ? i : 'more', x: Math.sin(rad) * radius, y: -Math.cos(rad) * radius, angle: deg }
  })
  return { cards, more: count - shown }
}
