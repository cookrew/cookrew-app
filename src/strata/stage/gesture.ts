// Gesture → flight progress (motion.html §5). Pure reducers, so the thresholds
// are testable without a browser; the stage feeds them events and acts on what
// they return. Fingers moving left = in, right = out (D8).

export type Direction = 'in' | 'out'

export const COMMIT_AT = 0.35
/** Touch: a flick toward the target commits from any distance (px/ms). */
export const TOUCH_FLICK = 0.45
/** Trackpad: deltas run hotter than fingers on glass. */
export const WHEEL_FLICK = 1.2
/** Touch travel for a whole flight, as a share of the stage width. */
export const TOUCH_SPAN = 0.6
/** Trackpad deltaX for a whole flight. */
export const WHEEL_SPAN = 420
const LOCK_PX = 10
const LOCK_RATIO = 1.2
/** Momentum has begun when |dx| stays under this share of the peak for two events. */
const DECAY_SHARE = 0.6
const DECAY_EVENTS = 2
export const WHEEL_IDLE_MS = 90
export const WHEEL_ABSORB_MS = 160
/** Touch pans that start this close to the left edge belong to the terminal level's edge-out (and to the OS elsewhere). */
export const EDGE_ZONE = 24

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Commit or spring back: far enough, or fast enough toward the target; never when moving away. */
export const decide = (u: number, velocity: number, flick: number): boolean => velocity >= flick || (u >= COMMIT_AT && velocity > -flick / 2)

/** iOS-style resistance: grows ever slower, capped. */
export const rubberBand = (d: number, width: number, cap = 64): number =>
  Math.sign(d) * Math.min(cap, (1 - 1 / ((0.55 * Math.abs(d)) / Math.max(1, width) + 1)) * width * 0.5)

// ── one-finger touch ────────────────────────────────────────────────────────

export interface PanState {
  phase: 'pending' | 'locked' | 'rejected'
  x0: number
  y0: number
  dir: Direction | null
  /** Last two samples, for release velocity. */
  last: ReadonlyArray<{ x: number; t: number }>
}

export const panStart = (x: number, y: number, t: number): PanState => ({ phase: 'pending', x0: x, y0: y, dir: null, last: [{ x, t }] })

export const panMove = (s: PanState, x: number, y: number, t: number): PanState => {
  if (s.phase === 'rejected') return s
  const last = [...s.last.slice(-1), { x, t }]
  if (s.phase === 'locked') return { ...s, last }
  const dx = x - s.x0
  const dy = y - s.y0
  if (Math.abs(dy) >= LOCK_PX && Math.abs(dy) * LOCK_RATIO >= Math.abs(dx)) return { ...s, phase: 'rejected', last }
  if (Math.abs(dx) >= LOCK_PX && Math.abs(dx) > LOCK_RATIO * Math.abs(dy)) return { ...s, phase: 'locked', dir: dx < 0 ? 'in' : 'out', last }
  return { ...s, last }
}

/** Signed travel toward the locked direction, in px (negative = back past the start). */
export const panTravel = (s: PanState): number => {
  const x = s.last[s.last.length - 1].x
  return s.dir === 'in' ? s.x0 - x : x - s.x0
}

export const panProgress = (s: PanState, width: number): number => clamp(panTravel(s) / (TOUCH_SPAN * Math.max(1, width)), 0, 1)

/** px/ms toward the target (negative = away). */
export const panVelocity = (s: PanState): number => {
  if (s.last.length < 2) return 0
  const [a, b] = s.last
  const v = (b.x - a.x) / Math.max(1, b.t - a.t)
  return s.dir === 'in' ? -v : v
}

// ── two-finger trackpad (wheel) ─────────────────────────────────────────────
// There is no "fingers lifted" event: release is inferred when the deltas start
// to decay (the OS's momentum phase) or go quiet; the momentum tail is then
// absorbed so it cannot start a second flight.

export interface WheelState {
  phase: 'idle' | 'active' | 'absorbing'
  dir: Direction | null
  /** Accumulated deltaX toward `dir`. */
  sum: number
  peak: number
  decays: number
  lastT: number
  lastAbs: number
  velocity: number
}

export type WheelOut =
  | { type: 'pass' }
  | { type: 'swallow' }
  | { type: 'start'; dir: Direction; travel: number }
  | { type: 'move'; travel: number }
  | { type: 'release'; travel: number; velocity: number }

export const WHEEL_IDLE: WheelState = { phase: 'idle', dir: null, sum: 0, peak: 0, decays: 0, lastT: 0, lastAbs: 0, velocity: 0 }

export const wheelProgress = (travel: number): number => clamp(travel / WHEEL_SPAN, 0, 1)

export const wheelStep = (s: WheelState, dx: number, dy: number, t: number): [WheelState, WheelOut] => {
  const abs = Math.abs(dx)
  if (s.phase === 'absorbing') {
    const fresh = abs > 8 && abs > 2 * s.lastAbs && t - s.lastT < WHEEL_ABSORB_MS
    if (!fresh) return [{ ...s, lastT: t, lastAbs: abs }, { type: 'swallow' }]
    return wheelStep({ ...WHEEL_IDLE }, dx, dy, t)
  }
  if (s.phase === 'idle') {
    if (abs < 1 || abs <= Math.abs(dy)) return [s, { type: 'pass' }]
    const dir: Direction = dx > 0 ? 'in' : 'out'
    return [{ phase: 'active', dir, sum: abs, peak: abs, decays: 0, lastT: t, lastAbs: abs, velocity: 0 }, { type: 'start', dir, travel: abs }]
  }
  const toward = s.dir === 'in' ? dx : -dx
  const sum = s.sum + toward
  const dt = Math.max(1, t - s.lastT)
  const velocity = 0.6 * (toward / dt) + 0.4 * s.velocity
  const decaying = abs < DECAY_SHARE * s.peak
  const next: WheelState = { ...s, sum, peak: Math.max(s.peak, abs), decays: decaying ? s.decays + 1 : 0, lastT: t, lastAbs: abs, velocity }
  if (next.decays >= DECAY_EVENTS || wheelProgress(sum) >= 1) return [{ ...next, phase: 'absorbing' }, { type: 'release', travel: sum, velocity: s.velocity }]
  return [next, { type: 'move', travel: sum }]
}

/** Call when no wheel event came for a while: an active gesture releases, an absorbed tail ends. */
export const wheelIdle = (s: WheelState, t: number): [WheelState, WheelOut | null] => {
  if (s.phase === 'active' && t - s.lastT >= WHEEL_IDLE_MS) return [{ ...s, phase: 'absorbing' }, { type: 'release', travel: s.sum, velocity: s.velocity }]
  if (s.phase === 'absorbing' && t - s.lastT >= WHEEL_ABSORB_MS) return [WHEEL_IDLE, null]
  return [s, null]
}
