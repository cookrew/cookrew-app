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

import type { UseStatus } from '../../shared/use-signal'
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
  /** Device pixels per CSS px (the desktop's display); absent or 1 on the phone. */
  scale?: number
}

export type ViewportControlKind = 'offer' | 'claim' | 'release'

/** Closed renderer→server viewport/controller vocabulary. */
export type ViewportControlMsg =
  | { t: 'viewport-offer'; width: number; height: number; mobile: boolean; scale?: number }
  | { t: 'viewport-claim'; width: number; height: number; mobile: boolean; scale?: number }
  | { t: 'viewport-release' }

/** The largest device scale a view asks for (cast-viewport.ts · VIEWPORT_SCALE_MAX). */
export const VIEW_SCALE_MAX = 2

/** A display's pixel ratio as a view's ask: half steps in [1, 2], so a Retina Mac draws the page 1:1. */
export function viewScale(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 1) return 1
  return Math.min(VIEW_SCALE_MAX, Math.round(devicePixelRatio * 2) / 2)
}

/** Exhaustive renderer ownership contract for one browser tab surface. */
export type BrowserRenderMode =
  | 'pending'
  | 'headless-stream'
  | 'legacy-webview'
  | 'legacy-thumb'
  | 'legacy-iframe'
  | 'legacy-blocked'
  /** A use card (a phone, a Mac window, a camera) without the headless stream: nothing can draw it, and the card says so. */
  | 'vphone-off'

/**
 * Capability approval wins before every legacy exception. In particular, a
 * self-embedding URL is still rendered by the already-owned headless page;
 * blocking, iframe, webview, and /thumb are flag-off behavior only.
 */
export function browserRenderMode(opts: {
  interactive: boolean | null
  client: StreamClient
  selfEmbedding: boolean
  /** The tab is `vphone://…` — a virtual iPhone, which only the stream can show. */
  vphone?: boolean
}): BrowserRenderMode {
  if (opts.interactive === null) return 'pending'
  if (opts.interactive) return 'headless-stream'
  if (opts.vphone) return 'vphone-off'
  if (opts.selfEmbedding) return 'legacy-blocked'
  if (opts.client === 'remote') return 'legacy-thumb'
  if (opts.client === 'demo') return 'legacy-iframe'
  return 'legacy-webview'
}

export interface BrowserCapability {
  enabled: boolean
  desktopToken: string | null
}

/**
 * Adopt a re-resolved capability, preserving object identity on a same
 * answer. Consumers narrow to scalars, so identity buys skipping an App
 * re-render across a full canvas at the moment a phone wakes — not a
 * remount, which never happens either way. Pure — unit-tested.
 */
export function nextCapability(
  prev: BrowserCapability | null,
  next: BrowserCapability
): BrowserCapability {
  return prev && prev.enabled === next.enabled && prev.desktopToken === next.desktopToken
    ? prev
    : next
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
  mobile: boolean,
  scale = 1
): ViewportControlMsg {
  if (t === 'release') return { t: 'viewport-release' }
  const ask = viewScale(scale)
  return {
    t: t === 'claim' ? 'viewport-claim' : 'viewport-offer',
    width: clampViewport(viewport.width),
    height: clampViewport(viewport.height),
    mobile,
    ...(ask > 1 ? { scale: ask } : {})
  }
}

/**
 * The stream's ROOT-ABSOLUTE path, ready to be scoped like every other request.
 *
 * Split out from streamUrl so the companion's socket can go through apiPath and
 * therefore follow the data plane (data-plane.ts). It was the one long-lived
 * connection built from the page origin by hand — which was harmless while the
 * page origin WAS the transport, and is a silent bug the moment the data plane
 * can move without the address bar.
 */
export function streamPath(
  browserId: string,
  w: number,
  h: number,
  desktopToken?: string | null
): string {
  const token = desktopToken ? `&desktopToken=${encodeURIComponent(desktopToken)}` : ''
  const q = `w=${clampViewport(w)}&h=${clampViewport(h)}${token}`
  return `/api/browser/${encodeURIComponent(browserId)}/stream?${q}`
}

/**
 * ws/wss for a request URL that apiPath has already scoped.
 *
 * Two shapes arrive, one per plane. A DIRECT plane hands over an absolute
 * `https://…` URL and the scheme is simply upgraded — the socket must go to
 * the Mac, not to the origin the page happens to be served from. A RELAY plane
 * hands over a root-absolute path, which is completed with the page's own
 * origin exactly as before.
 */
export function socketUrl(pageOrigin: string, scopedUrl: string): string {
  if (/^https:\/\//i.test(scopedUrl)) return `wss://${scopedUrl.slice(8)}`
  if (/^http:\/\//i.test(scopedUrl)) return `ws://${scopedUrl.slice(7)}`
  const scheme = pageOrigin.startsWith('https') ? 'wss' : 'ws'
  return `${scheme}://${pageOrigin.replace(/^https?:\/\//, '')}${scopedUrl}`
}

/**
 * The WS URL for a browser's stream, derived from an origin (ws/wss) with
 * the requested screencast size as `w`/`h` query params (Forge's contract).
 * The desktop's route to the loopback companion server; the phone composes its
 * own through apiPath so the socket follows the data plane.
 */
export function streamUrl(
  origin: string,
  browserId: string,
  w: number,
  h: number,
  desktopToken?: string | null
): string {
  return socketUrl(origin, streamPath(browserId, w, h, desktopToken))
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

/** The soft keyboard a remote field wants. */
export type FieldMode = 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search' | 'password'
const FIELD_MODES: readonly FieldMode[] = ['text', 'numeric', 'decimal', 'tel', 'email', 'url', 'search', 'password']

/** [x, y, width, height] in FRAME px. */
export type FrameRect = [number, number, number, number]

export interface StreamFields {
  focus: { editable: boolean; rect: FrameRect | null; mode: FieldMode }
  fields: Array<{ rect: FrameRect; mode: FieldMode }>
}

function frameRect(raw: unknown): FrameRect | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, w, h] = raw as number[]
  return w > 0 && h > 0 ? [x, y, w, h] : null
}

function fieldMode(raw: unknown): FieldMode {
  return FIELD_MODES.includes(raw as FieldMode) ? (raw as FieldMode) : 'text'
}

function parseFields(obj: Record<string, unknown>): StreamFields {
  const focus = asRecord(obj.focus) ?? {}
  const editable = focus.editable === true
  const fields: StreamFields['fields'] = []
  if (Array.isArray(obj.fields)) {
    for (const entry of obj.fields.slice(0, 64)) {
      const field = asRecord(entry)
      const rect = field ? frameRect(field.rect) : null
      if (field && rect) fields.push({ rect, mode: fieldMode(field.mode) })
    }
  }
  return {
    focus: { editable, rect: editable ? frameRect(focus.rect) : null, mode: editable ? fieldMode(focus.mode) : 'text' },
    fields
  }
}

/**
 * The text field under a FRAME point, if any — decided on the phone, inside
 * the tap, because iOS raises its keyboard only for a focus made there. A few
 * px of slack: a finger is not a mouse. Pure — unit-tested.
 */
export function fieldAt(
  fields: StreamFields | null,
  point: { x: number; y: number },
  slack = 6
): { rect: FrameRect; mode: FieldMode } | null {
  if (!fields) return null
  for (const field of fields.fields) {
    const [x, y, w, h] = field.rect
    if (point.x >= x - slack && point.x <= x + w + slack && point.y >= y - slack && point.y <= y + h + slack) return field
  }
  return null
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
  /**
   * One JPEG: `src` (a data: URL) off a socket, where it rode as base64 text;
   * `bytes` straight from main over the desktop's port (browser-cast-ipc.ts).
   */
  | ({ kind: 'frame'; seq: number; src?: string; bytes?: Uint8Array } & StreamFrameMeta)
  | { kind: 'error'; msg: string }
  | { kind: 'status'; status: UseStatus }
  /** The page copied this right after the viewer's own input: it goes on the viewer's clipboard. */
  | { kind: 'copy'; text: string }
  /** Where the page's text fields are, in FRAME px of `revision` (page-fields.ts). */
  | ({ kind: 'fields'; revision: number } & StreamFields)

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
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  return parseStreamObject(obj)
}

/**
 * The same messages, already structured: what the desktop's port delivers
 * (a frame's JPEG as bytes in `jpeg`), and what a socket's JSON parses to
 * (base64 in `data`). Pure — unit-tested.
 */
export function parseStreamObject(raw: unknown): StreamMessage | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const jpeg = obj.t === 'frame' && obj.jpeg instanceof Uint8Array && obj.jpeg.byteLength > 0 ? obj.jpeg : null
  if (obj.t === 'frame' && (typeof obj.data === 'string' || jpeg)) {
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
      ...(jpeg ? { bytes: jpeg } : { src: frameDataUrl(obj.data as string) }),
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
  if (obj.t === 'fields') {
    const revision = finiteRevision(obj.revision)
    return revision === null ? null : { kind: 'fields', revision, ...parseFields(obj) }
  }
  if (obj.t === 'copy') {
    return typeof obj.text === 'string' && obj.text.length > 0 ? { kind: 'copy', text: obj.text } : null
  }
  if (obj.t === 'status') {
    const state = obj.state
    const use = obj.use
    if (state !== 'connecting' && state !== 'live' && state !== 'offline') return null
    if (use !== 'computer' && use !== 'phone' && use !== 'hardware') return null
    return {
      kind: 'status',
      status: { state, use, message: typeof obj.message === 'string' ? obj.message : null, input: obj.input === true }
    }
  }
  return null
}

/**
 * How long a viewer waits before dialling again after its socket dropped:
 * a second, doubling, never more than ten. A phone on a train, a desktop
 * restarting, a Wi-Fi hand-off — the card comes back by itself, keeping the
 * last frame on screen meanwhile, instead of staying dead until reopened.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 4)))
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

export type MouseButtonName = 'left' | 'right' | 'middle'

/** Held modifiers as CDP bits (cast-input.ts): Alt=1, Ctrl=2, Meta=4, Shift=8. */
export interface PointerOptions {
  button?: MouseButtonName
  mods?: number
}

/** Client→server input messages — the closed vocabulary Forge whitelists. */
export type CastInputMsg =
  | { t: 'tap'; x: number; y: number; count?: number; button?: MouseButtonName; mods?: number }
  | { t: 'down'; x: number; y: number; count?: number; button?: MouseButtonName; mods?: number }
  | { t: 'up'; x: number; y: number; count?: number; button?: MouseButtonName; mods?: number }
  /** A hover, or a drag while `buttons` (the DOM bitmask) are held. */
  | { t: 'move'; x: number; y: number; buttons?: number; mods?: number }
  | { t: 'wheel'; x: number; y: number; dy: number; dx?: number; mods?: number }
  /** A trackpad pinch step: zoom the page by `scale` around the point. */
  | { t: 'pinch'; x: number; y: number; scale: number }
  | { t: 'key'; key: string; code?: string; text?: string; mods?: number }
  /** Committed text: an IME's result, a paste, an autocorrect. */
  | { t: 'text'; text: string }
  /** The IME's uncommitted text, shown in the page's field as it is composed. */
  | { t: 'compose'; text: string }
  /** The viewer's clipboard: a paste event in the page, typed in if the page leaves it. */
  | { t: 'paste'; text: string }
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
  count = 1,
  options: PointerOptions = {}
): CastInputMsg {
  // count carries the click multiplicity (2 = double-click, 3 = triple) so the
  // remote page can select a word / line; move never carries it.
  const button = options.button && options.button !== 'left' ? { button: options.button } : {}
  const mods = options.mods ? { mods: options.mods } : {}
  if (t === 'move') return { t, x: p.x, y: p.y, ...mods }
  return { t, x: p.x, y: p.y, ...(count > 1 ? { count } : {}), ...button, ...mods }
}

/**
 * A mouse move at a FRAME point. With no button held it is a hover (menus,
 * tooltips, :hover); with `buttons` held it is a drag — Chromium extends a
 * selection or moves a slider only when the move names the held button.
 */
export function moveMsg(p: { x: number; y: number }, buttons = 0, mods = 0): CastInputMsg {
  // Left, right and middle only: back/forward buttons are not the page's.
  const held = buttons & 7
  return {
    t: 'move',
    x: p.x,
    y: p.y,
    ...(held > 0 ? { buttons: held } : {}),
    ...(mods ? { mods } : {})
  }
}

/** The DOM's button number (0 main, 1 middle, 2 secondary) as the wire's name. */
export function buttonName(button: number): MouseButtonName {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'
}

/** A DOM event's held modifiers as CDP bits. */
export function modsOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
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

/** Build a wheel/scroll message at a FRAME point; dx scrolls sideways (a trackpad's two-finger swipe). */
export function wheelMsg(p: { x: number; y: number }, dy: number, dx = 0, mods = 0): CastInputMsg {
  return { t: 'wheel', x: p.x, y: p.y, dy, ...(dx !== 0 ? { dx } : {}), ...(mods ? { mods } : {}) }
}

const WHEEL_LINE_PX = 16

/**
 * A wheel event's delta in CSS px. A trackpad reports pixels; a notched mouse
 * on some systems reports LINES (deltaMode 1) or PAGES (2), which forwarded
 * raw scroll the page by 3 px a notch.
 */
export function wheelDeltaPx(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeight: number
): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? Math.max(1, pageHeight) : 1
  return { dx: e.deltaX * unit, dy: e.deltaY * unit }
}

/**
 * A trackpad pinch reaches a page as ctrl+wheel; Chromium's own convention for
 * the zoom one such event means is exp(-deltaY / 100).
 */
export function pinchScaleFromWheel(deltaY: number): number {
  return Math.exp(-deltaY / 100)
}

/** A pinch step at a FRAME point. */
export function pinchMsg(p: { x: number; y: number }, scale: number): CastInputMsg {
  return { t: 'pinch', x: p.x, y: p.y, scale }
}

/** Build a key message; `text` only for printable single characters, never under ⌘/Ctrl. */
export function keyMsg(key: string, code: string, mods = 0): CastInputMsg {
  const shortcut = (mods & (2 | 4)) !== 0
  return {
    t: 'key',
    key,
    code,
    ...(key.length === 1 && !shortcut ? { text: key } : {}),
    ...(mods ? { mods } : {})
  }
}

/** Committed text as typing (an IME's result, a paste); null when there is nothing to send. */
export function textMsg(text: string): CastInputMsg | null {
  return text.length > 0 ? { t: 'text', text: text.slice(0, MAX_TEXT_MSG) } : null
}

/** A paste from this device's clipboard; null when there is nothing to paste. */
export function pasteMsg(text: string): CastInputMsg | null {
  return text.length > 0 ? { t: 'paste', text: text.slice(0, MAX_TEXT_MSG) } : null
}

/** The IME's in-progress text, shown live in the page's field. */
export function composeMsg(text: string): CastInputMsg {
  return { t: 'compose', text: text.slice(0, MAX_COMPOSE_MSG) }
}

/** The server's bounds (cast-input.ts): a paste longer than this is cut, not refused. */
export const MAX_TEXT_MSG = 4096
const MAX_COMPOSE_MSG = 256

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
