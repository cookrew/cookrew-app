// Closed viewport-control vocabulary for the unauthenticated LAN stream.
//
// These messages never name CDP methods and never carry arbitrary params.
// They are reduced to bounded internal viewport intents before main may call
// the typed HeadlessInstance viewport API.

export const VIEWPORT_MIN = 320
export const VIEWPORT_MAX = 2048
const MIN_ASPECT = 0.4
const MAX_ASPECT = 2.5

/**
 * Device pixels per CSS px the wire carries: a 3x phone's own ratio at most.
 * What one viewer may actually have is narrower, and the Mac says so in its
 * `ready` (cast-viewer.ts · scaleMax): this is only the vocabulary's bound.
 */
export const VIEWPORT_SCALE_MAX = 3

export interface ViewportMetrics {
  width: number
  height: number
  mobile: boolean
  /**
   * Device pixels per CSS px (Chrome's deviceScaleFactor). Absent = 1. A phone
   * asks for its own screen's, up to what the Mac allowed it; the desktop
   * asks for none, so its frames stay 1x.
   */
  scale?: number
}

/** A requested scale in [1, max], in half steps; anything else is 1. */
export function viewportScale(raw: unknown, max: number = VIEWPORT_SCALE_MAX): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  const ceiling = Number.isFinite(max) ? Math.min(Math.max(max, 1), VIEWPORT_SCALE_MAX) : 1
  return Math.min(Math.max(Math.round(raw * 2) / 2, 1), ceiling)
}

/**
 * The most device pixels one frame may hold: a 3x phone's whole screen
 * (1290x2796). The viewport is shared, so whoever owns it sets every viewer's
 * frame size; a 2048-wide window at 2x would otherwise be 4096 px frames for
 * all of them.
 */
export const VIEWPORT_PIXEL_BUDGET = 1290 * 2796

/** The most scale a width x height viewport may have within the pixel budget, in half steps, never under 1. */
export function budgetScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1
  return Math.max(1, Math.floor(Math.sqrt(VIEWPORT_PIXEL_BUDGET / (width * height)) * 2) / 2)
}

/** The same metrics with their scale held to what this viewer may have, and to the pixel budget. */
export function capViewportScale(metrics: ViewportMetrics, max: number): ViewportMetrics {
  const { scale: asked, ...rest } = metrics
  const scale = Math.min(viewportScale(asked ?? 1, max), budgetScale(metrics.width, metrics.height))
  return scale > 1 ? { ...rest, scale } : rest
}

export type ViewportWireMessage =
  | { type: 'offer'; metrics: ViewportMetrics }
  | { type: 'claim'; metrics: ViewportMetrics }
  | { type: 'release' }

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function metrics(raw: Record<string, unknown>): ViewportMetrics | null {
  if (!finite(raw.width) || !finite(raw.height) || typeof raw.mobile !== 'boolean') return null
  let width = clamp(Math.round(raw.width), VIEWPORT_MIN, VIEWPORT_MAX)
  let height = clamp(Math.round(raw.height), VIEWPORT_MIN, VIEWPORT_MAX)
  const aspect = width / height
  if (aspect < MIN_ASPECT) height = clamp(Math.round(width / MIN_ASPECT), VIEWPORT_MIN, VIEWPORT_MAX)
  if (aspect > MAX_ASPECT) width = clamp(Math.round(height * MAX_ASPECT), VIEWPORT_MIN, VIEWPORT_MAX)
  const scale = viewportScale(raw.scale)
  return { width, height, mobile: raw.mobile, ...(scale > 1 ? { scale } : {}) }
}

export function sanitizeViewportMessage(raw: unknown): ViewportWireMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t === 'viewport-release') return { type: 'release' }
  if (msg.t !== 'viewport-offer' && msg.t !== 'viewport-claim') return null
  const safe = metrics(msg)
  if (!safe) return null
  return { type: msg.t === 'viewport-claim' ? 'claim' : 'offer', metrics: safe }
}
