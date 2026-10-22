// Cheap strokes for the table and its props. A container is inlined many
// times per page (every workspace, every miniature), so each part is drawn in
// as few elements as reads right: a face's fill and its fine ink share one
// element (fine ink never wobbles anyway), a thin rod is two strokes.
import type { V3 } from '../iso/geom'
import { num, type Pen } from '../iso/pen'
import { INK, tone, type Mat, type Shade } from '../iso/tone'

/** A filled face with its own fine ink, as one element. */
export const flat = (p: Pen, pts: readonly V3[], fill: string, w = 0.9): string =>
  `<path d="${p.d3(pts)}" fill="${fill}"${w ? ` stroke="${INK}" stroke-width="${num(w * p.spec.k)}"` : ''}/>`

/** Many faces of one colour as one element. */
export const flats = (p: Pen, faces: ReadonlyArray<readonly V3[]>, fill: string, w = 0.9): string =>
  faces.length === 0 ? '' : `<path d="${faces.map((f) => p.d3(f)).join('')}" fill="${fill}"${w ? ` stroke="${INK}" stroke-width="${num(w * p.spec.k)}"` : ''}/>`

/** Fine ink lines (open), all in one element. */
export const lines = (p: Pen, runs: ReadonlyArray<readonly V3[]>, w = 0.7, colour = INK): string =>
  runs.length === 0 ? '' : `<path d="${runs.map((r) => p.d3(r, false)).join('')}" stroke="${colour}" stroke-width="${num(w * p.spec.k)}"/>`

/** The three visible faces of an axis-aligned box (left side, front, top). */
export const boxFaces = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Array<[V3, V3[]]> => [
  [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
  [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
  [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]]
]

/** A box in three elements. */
export const solid = (p: Pen, b: readonly [number, number, number, number, number, number], m: Mat, w = 0.9, shade: Shade = tone): string =>
  boxFaces(...b)
    .map(([n, q]) => flat(p, q, shade(n, m), w))
    .join('')

/** A thin rod (a handle, an arm, a pencil) as an inked stroke: round caps come from the root. */
export const stick = (p: Pen, pts: readonly V3[], r: number, m: Mat, w = 1.4): string => {
  const d = p.d3(pts, false)
  const width = 2 * r * p.spec.s
  return `<path d="${d}" stroke="${INK}" stroke-width="${num(width + w * p.spec.k)}"/><path d="${d}" stroke="${m.m}" stroke-width="${num(width)}"/>`
}

/** A pipe: a stick with a light streak along it. */
export const pipe = (p: Pen, pts: readonly V3[], r: number, m: Mat): string => {
  const width = 2 * r * p.spec.s
  const lift = p.d2(pts.map((q) => p.P(q)).map(([x, y]) => [x - width * 0.18, y - width * 0.18] as const), false)
  return stick(p, pts, r, m, 1.6) + `<path d="${lift}" stroke="${m.l}" stroke-width="${num(width * 0.32)}"/>`
}
