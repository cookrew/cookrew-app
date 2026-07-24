/**
 * Interactive remote-browser STREAM client core (interactive-remote-browser-c,
 * CDP screencast arch). Desktop and phone clients SEE and DRIVE the same
 * headless-Chromium instance: Forge pushes JPEG frames over a WebSocket at
 * GET /api/browser/:id/stream, and both renderers forward pointer/scroll/key
 * input to that same CDP target.
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
 * detect/fallback state machine. Legacy phone mode may fall back to /thumb;
 * headless mode fails closed on a neutral unavailable surface.
 */

import type { FitRect } from './browser-frame'

/** Requested screencast viewport bounds — Forge clamps 320..2048 (default 800x1400). */
export const VIEWPORT_MIN = 320
export const VIEWPORT_MAX = 2048

/** The companion server is the native renderer's route to the stream endpoint. */
export const DESKTOP_STREAM_ORIGIN = 'http://127.0.0.1:8639'

/** Renderer surfaces that may (or may not) host the shared browser stream. */
export type StreamClient = 'desktop' | 'remote' | 'demo'

/** Exhaustive renderer ownership contract for one browser tab surface. */
export type BrowserRenderMode =
  | 'pending'
  | 'headless-stream'
  | 'legacy-webview'
  | 'legacy-thumb'
  | 'legacy-iframe'
  | 'legacy-blocked'

/**
 * Capability approval wins before every legacy exception. In particular, a
 * self-embedding URL is still rendered by the already-owned headless page;
 * blocking, iframe, webview, and /thumb are flag-off behavior only.
 */
export function browserRenderMode(opts: {
  interactive: boolean | null
  client: StreamClient
  selfEmbedding: boolean
}): BrowserRenderMode {
  if (opts.interactive === null) return 'pending'
  if (opts.interactive) return 'headless-stream'
  if (opts.selfEmbedding) return 'legacy-blocked'
  if (opts.client === 'remote') return 'legacy-thumb'
  if (opts.client === 'demo') return 'legacy-iframe'
  return 'legacy-webview'
}

/** Clamp a requested viewport dimension to the server's accepted range (rounded). */
export function clampViewport(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return VIEWPORT_MIN
  return Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, Math.round(px)))
}

/**
 * The WS URL for a browser's stream, derived from the page origin (ws/wss) with
 * the requested screencast size as `w`/`h` query params (Forge's contract).
 */
export function streamUrl(
  origin: string,
  browserId: string,
  w: number,
  h: number,
  desktopToken?: string | null
): string {
  const scheme = origin.startsWith('https') ? 'wss' : 'ws'
  const host = origin.replace(/^https?:\/\//, '')
  const token = desktopToken ? `&desktopToken=${encodeURIComponent(desktopToken)}` : ''
  const q = `w=${clampViewport(w)}&h=${clampViewport(h)}${token}`
  return `${scheme}://${host}/api/browser/${encodeURIComponent(browserId)}/stream?${q}`
}

/**
 * Phone bundles are served by the companion server and connect same-origin.
 * Electron is loaded from file:// (packaged) or Vite (dev), so its stream lives
 * on the companion server's stable loopback origin instead of the page origin.
 */
export function streamOrigin(pageOrigin: string, client: StreamClient): string {
  return client === 'desktop' ? DESKTOP_STREAM_ORIGIN : pageOrigin
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

/** A frame is live only inside the freshness window; zero means no frame yet. */
export function frameIsFresh(lastFrameAt: number, now: number, staleMs: number): boolean {
  return lastFrameAt > 0 && now >= lastFrameAt && now - lastFrameAt <= staleMs
}

/** Stable, probe-facing state of the rendered browser surface. */
export type StreamSurfaceState =
  | 'idle'
  | 'loading'
  | 'live'
  | 'stalled'
  | 'fallback'
  | 'unavailable'

export function streamSurfaceState(opts: {
  open: boolean
  status: StreamStatus
  frameLoaded: boolean
  live: boolean
  fallback: 'thumb' | 'loading'
}): StreamSurfaceState {
  if (!opts.open) return 'idle'
  if (opts.status === 'streaming') {
    if (!opts.frameLoaded) return 'loading'
    return opts.live ? 'live' : 'stalled'
  }
  if (opts.status === 'fallback') {
    return opts.fallback === 'thumb' ? 'fallback' : 'unavailable'
  }
  return 'loading'
}

// ---- feature-detect / fallback state machine ----

/**
 * idle → connecting → streaming, with fallback the moment the CDP/WS path
 * proves unavailable (unsupported env, connect error, socket close, or no first
 * frame before the deadline). Fallback is terminal for this open; a fresh
 * browser-open starts over. Never silent — the caller logs the transition.
 */
export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'fallback'
export type StreamEvent =
  | 'connect'
  | 'open'
  | 'firstFrame'
  | 'error'
  | 'close'
  | 'unsupported'
  | 'disabled'

export function nextStreamStatus(current: StreamStatus, event: StreamEvent): StreamStatus {
  if (event === 'unsupported' || event === 'disabled' || event === 'error' || event === 'close') {
    return 'fallback'
  }
  switch (current) {
    case 'idle':
      return event === 'connect' ? 'connecting' : current
    case 'connecting':
      return event === 'firstFrame' ? 'streaming' : current
    default:
      return current
  }
}

/** Whether this renderer can attempt a capability-approved stream. */
export function streamSupported(hasWebSocket: boolean, client: StreamClient): boolean {
  return hasWebSocket && client !== 'demo'
}

/** Which source the view should render: the live stream only while 'streaming'. */
export function frameSource(status: StreamStatus): 'stream' | 'thumb' {
  return status === 'streaming' ? 'stream' : 'thumb'
}
