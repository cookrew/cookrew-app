/**
 * Interactive remote-browser STREAM client core (interactive-remote-browser-c,
 * CDP screencast arch). The phone SEES and DRIVES the desktop webview: Forge's
 * main process attaches the CDP debugger, Page.startScreencast, and pushes JPEG
 * frames over a WebSocket at GET /api/browser/:id/stream; the client renders them
 * and forwards touch/scroll/type back as Input events on the same socket.
 *
 * Built against Forge's LANDED contract (src/shared/cast-input.ts +
 * screencast-pace.ts):
 *   • Ack/backpressure is SERVER-SIDE (Forge acks CDP when its socket drains) —
 *     the client sends NO acks, it just renders the latest frame.
 *   • Input is a compact `t`-tagged vocabulary in FRAME pixels; Forge's
 *     sanitizeInput divides by displayScale, clamps to the page viewport, and
 *     whitelists to Input.* — so the client sends raw FRAME-pixel coords (no page
 *     scaling / no CDP passthrough).
 *
 * This module is the JSX-free, unit-tested core: the WS URL, the frame parse, the
 * view→frame coordinate mapping, the input-message builders, and the feature-
 * detect/fallback state machine (falls back LOUDLY to the static /thumb frame).
 */

import type { FitRect } from './browser-frame'

/** Requested screencast viewport bounds — Forge clamps 320..2048 (default 800x1400). */
export const VIEWPORT_MIN = 320
export const VIEWPORT_MAX = 2048

/** Clamp a requested viewport dimension to the server's accepted range (rounded). */
export function clampViewport(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return VIEWPORT_MIN
  return Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, Math.round(px)))
}

/**
 * The WS URL for a browser's stream, derived from the page origin (ws/wss) with
 * the requested screencast size as `w`/`h` query params (Forge's contract).
 */
export function streamUrl(origin: string, browserId: string, w: number, h: number): string {
  const scheme = origin.startsWith('https') ? 'wss' : 'ws'
  const host = origin.replace(/^https?:\/\//, '')
  const q = `w=${clampViewport(w)}&h=${clampViewport(h)}`
  return `${scheme}://${host}/api/browser/${encodeURIComponent(browserId)}/stream?${q}`
}

/** base64 JPEG → a renderable data URL. */
export function frameDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`
}

/** A parsed server→client message (Forge's `t`-tagged JSON text frames). */
export type StreamMessage =
  | { kind: 'ready'; w: number; h: number }
  | { kind: 'frame'; seq: number; src: string }
  | { kind: 'error'; msg: string }

/**
 * Parse a server→client WS payload into a typed message, or null to ignore.
 * Forge sends JSON: {t:'ready',w,h} once, {t:'frame',seq,data,meta} per frame,
 * {t:'error',msg} then close. Tolerant of a bare base64/dataURL string as a frame
 * (mock-friendly before the transport lands). Pure — unit-tested.
 */
export function parseStreamMessage(raw: unknown): StreamMessage | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!trimmed.startsWith('{')) return { kind: 'frame', seq: 0, src: frameDataUrl(trimmed) }
  let obj: { t?: unknown; data?: unknown; seq?: unknown; w?: unknown; h?: unknown; msg?: unknown }
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (obj.t === 'frame' && typeof obj.data === 'string') {
    return { kind: 'frame', seq: typeof obj.seq === 'number' ? obj.seq : 0, src: frameDataUrl(obj.data) }
  }
  if (obj.t === 'ready') {
    return { kind: 'ready', w: typeof obj.w === 'number' ? obj.w : 0, h: typeof obj.h === 'number' ? obj.h : 0 }
  }
  if (obj.t === 'error') {
    return { kind: 'error', msg: typeof obj.msg === 'string' ? obj.msg : 'stream error' }
  }
  return null
}

// ---- coordinate mapping: view px → FRAME px (Forge divides by displayScale) ----

/**
 * A view-space pointer → the FRAME's pixel coordinate. The frame image is
 * letterboxed into the view at `fit`, so subtract the letterbox origin and divide
 * by the local display scale (fit / frame). Clamped to the frame rect so a tap in
 * the letterbox margin lands on the nearest edge, never off-frame. `frameW/H` is
 * the JPEG's natural pixel size. Forge's sanitizeInput then maps FRAME px → page
 * CSS px (÷ displayScale, clamp). Pure — unit-tested.
 */
export function viewToFramePoint(
  viewX: number,
  viewY: number,
  fit: FitRect,
  frameW: number,
  frameH: number
): { x: number; y: number } {
  if (fit.width <= 0 || fit.height <= 0) return { x: 0, y: 0 }
  const sx = fit.width / frameW
  const sy = fit.height / frameH
  const x = Math.max(0, Math.min(frameW, (viewX - fit.left) / sx))
  const y = Math.max(0, Math.min(frameH, (viewY - fit.top) / sy))
  return { x, y }
}

// ---- input wire vocabulary (mirrors cast-input.ts sanitizeInput `t` tags) ----

/** Client→server input messages — the closed vocabulary Forge whitelists. */
export type CastInputMsg =
  | { t: 'tap'; x: number; y: number }
  | { t: 'down'; x: number; y: number }
  | { t: 'up'; x: number; y: number }
  | { t: 'move'; x: number; y: number }
  | { t: 'wheel'; x: number; y: number; dy: number }
  | { t: 'key'; key: string; code?: string; text?: string }

/** Build a pointer input message (tap/down/up/move) at a FRAME point. */
export function pointerMsg(t: 'tap' | 'down' | 'up' | 'move', p: { x: number; y: number }): CastInputMsg {
  return { t, x: p.x, y: p.y }
}

/** Build a wheel/scroll message at a FRAME point with a vertical delta. */
export function wheelMsg(p: { x: number; y: number }, dy: number): CastInputMsg {
  return { t: 'wheel', x: p.x, y: p.y, dy }
}

/** Build a key message; `text` only for printable single characters. */
export function keyMsg(key: string, code: string): CastInputMsg {
  return { t: 'key', key, code, ...(key.length === 1 ? { text: key } : {}) }
}

// ---- feature-detect / fallback state machine ----

/**
 * idle → connecting → streaming, with fallback to the static /thumb frame the
 * moment the CDP/WS path proves unavailable (unsupported env, connect error,
 * socket close, or no first frame before the connect deadline). Fallback is
 * terminal for this open; a fresh browser-open starts over. Never silent — the
 * caller logs loudly on the transition to 'fallback'.
 */
export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'fallback'
export type StreamEvent = 'connect' | 'open' | 'firstFrame' | 'error' | 'close' | 'unsupported'

export function nextStreamStatus(current: StreamStatus, event: StreamEvent): StreamStatus {
  if (event === 'unsupported' || event === 'error' || event === 'close') return 'fallback'
  switch (current) {
    case 'idle':
      return event === 'connect' ? 'connecting' : current
    case 'connecting':
      return event === 'firstFrame' ? 'streaming' : current
    default:
      return current
  }
}

/** Whether the browser environment can even attempt a stream (WS present). */
export function streamSupported(hasWebSocket: boolean, remoteMode: boolean): boolean {
  return hasWebSocket && remoteMode
}

/** Which source the view should render: the live stream only while 'streaming'. */
export function frameSource(status: StreamStatus): 'stream' | 'thumb' {
  return status === 'streaming' ? 'stream' : 'thumb'
}
