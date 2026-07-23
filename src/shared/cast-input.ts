// Interactive-remote-browser input sanitizer (SECURITY CORE).
//
// The phone drives a live browser over an UNAUTH LAN WebSocket, so the wire
// protocol is a SMALL closed vocabulary — never raw CDP. Each message maps to
// one or more whitelisted `Input.*` commands (mouse/key only); anything else
// (Runtime.evaluate, Page.navigate, a smuggled `{method,params}`) is rejected.
// Coords arrive in FRAME pixels and are divided by displayScale into the page's
// CSS viewport, then clamped — a hostile client can never point outside the
// page or inject a bulk payload.
//
// Pure so it unit-tests without Electron and is the single place the wire is
// trusted.

/** A validated CDP Input.* command — the ONLY thing allowed onto the debugger. */
export interface CdpInputCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent'
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

function mouse(type: string, p: { x: number; y: number }, extra: Record<string, unknown> = {}): CdpInputCommand {
  return { method: 'Input.dispatchMouseEvent', params: { type, x: p.x, y: p.y, ...extra } }
}

const LEFT = { button: 'left', clickCount: 1 } as const

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
      return p ? [mouse('mousePressed', p, LEFT), mouse('mouseReleased', p, LEFT)] : null
    }
    case 'down': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mousePressed', p, LEFT)] : null
    }
    case 'up': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mouseReleased', p, LEFT)] : null
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
    default:
      return null // whitelist: unknown types (evaluate, navigate, …) are dropped
  }
}
