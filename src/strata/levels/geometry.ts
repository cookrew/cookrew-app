// Rect arithmetic for the level layouts. Pure; every function returns new values.
import type { Rect } from '../../shared/strata'

export interface Size {
  w: number
  h: number
}

/** Uniform scale + offset: p' = p·s + d. */
export interface Transform {
  s: number
  dx: number
  dy: number
}

export const IDENTITY: Transform = { s: 1, dx: 0, dy: 0 }

/** The largest uniform scale of `from` that fits `to`, centred (letterboxed). */
export const fitTransform = (from: Rect, to: Rect, maxScale = Infinity): Transform => {
  const s = Math.min(to.w / from.w, to.h / from.h, maxScale)
  return { s, dx: to.x + (to.w - from.w * s) / 2 - from.x * s, dy: to.y + (to.h - from.h * s) / 2 - from.y * s }
}

export const mapRect = (r: Rect, t: Transform): Rect => ({ x: r.x * t.s + t.dx, y: r.y * t.s + t.dy, w: r.w * t.s, h: r.h * t.s })

/** a then b. */
export const compose = (a: Transform, b: Transform): Transform => ({ s: a.s * b.s, dx: a.dx * b.s + b.dx, dy: a.dy * b.s + b.dy })

export const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export const inset = (r: Rect, top: number, right = top, bottom = top, left = right): Rect => ({
  x: r.x + left,
  y: r.y + top,
  w: Math.max(0, r.w - left - right),
  h: Math.max(0, r.h - top - bottom)
})

export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/** Place a box of `size` in `r` with its own top-left at (x, y) relative to r. */
export const at = (r: Rect, x: number, y: number, size: Size): Rect => ({ x: r.x + x, y: r.y + y, w: size.w, h: size.h })
