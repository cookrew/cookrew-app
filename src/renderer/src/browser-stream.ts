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
export const MOBILE_VIEWPORT_MAX_WIDTH = 700

/** The companion server is the native renderer's route to the stream endpoint. */
export const DESKTOP_STREAM_ORIGIN = 'http://127.0.0.1:8639'

/** Renderer surfaces that may (or may not) host the shared browser stream. */
export type StreamClient = 'desktop' | 'remote' | 'demo'
export type ViewportOwner = 'self' | 'other' | 'none'

export interface ViewportSize {
  width: number
  height: number
}

export interface ViewportPreference extends ViewportSize {
  mobile: boolean
}

export type ViewportControlKind = 'offer' | 'claim' | 'release'

/** Closed renderer→server viewport/controller vocabulary. */
export type ViewportControlMsg =
  | { t: 'viewport-offer'; width: number; height: number; mobile: boolean }
  | { t: 'viewport-claim'; width: number; height: number; mobile: boolean }
  | { t: 'viewport-release' }

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

/** Prefer mobile metrics for a touch-first device or a genuinely narrow view. */
export function mobileViewportPreference(width: number, coarsePointer: boolean): boolean {
  return coarsePointer || (width > 0 && width <= MOBILE_VIEWPORT_MAX_WIDTH)
}

/** Revisions are monotonic non-negative integers; malformed values become 0. */
export function normalizeRevision(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0
}

export function viewportControlMsg(
  t: ViewportControlKind,
  viewport: ViewportSize,
  mobile: boolean
): ViewportControlMsg {
  if (t === 'release') return { t: 'viewport-release' }
  return {
    t: t === 'claim' ? 'viewport-claim' : 'viewport-offer',
    width: clampViewport(viewport.width),
    height: clampViewport(viewport.height),
    mobile
  }
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

interface StreamControlFields {
  isOwner: boolean
  owner: ViewportOwner
  viewerCount: number
  width: number
  height: number
  revision: number
  mobile: boolean
  agentHeld: boolean
  transitioning: boolean
}

interface StreamFrameMeta {
  revision?: number
  deviceWidth?: number
  deviceHeight?: number
  displayScale?: number
  pageScaleFactor?: number
  mobile?: boolean
}

/** A parsed server→client message (Forge's `t`-tagged JSON text frames). */
export type StreamMessage =
  | ({ kind: 'ready'; w: number; h: number; revision?: number; mobile?: boolean })
  | ({ kind: 'control' } & StreamControlFields)
  | ({ kind: 'frame'; seq: number; src: string } & StreamFrameMeta)
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
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (obj.t === 'frame' && typeof obj.data === 'string') {
    const meta = asRecord(obj.meta)
    const revision = finiteRevision(obj.revision ?? meta?.revision)
    const deviceWidth = positiveNumber(meta?.deviceWidth)
    const deviceHeight = positiveNumber(meta?.deviceHeight)
    const displayScale = positiveNumber(meta?.displayScale)
    const pageScaleFactor = positiveNumber(meta?.pageScaleFactor)
    const mobile = typeof meta?.mobile === 'boolean' ? meta.mobile : undefined
    return {
      kind: 'frame',
      seq: typeof obj.seq === 'number' ? obj.seq : 0,
      src: frameDataUrl(obj.data),
      ...(revision !== null ? { revision } : {}),
      ...(deviceWidth !== null ? { deviceWidth } : {}),
      ...(deviceHeight !== null ? { deviceHeight } : {}),
      ...(displayScale !== null ? { displayScale } : {}),
      ...(pageScaleFactor !== null ? { pageScaleFactor } : {}),
      ...(mobile !== undefined ? { mobile } : {})
    }
  }
  if (obj.t === 'ready') {
    const w = positiveNumber(obj.w) ?? 0
    const h = positiveNumber(obj.h) ?? 0
    const revision = finiteRevision(obj.revision)
    const mobile = typeof obj.mobile === 'boolean' ? obj.mobile : undefined
    return {
      kind: 'ready',
      w,
      h,
      ...(revision !== null ? { revision } : {}),
      ...(mobile !== undefined ? { mobile } : {})
    }
  }
  if (obj.t === 'viewport-state') {
    const control = parseControlFields(obj)
    return control ? { kind: 'control', ...control } : null
  }
  if (obj.t === 'error') {
    return { kind: 'error', msg: typeof obj.msg === 'string' ? obj.msg : 'stream error' }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function finiteRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function parseOwner(value: unknown): ViewportOwner | undefined {
  if (value === 'self' || value === 'other' || value === 'none') return value
  return undefined
}

function parseControlFields(obj: Record<string, unknown>): StreamControlFields | null {
  const width = positiveNumber(obj.width)
  const height = positiveNumber(obj.height)
  const revision = finiteRevision(obj.revision)
  const viewerCount = positiveNumber(obj.viewerCount)
  const owner = parseOwner(obj.owner)
  if (
    owner === undefined ||
    viewerCount === null ||
    width === null ||
    height === null ||
    revision === null ||
    typeof obj.mobile !== 'boolean' ||
    typeof obj.agentHeld !== 'boolean' ||
    typeof obj.transitioning !== 'boolean'
  ) {
    return null
  }
  return {
    isOwner: owner === 'self',
    owner,
    viewerCount: Math.max(1, Math.round(viewerCount)),
    width,
    height,
    revision,
    mobile: obj.mobile,
    agentHeld: obj.agentHeld,
    transitioning: obj.transitioning
  }
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

export type TouchInputKind = 'touchstart' | 'touchmove' | 'touchend'
export type TouchSlot = 0 | 1

/** A closed renderer touch contact in FRAME pixels. */
export interface StreamTouchPoint {
  id: TouchSlot
  x: number
  y: number
}

export type TouchInputMsg =
  | { t: TouchInputKind; x: number; y: number }
  | { t: 'touchstart' | 'touchmove'; points: StreamTouchPoint[] }
  | { t: 'touchend' }

/** Client→server input messages — the closed vocabulary Forge whitelists. */
export type CastInputMsg =
  | { t: 'tap'; x: number; y: number; count?: number }
  | { t: 'down'; x: number; y: number; count?: number }
  | { t: 'up'; x: number; y: number; count?: number }
  | { t: 'move'; x: number; y: number }
  | { t: 'wheel'; x: number; y: number; dy: number }
  | { t: 'key'; key: string; code?: string; text?: string }
  | TouchInputMsg

export type RevisionedCastInputMsg = CastInputMsg & { revision: number }
export type FrameBoundCastInputMsg = CastInputMsg & { frameSeq: number }

/** Bind coordinate input to the exact screencast frame painted by the viewer. */
export function inputWithFrameSeq(msg: CastInputMsg, frameSeq: number): FrameBoundCastInputMsg {
  return { ...msg, frameSeq: normalizeRevision(frameSeq) }
}

export function inputWithRevision(msg: CastInputMsg, revision: number): RevisionedCastInputMsg {
  return { ...msg, revision: normalizeRevision(revision) }
}

/** Input is safe only against the exact viewport revision that produced its frame. */
export function frameMatchesViewport(
  frameRevision: number | null,
  viewportRevision: number | null
): boolean {
  return frameRevision !== null &&
    viewportRevision !== null &&
    frameRevision === viewportRevision
}

/** Viewer input is valid against any stable viewport with a matching frame. */
export function streamCanDrive(opts: {
  live: boolean
  agentHeld: boolean
  transitioning: boolean
  frameRevision: number | null
  viewportRevision: number | null
}): boolean {
  return opts.live &&
    !opts.agentHeld &&
    !opts.transitioning &&
    frameMatchesViewport(opts.frameRevision, opts.viewportRevision)
}

/**
 * Pointer release is cleanup, not a new drive action. It may cross a liveness or
 * activity hold, but never a viewport-revision boundary.
 */
export function streamInputAllowed(
  msg: CastInputMsg,
  opts: Parameters<typeof streamCanDrive>[0]
): boolean {
  if (!frameMatchesViewport(opts.frameRevision, opts.viewportRevision)) return false
  if (msg.t === 'up' || msg.t === 'touchend') return true
  return streamCanDrive(opts)
}

/** Build a pointer input message (tap/down/up/move) at a FRAME point. */
export function pointerMsg(
  t: 'tap' | 'down' | 'up' | 'move',
  p: { x: number; y: number },
  count = 1
): CastInputMsg {
  // count carries the click multiplicity (2 = double-click, 3 = triple) so the
  // remote page can select a word / line; move never carries it.
  return { t, x: p.x, y: p.y, ...(t !== 'move' && count > 1 ? { count } : {}) }
}

/**
 * Build a touch input message at a FRAME point. Touch pointers (a phone) send
 * these instead of mouse down/move/up so a swipe scrolls the page natively.
 */
export function touchMsg(t: TouchInputKind, p: { x: number; y: number }): TouchInputMsg {
  return { t, x: p.x, y: p.y }
}

/** Build a bounded multi-contact message without forwarding arbitrary fields. */
export function multiTouchMsg(
  t: 'touchstart' | 'touchmove',
  points: StreamTouchPoint[]
): TouchInputMsg {
  return {
    t,
    points: points.slice(0, 2).map(({ id, x, y }) => ({ id, x, y }))
  }
}

export interface StreamTouchPointer {
  pointerId: number
  x: number
  y: number
}

interface TouchGestureContact extends StreamTouchPoint {
  pointerId: number
}

export interface TouchGestureState {
  contacts: TouchGestureContact[]
  /** Once a second contact joins, keep IDs through the rest of that gesture. */
  multi: boolean
}

export interface TouchGestureUpdate {
  state: TouchGestureState
  message: TouchInputMsg
}

export function emptyTouchGesture(): TouchGestureState {
  return { contacts: [], multi: false }
}

/**
 * Advance a native touch gesture. Gestures that remain single-contact retain the
 * legacy scalar wire shape; two-contact gestures use stable, bounded IDs.
 */
export function updateTouchGesture(
  state: TouchGestureState,
  phase: 'start' | 'move' | 'end',
  point: StreamTouchPointer
): TouchGestureUpdate | null {
  const index = state.contacts.findIndex((contact) => contact.pointerId === point.pointerId)

  if (phase === 'start') {
    if (index !== -1 || state.contacts.length >= 2) return null
    const id: TouchSlot = state.contacts.some((contact) => contact.id === 0) ? 1 : 0
    const contacts = [...state.contacts, { ...point, id }]
    const multi = state.multi || contacts.length === 2
    return {
      state: { contacts, multi },
      message: multi ? multiTouchMsg('touchstart', contacts) : touchMsg('touchstart', point)
    }
  }

  if (index === -1) return null
  const updated = state.contacts.map((contact, contactIndex) =>
    contactIndex === index ? { ...contact, ...point } : contact
  )

  if (phase === 'move') {
    return {
      state: { contacts: updated, multi: state.multi },
      message: state.multi ? multiTouchMsg('touchmove', updated) : touchMsg('touchmove', point)
    }
  }

  if (state.multi) {
    return { state: emptyTouchGesture(), message: { t: 'touchend' } }
  }
  return {
    state: emptyTouchGesture(),
    message: touchMsg('touchend', point)
  }
}

/** Release every remote touch when the surface loses interactivity. */
export function releaseTouchGesture(state: TouchGestureState): TouchGestureUpdate | null {
  if (state.contacts.length === 0) return null
  return {
    state: emptyTouchGesture(),
    message: state.multi
      ? { t: 'touchend' }
      : touchMsg('touchend', state.contacts[0])
  }
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
