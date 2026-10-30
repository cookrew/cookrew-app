import type { CdpInputCommand } from '../shared/cast-input'

/**
 * THE CLOSED INPUT VOCABULARY, SPOKEN TO A PHONE.
 *
 * The cast hands every instance the same CDP literals (shared/cast-input.ts)
 * in viewport points. A phone has no mouse, so a gesture is read off the
 * sequence: a press and release in one place is a tap, a press that
 * travelled is a swipe timed by the gesture, a wheel is a swipe of its
 * delta, a key is the name vphoned knows, and printable text is typed.
 * Nothing else gets through — the vocabulary is as closed on this side as
 * on the wire.
 *
 * Pure and stateful only about the gesture in flight, so it is tested
 * without a VM.
 */

export interface VphoneCall {
  readonly method: 'input.tap' | 'input.swipe' | 'input.key' | 'input.type' | 'input.paste'
  readonly params: Record<string, number | string>
}

export interface ScreenPoints {
  readonly width: number
  readonly height: number
}

/** A release this close to its press is a tap, not a swipe. */
export const TAP_SLOP_PT = 10
export const SWIPE_MIN_SECONDS = 0.1
export const SWIPE_MAX_SECONDS = 2
export const WHEEL_SWIPE_SECONDS = 0.2

const KEY_NAMES: Record<string, string> = {
  Enter: 'return',
  Backspace: 'delete',
  Tab: 'tab',
  Escape: 'escape',
  Space: 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

/** The vphoned `input.key` name for a browser key, or null for one a phone has no key for. */
export const vphoneKeyName = (key: string): string | null => KEY_NAMES[key] ?? null

const isAsciiPrintable = (text: string): boolean => /^[\x20-\x7e]+$/.test(text)

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

interface Press {
  readonly x: number
  readonly y: number
  readonly at: number
}

export class VphoneGestureMapper {
  private press: Press | null = null
  private ignoring = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly screen: ScreenPoints = { width: 430, height: 932 }
  ) {}

  map(command: CdpInputCommand): VphoneCall[] {
    switch (command.method) {
      case 'Input.dispatchMouseEvent':
        return this.mouse(command.params)
      case 'Input.dispatchTouchEvent':
        return this.touch(command.params)
      case 'Input.dispatchKeyEvent':
        return this.key(command.params)
      default:
        return []
    }
  }

  private mouse(params: Record<string, unknown>): VphoneCall[] {
    const x = num(params.x)
    const y = num(params.y)
    switch (params.type) {
      case 'mousePressed':
        if (x === null || y === null) return []
        this.press = { x, y, at: this.now() }
        return []
      case 'mouseReleased':
        return x === null || y === null ? [] : this.release(x, y)
      case 'mouseWheel': {
        const dy = num(params.deltaY)
        if (x === null || y === null || dy === null || dy === 0) return []
        const toY = Math.min(Math.max(y - dy, 0), this.screen.height)
        return [swipe(x, y, x, toY, WHEEL_SWIPE_SECONDS)]
      }
      default:
        return []
    }
  }

  private touch(params: Record<string, unknown>): VphoneCall[] {
    const points = Array.isArray(params.touchPoints) ? (params.touchPoints as Array<Record<string, unknown>>) : []
    switch (params.type) {
      case 'touchStart': {
        // Two fingers would be a pinch. Not spoken yet: drop the whole
        // gesture rather than send half of it as a tap.
        if (points.length !== 1) {
          this.ignoring = true
          this.press = null
          return []
        }
        const x = num(points[0].x)
        const y = num(points[0].y)
        if (x === null || y === null) return []
        this.ignoring = false
        this.press = { x, y, at: this.now() }
        this.last = { x, y }
        return []
      }
      case 'touchMove': {
        if (this.ignoring || points.length !== 1) return []
        const x = num(points[0].x)
        const y = num(points[0].y)
        if (x !== null && y !== null) this.last = { x, y }
        return []
      }
      case 'touchEnd': {
        if (this.ignoring) {
          this.ignoring = false
          return []
        }
        const end = this.last
        this.last = null
        return end ? this.release(end.x, end.y) : []
      }
      default:
        return []
    }
  }

  private last: { x: number; y: number } | null = null

  private release(x: number, y: number): VphoneCall[] {
    const press = this.press
    this.press = null
    if (!press) return []
    const travelled = Math.hypot(x - press.x, y - press.y)
    if (travelled < TAP_SLOP_PT) return [tap(x, y)]
    const elapsed = (this.now() - press.at) / 1000
    const seconds = Math.min(SWIPE_MAX_SECONDS, Math.max(SWIPE_MIN_SECONDS, Math.round(elapsed * 100) / 100))
    return [swipe(press.x, press.y, x, y, seconds)]
  }

  private key(params: Record<string, unknown>): VphoneCall[] {
    if (params.type !== 'keyDown') return []
    const text = typeof params.text === 'string' ? params.text : ''
    const key = typeof params.key === 'string' ? params.key : ''
    const named = vphoneKeyName(key)
    if (named) return [{ method: 'input.key', params: { name: named } }]
    if (text.length === 0) return []
    return isAsciiPrintable(text)
      ? [{ method: 'input.type', params: { text } }]
      : [{ method: 'input.paste', params: { text } }]
  }
}

const tap = (x: number, y: number): VphoneCall => ({
  method: 'input.tap',
  params: { x: Math.round(x), y: Math.round(y) }
})

const swipe = (x1: number, y1: number, x2: number, y2: number, seconds: number): VphoneCall => ({
  method: 'input.swipe',
  params: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), seconds }
})
