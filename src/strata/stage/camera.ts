// The camera of one level step (motion.html §2). The incoming scene's content
// rect C is fitted into the anchor rect R of the outgoing scene by a uniform
// scale k (K = 1/k). The outgoing scene is carried by a similarity that takes
// R onto C; the incoming one is always "outgoing ∘ fit", so it sits exactly
// inside the anchor for the whole flight. Zoom runs in log space, and the
// anchor's centre travels R_c → C_c with w(v) = (K^v − 1)/(K − 1): for K > 1
// that is a single scale about one fixed point (the pivot), and as K → 1 it
// becomes a plain pan (a phone's full-width container lands on itself).
import type { Rect } from '../../shared/strata'

export interface Point {
  x: number
  y: number
}

/** x' = s·x + d, with transform-origin 0 0. */
export interface Similarity {
  s: number
  d: Point
}

export interface Fit {
  /** Scale that fits C into R. */
  k: number
  /** Growth of the incoming scene, 1/k. */
  K: number
  /** R's centre (in the outgoing scene) and C's centre (in the incoming one). */
  from: Point
  to: Point
}

/** How far the agents level is pushed while a terminal opens out of an avatar. */
export const PUSH_CAP = 3
/** Outside this growth the step is no zoom at all: fly a hop. */
const MIN_K = 0.6
const MAX_K = 400
const NEAR_ONE = 1e-3

export const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export const isUsable = (r: Rect | null | undefined): r is Rect =>
  !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0.5 && r.h > 0.5

/** The step from anchor R to content C (contain-fit, centred), or null when it cannot be flown. */
export const fitStep = (R: Rect, C: Rect): Fit | null => {
  if (!isUsable(R) || !isUsable(C)) return null
  const k = Math.min(R.w / C.w, R.h / C.h)
  const K = 1 / k
  if (!(K >= MIN_K && K <= MAX_K)) return null
  return { k, K, from: centerOf(R), to: centerOf(C) }
}

/**
 * How far the outgoing scene is pushed at the end of the step. A nested level
 * is pushed the full K, so the incoming one stays exactly inside the anchor.
 * The terminal is not a nested level but a window opening out of the avatar:
 * pushing the agents level ~10× would balloon the avatars around it, so the
 * level behind only recedes to PUSH_CAP while the terminal grows the full K.
 */
export const pushOf = (K: number, opens: boolean): number => (opens ? Math.min(K, PUSH_CAP) : K)

/** Share of the R_c → C_c journey made when the outgoing scene is at scale s (the full step is s = K). */
const travelled = (fit: Fit, s: number, v: number): number => (Math.abs(fit.K - 1) < NEAR_ONE ? v : (s - 1) / (fit.K - 1))

const along = (fit: Fit, w: number): Point => ({ x: fit.from.x + w * (fit.to.x - fit.from.x), y: fit.from.y + w * (fit.to.y - fit.from.y) })

/** The outgoing scene at step progress v, pushed to `push` at v = 1. */
export const outgoingAt = (fit: Fit, push: number, v: number): Similarity => {
  const s = Math.pow(push, v)
  const c = along(fit, travelled(fit, s, v))
  return { s, d: { x: c.x - s * fit.from.x, y: c.y - s * fit.from.y } }
}

/** The incoming scene at step progress v: the full-K outgoing camera composed with the fit. */
export const incomingAt = (fit: Fit, v: number): Similarity => {
  const s = Math.pow(fit.K, v - 1)
  const c = along(fit, travelled(fit, Math.pow(fit.K, v), v))
  return { s, d: { x: c.x - s * fit.to.x, y: c.y - s * fit.to.y } }
}

/** The fixed point of a zooming step (K well away from 1), where the paper doubles about. */
export const pivotOf = (fit: Fit): Point | null =>
  Math.abs(fit.K - 1) < 0.05 ? null : { x: (fit.K * fit.from.x - fit.to.x) / (fit.K - 1), y: (fit.K * fit.from.y - fit.to.y) / (fit.K - 1) }

/** Scale s about F. */
export const aboutPoint = (F: Point, s: number): Similarity => ({ s, d: { x: F.x * (1 - s), y: F.y * (1 - s) } })

export const applyToRect = ({ s, d }: Similarity, r: Rect): Rect => ({ x: s * r.x + d.x, y: s * r.y + d.y, w: r.w * s, h: r.h * s })

export const toCss = ({ s, d }: Similarity): string => `translate(${round(d.x)}px, ${round(d.y)}px) scale(${round(s, 5)})`

export const clampInto = (p: Point, r: Rect): Point => ({
  x: Math.min(r.x + r.w, Math.max(r.x, p.x)),
  y: Math.min(r.y + r.h, Math.max(r.y, p.y))
})

/** Share of r's area inside the viewport. */
export const visibleShare = (r: Rect, viewport: Rect): number => {
  const w = Math.max(0, Math.min(r.x + r.w, viewport.x + viewport.w) - Math.max(r.x, viewport.x))
  const h = Math.max(0, Math.min(r.y + r.h, viewport.y + viewport.h) - Math.max(r.y, viewport.y))
  return r.w * r.h > 0 ? (w * h) / (r.w * r.h) : 0
}

const round = (n: number, digits = 2): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
