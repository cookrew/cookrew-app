// Closed viewport-control vocabulary for the unauthenticated LAN stream.
//
// These messages never name CDP methods and never carry arbitrary params.
// They are reduced to bounded internal viewport intents before main may call
// the typed HeadlessInstance viewport API.

export const VIEWPORT_MIN = 320
export const VIEWPORT_MAX = 2048
const MIN_ASPECT = 0.4
const MAX_ASPECT = 2.5

export interface ViewportMetrics {
  width: number
  height: number
  mobile: boolean
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
  return { width, height, mobile: raw.mobile }
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
