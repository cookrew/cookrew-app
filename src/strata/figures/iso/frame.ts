// Framing: put a model into a viewBox and wrap the drawing as FigureArt.
//   fit mode    a fixed viewBox (machines, avatars): the model is scaled to fill it
//   scale mode  a fixed scale (containers): the viewBox grows with the model, so
//               every container shares one unit and avatars stay the same size
// Cast shadows are part of the bounds: an inline <svg> clips its overflow.
import type { FigureArt, Rect } from '../../../shared/strata'
import { hull, type V3 } from './geom'
import { isoRaw, makePen, num, type Pen } from './pen'
import { INK, SH } from './tone'

export interface FrameBase {
  /** Model points that must be in view (box corners, tips). */
  fit: readonly V3[]
  /** Also keep their cast shadows on this plane in view; null = no shadow. */
  shadowZ?: number | null
  /** Margin in viewBox units. */
  pad?: number
  k?: number
  wob?: number
  seed?: number
  ghost?: boolean
  wobStep?: number
}
export interface FitFrame extends FrameBase {
  vw: number
  vh: number
  /** Where the model sits vertically when it is wider than tall. */
  valign?: 'middle' | 'bottom'
}
export interface ScaleFrame extends FrameBase {
  scale: number
}

const rawBounds = (o: FrameBase) => {
  const pts = o.fit.flatMap((p) => {
    const at = isoRaw(p)
    if (o.shadowZ === null || o.shadowZ === undefined) return [at]
    const z0 = o.shadowZ
    return [at, isoRaw([p[0] + (p[2] - z0) * SH[0], p[1] + (p[2] - z0) * SH[1], z0])]
  })
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

export interface Framed {
  pen: Pen
  vw: number
  vh: number
}

export const frameFit = (o: FitFrame): Framed => {
  const b = rawBounds(o)
  const pad = o.pad ?? 4
  const bw = b.x1 - b.x0 || 1
  const bh = b.y1 - b.y0 || 1
  const s = Math.min((o.vw - 2 * pad) / bw, (o.vh - 2 * pad) / bh)
  const ox = (o.vw - bw * s) / 2 - b.x0 * s
  const free = o.vh - 2 * pad - bh * s
  const oy = pad + (o.valign === 'bottom' ? free : free / 2) - b.y0 * s
  const pen = makePen({ s, ox, oy, k: o.k ?? 1, vw: o.vw, wob: o.wob ?? 0, seed: o.seed ?? 0, ghost: o.ghost, wobStep: o.wobStep })
  return { pen, vw: o.vw, vh: o.vh }
}

export const frameScale = (o: ScaleFrame): Framed => {
  const b = rawBounds(o)
  const pad = o.pad ?? 4
  const s = o.scale
  const vw = Math.ceil((b.x1 - b.x0) * s + 2 * pad)
  const vh = Math.ceil((b.y1 - b.y0) * s + 2 * pad)
  const pen = makePen({ s, ox: pad - b.x0 * s, oy: pad - b.y0 * s, k: o.k ?? 1, vw, wob: o.wob ?? 0, seed: o.seed ?? 0, ghost: o.ghost, wobStep: o.wobStep })
  return { pen, vw, vh }
}

const roundRect = (r: Rect): Rect => ({ x: +num(r.x), y: +num(r.y), w: +num(r.w), h: +num(r.h) })

/**
 * The root sets what most paths share: no fill, round ink, the font, and
 * color = INK for the silhouette (currentColor). Override `color` on `.cf` to
 * re-ink silhouettes for a dark page; nothing else in a figure reads it.
 */
export const finish = (f: Framed, body: string, anchors: Readonly<Record<string, Rect>> = {}): FigureArt => ({
  svg:
    `<svg xmlns="http://www.w3.org/2000/svg" class="cf" viewBox="0 0 ${f.vw} ${f.vh}" fill="none" ` +
    `stroke-linecap="round" stroke-linejoin="round" font-family="ui-monospace,Menlo,monospace" color="${INK}">${body}</svg>`,
  viewBox: { x: 0, y: 0, w: f.vw, h: f.vh },
  anchors: Object.fromEntries(Object.entries(anchors).map(([k, r]) => [k, roundRect(r)]))
})

/** Screen hull of model points, for hit-shapes and tests. */
export const screenHull = (pen: Pen, pts: readonly V3[]) => hull(pts.map(pen.P))
