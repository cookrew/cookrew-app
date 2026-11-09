import { fitContain, type FitRect } from '../browser-frame'
import { panZoom, zoomedFit, type FrameZoom } from '../frame-zoom'

/**
 * THE REMOTE BAR NEVER STANDS ON THE PICTURE.
 *
 * A computer's screen that someone can drive must have no pixel under
 * Cookrew's own controls: a click there would land on the bar, or go through
 * to the machine where the person meant the bar. So the bar gets a band of its
 * own and the picture is fitted to what is left, its aspect kept:
 *
 *   A ROW on top, where there is height to spare (a card, a phone upright).
 *
 *   A PILL, a narrow column beside the picture, where a row would cost clearly
 *   more of the picture than a column does (a phone on its side) or where a row
 *   of buttons would not fit across.
 *
 * The band is the same in both modes, view only and in control: the mode is
 * not an input here, so taking control never moves the picture under a finger.
 * What changes it is the view, the picture's shape and the bar's measured
 * height, which the bar keeps the same across modes (RemotePanel.tsx).
 *
 * Zoom happens inside the area (frame-zoom.ts works in area coordinates), so a
 * picture panned to its top edge stops at the band, and every mapping that
 * reads the fitted rect keeps working unchanged.
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type BarPlace = 'row' | 'pill'

export interface BarBand {
  readonly place: BarPlace
  readonly rect: Rect
}

export interface RemoteLayout {
  /** Where the bar lives; null when there is no bar. */
  readonly band: BarBand | null
  /** The space the picture is fitted and zoomed into. */
  readonly area: Rect
}

/** The pill's column: wide enough for a thumb on a button, narrow enough to cost little. */
export const PILL_WIDTH = 64
/** Narrower than this a row of buttons would wrap or spill: a pill instead. */
export const MIN_ROW_WIDTH = 320
/**
 * A row is what people expect, so it stays unless it costs clearly more of the
 * picture than a pill: a phone on its side loses about a third to a row, a card
 * only a few per cent.
 */
export const ROW_PREFERENCE = 0.85
/** The row's height before it has been measured once. */
export const ROW_HEIGHT_GUESS = 44

interface Size {
  readonly w: number
  readonly h: number
}

const areaOf = (rect: FitRect): number => rect.width * rect.height

export function remoteLayout(view: Size, frame: Size, barHeight: number | null): RemoteLayout {
  const whole: Rect = { left: 0, top: 0, width: Math.max(0, view.w), height: Math.max(0, view.h) }
  if (barHeight === null || view.w <= 0 || view.h <= 0) return { band: null, area: whole }
  const rowHeight = Math.min(Math.max(0, barHeight), view.h)
  const row: RemoteLayout = {
    band: { place: 'row', rect: { left: 0, top: 0, width: view.w, height: rowHeight } },
    area: { left: 0, top: rowHeight, width: view.w, height: view.h - rowHeight }
  }
  const pillWidth = Math.min(PILL_WIDTH, view.w)
  const pill: RemoteLayout = {
    band: { place: 'pill', rect: { left: view.w - pillWidth, top: 0, width: pillWidth, height: view.h } },
    area: { left: 0, top: 0, width: view.w - pillWidth, height: view.h }
  }
  if (view.w < MIN_ROW_WIDTH) return pill
  if (frame.w <= 0 || frame.h <= 0) return row
  const asRow = fitContain(frame.w, frame.h, row.area.width, row.area.height)
  const asPill = fitContain(frame.w, frame.h, pill.area.width, pill.area.height)
  return areaOf(asRow) < areaOf(asPill) * ROW_PREFERENCE ? pill : row
}

/** The picture's rect in the view: the letterbox of the area, zoomed inside it, then moved to where the area is. */
export function pictureFit(layout: RemoteLayout, frame: Size, zoom: FrameZoom): FitRect {
  const { area } = layout
  const size = { w: area.width, h: area.height }
  const base = fitContain(frame.w, frame.h, size.w, size.h)
  const local = zoomedFit(base, panZoom(zoom, base, size, 0, 0))
  return { ...local, left: local.left + area.left, top: local.top + area.top }
}

const contains = (rect: Rect, point: { x: number; y: number }): boolean =>
  point.x >= rect.left && point.x < rect.left + rect.width && point.y >= rect.top && point.y < rect.top + rect.height

/** What a press at this view point is: the bar's (never the machine's), the picture's, or the margin's. The band wins over a zoomed picture under it. */
export function hitArea(layout: RemoteLayout, picture: Rect, point: { x: number; y: number }): 'bar' | 'picture' | 'margin' {
  if (layout.band && contains(layout.band.rect, point)) return 'bar'
  return contains(picture, point) ? 'picture' : 'margin'
}
