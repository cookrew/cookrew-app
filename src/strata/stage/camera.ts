// The camera of one level step (motion.html §2). The incoming scene's content
// rect C is fitted into the anchor rect R of the outgoing scene by a uniform
// scale k; a pure scale has exactly one fixed point, the pivot F. The whole
// step is then a single scale about F: the outgoing scene goes 1 → K, the
// incoming one 1/K → 1, and because the incoming is always "outgoing ∘ fit" it
// sits exactly inside the anchor for the whole flight.
import type { Rect } from '../../shared/strata'

export interface Point {
  x: number
  y: number
}

export interface Pivot {
  /** Scale that fits C into R (< 1 for a real "in"). */
  k: number
  /** Growth of the incoming scene, 1/k. */
  K: number
  F: Point
}

/** An outgoing scene pushes the full K up to this; beyond it (an avatar becoming a terminal) the push stops at PUSH_CAP. */
export const FULL_PUSH_MAX = 12
export const PUSH_CAP = 3
/** A step whose scale barely changes has its pivot near infinity: fly a hop instead. */
const MIN_ZOOM = 1.15

export const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export const isUsable = (r: Rect | null | undefined): r is Rect =>
  !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0.5 && r.h > 0.5

/** Pivot and growth for fitting content rect C into anchor rect R, or null when the step cannot be a zoom. */
export const fitPivot = (R: Rect, C: Rect): Pivot | null => {
  if (!isUsable(R) || !isUsable(C)) return null
  const k = Math.min(R.w / C.w, R.h / C.h)
  if (!(k > 0) || 1 / k < MIN_ZOOM) return null
  const rc = centerOf(R)
  const cc = centerOf(C)
  return { k, K: 1 / k, F: { x: (rc.x - k * cc.x) / (1 - k), y: (rc.y - k * cc.y) / (1 - k) } }
}

/** How far the outgoing scene is pushed at the end of the step. */
export const pushOf = (K: number): number => (K <= FULL_PUSH_MAX ? K : PUSH_CAP)

/** Where a point lands after scaling by s about F. */
export const scaleAbout = (F: Point, s: number, p: Point): Point => ({ x: F.x + s * (p.x - F.x), y: F.y + s * (p.y - F.y) })

export const scaleRectAbout = (F: Point, s: number, r: Rect): Rect => {
  const o = scaleAbout(F, s, { x: r.x, y: r.y })
  return { x: o.x, y: o.y, w: r.w * s, h: r.h * s }
}

/** CSS for "scale s about F" with transform-origin 0 0; three functions so keyframes interpolate the pivot exactly. */
export const transformAbout = (F: Point, s: number): string =>
  `translate(${round(F.x)}px, ${round(F.y)}px) scale(${round(s, 5)}) translate(${round(-F.x)}px, ${round(-F.y)}px)`

export const clampInto = (p: Point, r: Rect): Point => ({
  x: Math.min(r.x + r.w, Math.max(r.x, p.x)),
  y: Math.min(r.y + r.h, Math.max(r.y, p.y))
})

/** True when at least `share` of r's area is inside the viewport. */
export const visibleShare = (r: Rect, viewport: Rect): number => {
  const w = Math.max(0, Math.min(r.x + r.w, viewport.x + viewport.w) - Math.max(r.x, viewport.x))
  const h = Math.max(0, Math.min(r.y + r.h, viewport.y + viewport.h) - Math.max(r.y, viewport.y))
  return r.w * r.h > 0 ? (w * h) / (r.w * r.h) : 0
}

const round = (n: number, digits = 2): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
