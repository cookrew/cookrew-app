import type { FitRect } from './browser-frame'

/**
 * THE PICTURE, ZOOMED ON THE VIEWER.
 *
 * A Mac's screen on a phone is a sign-in code too small to read. This zooms
 * the picture where it is drawn, with nothing sent to the Mac, and does it by
 * moving the fit rect: everything that maps a finger to the frame already
 * reads that rect, so a tap on a zoomed picture lands where the finger is.
 */

export interface FrameZoom {
  /** 1 is the fit. */
  readonly k: number
  /** The picture's offset from where the fit puts it, in view pixels. */
  readonly x: number
  readonly y: number
}

export const NO_ZOOM: FrameZoom = { k: 1, x: 0, y: 0 }
const MAX_ZOOM = 6

interface View {
  readonly w: number
  readonly h: number
}

/** One axis: a picture wider than the view may not leave a gap; one narrower stays centred. */
function clampAxis(start: number, length: number, view: number): number {
  if (length <= view) return (view - length) / 2
  return Math.min(0, Math.max(view - length, start))
}

export function zoomedFit(fit: FitRect, zoom: FrameZoom): FitRect {
  if (zoom.k === 1) return fit
  return { width: fit.width * zoom.k, height: fit.height * zoom.k, left: fit.left + zoom.x, top: fit.top + zoom.y }
}

function held(fit: FitRect, view: View, k: number, left: number, top: number): FrameZoom {
  const width = fit.width * k
  const height = fit.height * k
  return { k, x: clampAxis(left, width, view.w) - fit.left, y: clampAxis(top, height, view.h) - fit.top }
}

/** A pinch of `scale` around a point in the view: what is under the fingers stays there. */
export function pinchZoom(zoom: FrameZoom, fit: FitRect, view: View, scale: number, at: { x: number; y: number }): FrameZoom {
  const k = Math.min(MAX_ZOOM, Math.max(1, zoom.k * scale))
  if (k === 1) return NO_ZOOM
  const now = zoomedFit(fit, zoom)
  const grown = k / zoom.k
  return held(fit, view, k, at.x - (at.x - now.left) * grown, at.y - (at.y - now.top) * grown)
}

export function panZoom(zoom: FrameZoom, fit: FitRect, view: View, dx: number, dy: number): FrameZoom {
  if (zoom.k === 1) return zoom
  const now = zoomedFit(fit, zoom)
  return held(fit, view, zoom.k, now.left + dx, now.top + dy)
}
