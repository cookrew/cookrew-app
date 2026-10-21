// PROTOTYPE layouts: pure (same data + viewport → same rects), so a level's
// miniature inside its parent is the level itself scaled down and the camera
// lands exactly on it. Placeholder for the levels lane's real layouts.
import type { FigureArt, Rect } from '../../../shared/strata'

export interface Viewport {
  w: number
  h: number
}

export const phoneSized = (v: Viewport): boolean => v.w < 700

/** Room the screen-fixed crumbs take at the top of every level. */
const TOP = 76

const fit = (art: Rect, box: Rect, maxScale = Infinity): Rect => {
  const s = Math.min(box.w / art.w, box.h / art.h, maxScale)
  const w = art.w * s
  const h = art.h * s
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/** A child rect given in a figure's viewBox units, placed where the figure is drawn. */
export const placeAnchor = (figure: Rect, art: FigureArt, anchor: Rect): Rect => {
  const s = figure.w / art.viewBox.w
  return { x: figure.x + (anchor.x - art.viewBox.x) * s, y: figure.y + (anchor.y - art.viewBox.y) * s, w: anchor.w * s, h: anchor.h * s }
}

/** Level 0: machine figures in a grid, a name line under each. */
export const machinesLayout = (count: number, aspect: number, v: Viewport): Rect[] => {
  const phone = phoneSized(v)
  const cols = v.w >= 1100 ? 4 : v.w >= 700 ? 3 : 2
  const side = phone ? 14 : 40
  const gap = phone ? 14 : 36
  const label = 40
  const cellW = Math.min(300, (v.w - 2 * side - (cols - 1) * gap) / cols)
  const figH = cellW / aspect
  const rowH = figH + label + gap
  const gridW = cols * cellW + (cols - 1) * gap
  const x0 = (v.w - gridW) / 2
  const rows = Math.ceil(count / cols)
  const gridH = rows * rowH - gap
  const y0 = TOP + 28 + Math.max(0, (v.h - TOP - 28 - gridH) / 2.4)
  return Array.from({ length: count }, (_, i) => ({ x: x0 + (i % cols) * (cellW + gap), y: y0 + Math.floor(i / cols) * rowH, w: cellW, h: figH }))
}

/** Level 1: one container per workspace, contain-fit into its cell. */
export const workspacesLayout = (arts: Rect[], v: Viewport): Rect[] => {
  const n = arts.length
  if (n === 0) return []
  const phone = phoneSized(v)
  const cols = phone ? 1 : Math.min(n, v.w >= 1100 ? 3 : 2)
  const side = phone ? 14 : 48
  const gap = phone ? 18 : 40
  const rows = Math.ceil(n / cols)
  const availW = v.w - 2 * side
  const availH = v.h - TOP - 40
  const cellW = (availW - (cols - 1) * gap) / cols
  const fitsRows = phone ? Math.min(rows, 2) : rows
  const cellH = Math.max(160, (availH - (fitsRows - 1) * gap) / fitsRows)
  return arts.map((art, i) =>
    fit(art, { x: side + (i % cols) * (cellW + gap), y: TOP + 16 + Math.floor(i / cols) * (cellH + gap), w: cellW, h: cellH - 26 }, 2.4)
  )
}

/** Level 2: the one container, big. */
export const agentsLayout = (art: Rect, v: Viewport): Rect => {
  const side = phoneSized(v) ? 10 : 56
  return fit(art, { x: side, y: TOP + 8, w: v.w - 2 * side, h: v.h - TOP - 48 }, 3.2)
}

export interface TerminalLayout {
  terminal: Rect
  notes: Rect | null
  browsers: Rect | null
  /** Phone: the strip of note and browser tabs above the terminal. */
  strip: Rect | null
}

/** Level 3: the terminal untouched in the middle, notes left and browsers right in the free space. */
export const terminalLayout = (v: Viewport): TerminalLayout => {
  if (phoneSized(v)) {
    const strip = { x: 8, y: TOP - 8, w: v.w - 16, h: 34 }
    return { terminal: { x: 0, y: strip.y + strip.h + 6, w: v.w, h: v.h - strip.y - strip.h - 6 }, notes: null, browsers: null, strip }
  }
  const side = Math.min(320, Math.max(200, v.w * 0.2))
  const gap = 16
  const top = TOP - 12
  const termW = v.w - 2 * side - 4 * gap
  return {
    terminal: { x: side + 2 * gap, y: top, w: termW, h: v.h - top - gap },
    notes: { x: gap, y: top, w: side, h: v.h - top - gap },
    browsers: { x: v.w - side - gap, y: top, w: side, h: v.h - top - gap },
    strip: null
  }
}
