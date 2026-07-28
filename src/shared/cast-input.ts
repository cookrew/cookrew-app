// Interactive-remote-browser input sanitizer (SECURITY CORE).
//
// The phone drives a live browser over an UNAUTH LAN WebSocket, so the wire
// protocol is a SMALL closed vocabulary — never raw CDP. Each message maps to
// one or more whitelisted `Input.*` commands (mouse/key/touch only); anything
// else (Runtime.evaluate, Page.navigate, a smuggled `{method,params}`) is rejected.
// Coords arrive in FRAME pixels and are divided by displayScale into the page's
// CSS viewport, then clamped — a hostile client can never point outside the
// page or inject a bulk payload.
//
// Pure so it unit-tests without Electron and is the single place the wire is
// trusted.

/** A validated CDP Input.* command — the ONLY thing allowed onto the debugger. */
export interface CdpInputCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.dispatchTouchEvent'
  params: Record<string, unknown> & { type: string }
}

export interface MapContext {
  /** frameWidth / cssViewportWidth — the screencast scale (`coords = tap/displayScale`). */
  displayScale: number
  /** Page CSS viewport bounds, for clamping. */
  viewportWidth: number
  viewportHeight: number
}

/** Largest single wheel delta and key text we accept (anti-abuse bounds). */
const MAX_WHEEL_DELTA = 10_000
const MAX_KEY_TEXT = 8

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Frame px -> clamped CSS px in the page viewport. Null if not a finite point. */
function toPagePoint(
  msg: Record<string, unknown>,
  ctx: MapContext
): { x: number; y: number } | null {
  if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.y)) return null
  const scale = ctx.displayScale > 0 ? ctx.displayScale : 1
  return {
    x: clamp(msg.x / scale, 0, ctx.viewportWidth),
    y: clamp(msg.y / scale, 0, ctx.viewportHeight)
  }
}

type TouchPoint = { x: number; y: number; id?: 0 | 1 }

/**
 * Validate the closed multi-touch shape. Renderer pointer ids never cross the
 * trust boundary: clients map the first two contacts to fixed slots 0 and 1.
 * Legacy single-point {x,y} messages remain accepted for rollout compatibility.
 */
function toPageTouchPoints(msg: Record<string, unknown>, ctx: MapContext): TouchPoint[] | null {
  if (msg.points === undefined) {
    const point = toPagePoint(msg, ctx)
    return point ? [point] : null
  }
  if (!Array.isArray(msg.points) || msg.points.length < 1 || msg.points.length > 2) return null

  const ids = new Set<number>()
  const points: TouchPoint[] = []
  for (const raw of msg.points) {
    if (typeof raw !== 'object' || raw === null) return null
    const point = raw as Record<string, unknown>
    if (Object.keys(point).some((key) => key !== 'id' && key !== 'x' && key !== 'y')) return null
    if (!Number.isInteger(point.id) || (point.id !== 0 && point.id !== 1) || ids.has(point.id)) {
      return null
    }
    const mapped = toPagePoint(point, ctx)
    if (!mapped) return null
    ids.add(point.id)
    points.push({ ...mapped, id: point.id })
  }
  return points.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
}

function mouse(type: string, p: { x: number; y: number }, extra: Record<string, unknown> = {}): CdpInputCommand {
  return { method: 'Input.dispatchMouseEvent', params: { type, x: p.x, y: p.y, ...extra } }
}

/**
 * Left-button descriptor with a clamped click multiplicity: 1 = single,
 * 2 = double (select word), 3 = triple (select line/all). Anything else → 1, so
 * a hostile client can never inflate the click count.
 */
function leftButton(msg: Record<string, unknown>): { button: 'left'; clickCount: number } {
  const c = msg.count
  const clickCount = Number.isInteger(c) && (c as number) >= 1 && (c as number) <= 3 ? (c as number) : 1
  return { button: 'left', clickCount }
}

/**
 * A whitelisted touch command. touchStart/touchMove carry at most two active
 * points (already clamped page px); touchEnd carries none (the fingers lifted).
 * A drag of touchStart→touchMove…→touchEnd is what makes a phone SWIPE scroll
 * the page natively instead of drag-selecting it.
 */
function touch(type: string, points: TouchPoint[]): CdpInputCommand {
  return { method: 'Input.dispatchTouchEvent', params: { type, touchPoints: points } }
}

/**
 * Translate one wire message into whitelisted CDP Input.* commands, or null to
 * reject. A tap/key expands to a press+release pair.
 */
export function sanitizeInput(raw: unknown, ctx: MapContext): CdpInputCommand[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  const t = msg.t
  if (typeof t !== 'string') return null

  switch (t) {
    case 'tap': {
      const p = toPagePoint(msg, ctx)
      const btn = leftButton(msg)
      return p ? [mouse('mousePressed', p, btn), mouse('mouseReleased', p, btn)] : null
    }
    case 'down': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mousePressed', p, leftButton(msg))] : null
    }
    case 'up': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mouseReleased', p, leftButton(msg))] : null
    }
    case 'move': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mouseMoved', p)] : null
    }
    case 'wheel': {
      const p = toPagePoint(msg, ctx)
      if (!p || !isFiniteNumber(msg.dy)) return null
      const deltaY = clamp(msg.dy, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)
      return [mouse('mouseWheel', p, { deltaX: 0, deltaY })]
    }
    case 'key': {
      if (typeof msg.key !== 'string' || msg.key.length === 0) return null
      const text = typeof msg.text === 'string' ? msg.text : undefined
      if (text !== undefined && text.length > MAX_KEY_TEXT) return null
      const code = typeof msg.code === 'string' ? msg.code : undefined
      const base: Record<string, unknown> = { key: msg.key, ...(code ? { code } : {}), ...(text ? { text } : {}) }
      return [
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...base } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } }
      ]
    }
    case 'touchstart': {
      const points = toPageTouchPoints(msg, ctx)
      return points ? [touch('touchStart', points)] : null
    }
    case 'touchmove': {
      const points = toPageTouchPoints(msg, ctx)
      return points ? [touch('touchMove', points)] : null
    }
    case 'touchend': {
      // Finger lifted — an empty touchPoints set is required by CDP for touchEnd.
      if (msg.points !== undefined && (!Array.isArray(msg.points) || msg.points.length !== 0)) return null
      return [touch('touchEnd', [])]
    }
    default:
      return null // whitelist: unknown types (evaluate, navigate, …) are dropped
  }
}
