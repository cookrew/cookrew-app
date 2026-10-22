// Gesture → flight progress (motion.html §5). Pure reducers, so the thresholds
// are testable without a browser; the stage feeds them events and acts on what
// they return. Fingers moving left = in, right = out (D8).

export type Direction = 'in' | 'out'

export const COMMIT_AT = 0.35
/** Touch: still this fast toward the target at release commits from any distance (px/ms). */
export const TOUCH_FLICK = 0.45
/**
 * Touch: a casual thumb flick commits too: felix fires on more than 48 px in
 * under 350 ms (≈ 0.14 px/ms on average), lifted while still moving toward
 * the target. Release speed alone misses it: a thumb slows before it lifts.
 */
export const FLICK_PX = 48
export const FLICK_MS = 350
/** Trackpad: deltas run hotter than fingers on glass. */
export const WHEEL_FLICK = 1.2
/** Touch travel for a whole flight, as a share of the stage width. */
export const TOUCH_SPAN = 0.6
/** Trackpad deltaX for a whole flight. */
export const WHEEL_SPAN = 420
const LOCK_PX = 10
const LOCK_RATIO = 1.2
/** Momentum has begun when the speed stays under this share of its peak for two events. */
const DECAY_SHARE = 0.6
const DECAY_EVENTS = 2
export const WHEEL_IDLE_MS = 90
export const WHEEL_ABSORB_MS = 160
/** A vertical delta past this (and twice the horizontal) is the page being scrolled, not a swipe's tail. */
const VERTICAL_PX = 4

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
  t0: number
  dir: Direction | null
  /** Last two samples, for release velocity. */
  last: ReadonlyArray<{ x: number; t: number }>
}

export const panStart = (x: number, y: number, t: number): PanState => ({ phase: 'pending', x0: x, y0: y, t0: t, dir: null, last: [{ x, t }] })

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

/** A short quick pan, lifted while still moving toward the target. */
export const panFlick = (s: PanState): boolean => {
  const end = s.last[s.last.length - 1]
  return s.phase === 'locked' && panTravel(s) >= FLICK_PX && end.t - s.t0 <= FLICK_MS && panVelocity(s) > 0
}

// ── two-finger trackpad (wheel) ─────────────────────────────────────────────
// There is no "fingers lifted" event: release is inferred when the speed starts
// to decay (the OS's momentum phase) or the stream goes quiet; the momentum tail
// is then absorbed so it cannot start a second flight. Speed, not raw delta: a
// busy main thread makes Chrome coalesce wheel events into fewer, bigger ones,
// and only |dx|/dt stays comparable across that.

export interface WheelState {
  phase: 'idle' | 'active' | 'absorbing'
  dir: Direction | null
  /** Accumulated deltaX toward `dir`. */
  sum: number
  /** Peak speed, px/ms. */
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

/** A first event has no previous one to time against: assume a frame. */
const FRAME_MS = 16

export const WHEEL_IDLE: WheelState = { phase: 'idle', dir: null, sum: 0, peak: 0, decays: 0, lastT: 0, lastAbs: 0, velocity: 0 }

export const wheelProgress = (travel: number): number => clamp(travel / WHEEL_SPAN, 0, 1)

export const wheelStep = (s: WheelState, dx: number, dy: number, t: number): [WheelState, WheelOut] => {
  const abs = Math.abs(dx)
  if (s.phase === 'absorbing') {
    // The tail is over when the stream went quiet (an idle timer that fired late), when fresh fingers
    // swipe again, or when the fingers scroll the page: a mostly vertical event is never the tail
    // (a few px of vertical noise in the tail is, or the next horizontal tail event would start a flight).
    const ended = t - s.lastT >= WHEEL_ABSORB_MS || Math.abs(dy) > Math.max(VERTICAL_PX, 2 * abs)
    const fresh = abs > 8 && abs > 2 * s.lastAbs
    if (!ended && !fresh) return [{ ...s, lastT: t, lastAbs: abs }, { type: 'swallow' }]
    return wheelStep(WHEEL_IDLE, dx, dy, t)
  }
  if (s.phase === 'idle') {
    if (abs < 1 || abs <= Math.abs(dy)) return [s, { type: 'pass' }]
    const dir: Direction = dx > 0 ? 'in' : 'out'
    return [{ phase: 'active', dir, sum: abs, peak: abs / FRAME_MS, decays: 0, lastT: t, lastAbs: abs, velocity: 0 }, { type: 'start', dir, travel: abs }]
  }
  const toward = s.dir === 'in' ? dx : -dx
  const sum = s.sum + toward
  const dt = Math.max(1, t - s.lastT)
  const speed = abs / dt
  const velocity = 0.6 * (toward / dt) + 0.4 * s.velocity
  const decaying = speed < DECAY_SHARE * s.peak
  const next: WheelState = { ...s, sum, peak: Math.max(s.peak, speed), decays: decaying ? s.decays + 1 : 0, lastT: t, lastAbs: abs, velocity }
  if (next.decays >= DECAY_EVENTS || wheelProgress(sum) >= 1) return [{ ...next, phase: 'absorbing' }, { type: 'release', travel: sum, velocity: s.velocity }]
  return [next, { type: 'move', travel: sum }]
}

/**
 * Call when no wheel event came for a while: an active gesture releases, an absorbed tail ends.
 * A release by silence had the fingers at rest before they lifted (no momentum), so it carries no speed.
 */
export const wheelIdle = (s: WheelState, t: number): [WheelState, WheelOut | null] => {
  if (s.phase === 'active' && t - s.lastT >= WHEEL_IDLE_MS) return [{ ...s, phase: 'absorbing' }, { type: 'release', travel: s.sum, velocity: 0 }]
  if (s.phase === 'absorbing' && t - s.lastT >= WHEEL_ABSORB_MS) return [WHEEL_IDLE, null]
  return [s, null]
}
