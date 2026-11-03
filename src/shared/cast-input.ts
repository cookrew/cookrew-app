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
  method:
    | 'Input.dispatchMouseEvent'
    | 'Input.dispatchKeyEvent'
    | 'Input.dispatchTouchEvent'
    /** Committed text: an IME's result, a paste, an autocorrect — typing, not a key. */
    | 'Input.insertText'
    /** The IME's uncommitted text, shown in the page's field while it is composed. */
    | 'Input.imeSetComposition'
    /** A trackpad pinch: the visual viewport zooms, the page sees ctrl+wheel like real Chrome. */
    | 'Input.synthesizePinchGesture'
  params: Record<string, unknown>
}

export interface MapContext {
  /** Frame px per visual-viewport CSS px, including pinch zoom. */
  displayScale: number
  /** Page CSS viewport bounds, for clamping. */
  viewportWidth: number
  viewportHeight: number
}

/** Largest single wheel delta and key text we accept (anti-abuse bounds). */
const MAX_WHEEL_DELTA = 10_000
const MAX_KEY_TEXT = 8
/** A paste or an IME commit: typing-sized, never a bulk payload. */
export const MAX_INSERT_TEXT = 4096
/** An IME composition is a word or a phrase being composed. */
const MAX_COMPOSE_TEXT = 256
/** One pinch step's zoom factor; a gesture is many small steps. */
const MIN_PINCH_SCALE = 0.25
const MAX_PINCH_SCALE = 4
/** Fast enough that a step lands well inside a frame or two (~70 ms measured). */
const PINCH_RELATIVE_SPEED = 20_000

/** CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export const MOD_ALT = 1
export const MOD_CTRL = 2
export const MOD_META = 4
export const MOD_SHIFT = 8

/**
 * Virtual key codes for keys whose EFFECT (delete, submit, cursor move) the
 * browser drives from the key code, not the `text` field. Without these, CDP
 * dispatches a Backspace/Enter/arrow event the page SEES but does not ACT on —
 * which is why Backspace never deleted. Printable characters still carry `text`.
 */
const VK_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** The held modifiers as CDP bits, or 0 for anything that is not a 4-bit mask. */
function modifiersOf(msg: Record<string, unknown>): number {
  const m = msg.mods
  return Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 15 ? (m as number) : 0
}

/** Adds `modifiers` only when one is held, so plain input keeps its old exact shape. */
function withModifiers(msg: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const modifiers = modifiersOf(msg)
  return modifiers ? { ...extra, modifiers } : extra
}

type MouseButton = 'left' | 'right' | 'middle'

function buttonOf(msg: Record<string, unknown>): MouseButton {
  return msg.button === 'right' || msg.button === 'middle' ? msg.button : 'left'
}

/**
 * The buttons held during a move, as the DOM's bitmask (1 left, 2 right,
 * 4 middle). A drag needs it: Chromium only extends a text selection, moves a
 * slider or drags an element when mouseMoved names the pressed button.
 */
function heldButtons(msg: Record<string, unknown>): Record<string, unknown> {
  const b = msg.buttons
  if (!Number.isInteger(b) || (b as number) <= 0 || (b as number) > 7) return {}
  const buttons = b as number
  const button: MouseButton = buttons & 1 ? 'left' : buttons & 2 ? 'right' : 'middle'
  return { button, buttons }
}

/**
 * Editing shortcuts a headless Chrome does not bind by itself: on a Mac the
 * menu, not the page, turns ⌘A into Select All, so a dispatched ⌘A was a key
 * the page saw and nothing did. Chromium takes the command by name alongside
 * the key. Derived HERE from the key and its modifiers — the wire never names a
 * command, so a client cannot ask for one this table does not list.
 */
const EDIT_COMMANDS: Record<string, string> = {
  'Meta+KeyA': 'selectAll',
  'Meta+KeyC': 'copy',
  'Meta+KeyX': 'cut',
  'Meta+KeyZ': 'undo',
  'Meta+Shift+KeyZ': 'redo',
  'Ctrl+KeyA': 'selectAll',
  'Ctrl+KeyC': 'copy',
  'Ctrl+KeyX': 'cut',
  'Ctrl+KeyZ': 'undo',
  'Ctrl+KeyY': 'redo',
  'Ctrl+Shift+KeyZ': 'redo',
  'Meta+ArrowLeft': 'moveToBeginningOfLine',
  'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+Shift+ArrowLeft': 'moveToBeginningOfLineAndModifySelection',
  'Meta+Shift+ArrowRight': 'moveToEndOfLineAndModifySelection',
  'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Meta+Delete': 'deleteToEndOfLine'
}

/** `KeyA` and `Digit1` are named by code; arrows and the like by key. */
function editCommand(key: string, code: string | undefined, modifiers: number): string | undefined {
  if (modifiers === 0 || modifiers === MOD_SHIFT) return undefined
  const prefix = [
    modifiers & MOD_META ? 'Meta' : '',
    modifiers & MOD_CTRL ? 'Ctrl' : '',
    modifiers & MOD_ALT ? 'Alt' : '',
    modifiers & MOD_SHIFT ? 'Shift' : ''
  ].filter(Boolean).join('+')
  const name = code && /^Key[A-Z]$/.test(code) ? code : key
  return EDIT_COMMANDS[`${prefix}+${name}`]
}

/** Letters and digits carry their virtual key code too: pages and games read keyCode. */
function codeVirtualKey(code: string | undefined): number | undefined {
  if (!code) return undefined
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].charCodeAt(0)
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1].charCodeAt(0)
  return undefined
}

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
function pressButton(msg: Record<string, unknown>): Record<string, unknown> {
  const c = msg.count
  const clickCount = Number.isInteger(c) && (c as number) >= 1 && (c as number) <= 3 ? (c as number) : 1
  return withModifiers(msg, { button: buttonOf(msg), clickCount })
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
 * A paste from the viewer's clipboard: `{t:'paste', text}`. Not a CDP command
 * — the cast hands it to the instance's typed paste (a page paste event, then
 * Input.insertText), so it is validated here with the rest of the wire.
 */
export function sanitizePaste(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t !== 'paste' || typeof msg.text !== 'string') return null
  return msg.text.length > 0 && msg.text.length <= MAX_INSERT_TEXT ? msg.text : null
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
      const btn = pressButton(msg)
      return p ? [mouse('mousePressed', p, btn), mouse('mouseReleased', p, btn)] : null
    }
    case 'down': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mousePressed', p, pressButton(msg))] : null
    }
    case 'up': {
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mouseReleased', p, pressButton(msg))] : null
    }
    case 'move': {
      // A bare move is a hover; one with `buttons` is a drag.
      const p = toPagePoint(msg, ctx)
      return p ? [mouse('mouseMoved', p, withModifiers(msg, heldButtons(msg)))] : null
    }
    case 'wheel': {
      const p = toPagePoint(msg, ctx)
      if (!p || !isFiniteNumber(msg.dy)) return null
      if (msg.dx !== undefined && !isFiniteNumber(msg.dx)) return null
      const deltaY = clamp(msg.dy, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)
      const deltaX = isFiniteNumber(msg.dx) ? clamp(msg.dx, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) : 0
      return [mouse('mouseWheel', p, withModifiers(msg, { deltaX, deltaY }))]
    }
    case 'pinch': {
      const p = toPagePoint(msg, ctx)
      if (!p || !isFiniteNumber(msg.scale) || msg.scale <= 0) return null
      return [{
        method: 'Input.synthesizePinchGesture',
        params: {
          x: p.x,
          y: p.y,
          scaleFactor: clamp(msg.scale, MIN_PINCH_SCALE, MAX_PINCH_SCALE),
          relativeSpeed: PINCH_RELATIVE_SPEED,
          gestureSourceType: 'mouse'
        }
      }]
    }
    case 'key': {
      if (typeof msg.key !== 'string' || msg.key.length === 0 || msg.key.length > 32) return null
      const modifiers = modifiersOf(msg)
      // A shortcut types nothing: ⌘A selects, it does not insert an "a".
      const shortcut = (modifiers & (MOD_CTRL | MOD_META)) !== 0
      const rawText = typeof msg.text === 'string' ? msg.text : undefined
      if (rawText !== undefined && rawText.length > MAX_KEY_TEXT) return null
      const text = shortcut ? undefined : rawText
      const code = typeof msg.code === 'string' && msg.code.length <= 32 ? msg.code : undefined
      const vk = VK_CODES[msg.key] ?? codeVirtualKey(code)
      const command = editCommand(msg.key, code, modifiers)
      const base: Record<string, unknown> = {
        key: msg.key,
        ...(code ? { code } : {}),
        ...(text ? { text } : {}),
        ...(modifiers ? { modifiers } : {}),
        // Non-text keys need the virtual key code or the browser won't act on
        // them (Backspace won't delete, Enter won't submit, arrows won't move).
        ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {})
      }
      return [
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...base, ...(command ? { commands: [command] } : {}) } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } }
      ]
    }
    case 'text': {
      // Committed text — an IME's result, a paste, a phone's autocorrect —
      // goes in as typing, whole. Per-character keys split a CJK word.
      if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > MAX_INSERT_TEXT) return null
      return [{ method: 'Input.insertText', params: { text: msg.text } }]
    }
    case 'compose': {
      // The IME's uncommitted text, shown in the field as it is composed; an
      // empty one clears it (the composition was cancelled).
      if (typeof msg.text !== 'string' || msg.text.length > MAX_COMPOSE_TEXT) return null
      const end = msg.text.length
      return [{ method: 'Input.imeSetComposition', params: { text: msg.text, selectionStart: end, selectionEnd: end } }]
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
