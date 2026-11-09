import type { UseTarget } from '../shared/use-url'
import { LINUX_WINDOWS_NEED_XDOTOOL } from '../shared/remote-access'
import { NO_WHEEL, xdotoolCalls, type DisplayArea, type LinuxHand, type WheelCarry } from './linux-input'
import { findX11Window, listX11Windows, lookupX11Window, windowFocusCalls, type X11Deps, type X11Window } from './linux-windows'
import { DeviceBlockedError, DeviceGoneError, type PixelDevice, type PixelFrame, type RemoteGate } from './pixel-instance'
import type { Gesture, ScreenPoints } from './vphone-input'

/**
 * ONE X11 WINDOW, AS A PIXEL DEVICE (window://App?id=<X window id>).
 *
 * A Mac window card is captured by its window id. Chromium's X11 window
 * capturer lists only windows a window manager has marked, so on a bare Xvfb
 * (Solis) it lists nothing; instead the card is a crop of the screen where the
 * window is. The picture is then what the screen shows there: a window on top
 * of it shows too, and the input below raises this one first.
 *
 * WHERE THE WINDOW IS is asked at most once a second for frames and afresh
 * before every gesture: it moves, it resizes, it closes. A point is a ratio of
 * the last picture laid on the window where it is NOW, and stops at its edge:
 * nothing is pressed outside the window's rectangle. A window partly off the
 * screen was pictured only where it is on it; input keeps that same part.
 *
 * BEFORE ANY INPUT the window comes to the front and takes the keyboard
 * (linux-windows.ts · windowFocusCalls says why it is done that way).
 *
 * THE DESK DECIDES, as for a screen card: the machine switch, the card's grant,
 * Stop, a served workspace (remote-desk.ts). A closed window is DeviceGoneError,
 * so the card offers the screen or another window, the same as on a Mac.
 */

export const LINUX_NO_WINDOW_REGION = 'A region of one window cannot be shown on Linux yet: share the whole window'
const RELIST_MS = 1000

export interface WindowPicture {
  readonly jpeg: Buffer
  /** The picture's size: what a point on the card is a fraction of. */
  readonly width: number
  readonly height: number
  /** The part of the X screen it is of: the window, cut to the display it is on. */
  readonly rect: DisplayArea
}

export interface LinuxWindowDeps {
  remote: RemoteGate
  hand: LinuxHand
  /** How to ask X about windows; null when xdotool is not installed. */
  x11(): X11Deps | null
  /** A picture of this part of the X screen (root pixels), fitted to a long side; null when none could be taken. */
  crop(rect: DisplayArea): Promise<WindowPicture | null>
  readClipboard?: () => string
  now?: () => number
}

/** The last picture: its size, and where in the window it was taken, so input lands on the same part. */
interface Shown {
  readonly width: number
  readonly height: number
  readonly dx: number
  readonly dy: number
  readonly rectWidth: number
  readonly rectHeight: number
}

export class LinuxWindowDevice implements PixelDevice {
  readonly remote: RemoteGate
  readonly readClipboard?: () => string
  private window: X11Window | null = null
  private lookedAt = Number.NEGATIVE_INFINITY
  private shown: Shown | null = null
  private wheel: WheelCarry = NO_WHEEL
  private readonly now: () => number

  constructor(
    readonly target: UseTarget,
    private readonly deps: LinuxWindowDeps
  ) {
    this.remote = deps.remote
    this.readClipboard = deps.readClipboard
    this.now = deps.now ?? Date.now
  }

  private x11(): X11Deps {
    const x = this.deps.x11()
    if (!x) throw new Error(LINUX_WINDOWS_NEED_XDOTOOL)
    return x
  }

  private async mustBeReadable(): Promise<void> {
    const blocked = await this.remote.blocked()
    if (blocked) throw new DeviceBlockedError(blocked)
  }

  /** The window as it is now, or the reason it cannot be shown. */
  private async resolve(force = false): Promise<X11Window> {
    if (this.target.roi) throw new Error(LINUX_NO_WINDOW_REGION)
    if (!force && this.window && this.now() - this.lookedAt < RELIST_MS) return this.window
    const x = this.x11()
    const window = this.target.windowId !== undefined ? await this.bound(this.target.windowId, x) : this.named(await listX11Windows(x))
    this.window = window
    this.lookedAt = this.now()
    return window
  }

  private async bound(id: number, x: X11Deps): Promise<X11Window> {
    const found = await lookupX11Window(id, x)
    if (found.state === 'shown') return found.window
    this.window = null
    if (found.state === 'hidden') throw new Error(`The '${this.target.name}' window is minimised or hidden — bring it back to see it here`)
    throw new DeviceGoneError('window', `The '${this.target.name}' window this card showed has closed`)
  }

  private named(windows: readonly X11Window[]): X11Window {
    const window = findX11Window(windows, this.target.name, this.target.detail)
    if (window) return window
    const what = this.target.detail ? `'${this.target.name}' window titled '${this.target.detail}'` : `'${this.target.name}' window`
    throw new Error(`No ${what} is on screen — open it first`)
  }

  async open(): Promise<ScreenPoints> {
    const { points } = await this.picture()
    return points
  }

  async capture(): Promise<PixelFrame> {
    const { jpeg, points, subject } = await this.picture()
    return { jpeg, points, subject }
  }

  private async picture(): Promise<{ jpeg: string; points: ScreenPoints; subject: number }> {
    await this.mustBeReadable()
    const window = await this.resolve()
    const picture = await this.deps.crop({ x: window.x, y: window.y, width: window.width, height: window.height })
    if (!picture) throw new Error(`The screen capturer gave no picture of the '${this.target.name}' window — is it on a display?`)
    this.shown = {
      width: picture.width,
      height: picture.height,
      dx: picture.rect.x - window.x,
      dy: picture.rect.y - window.y,
      rectWidth: picture.rect.width,
      rectHeight: picture.rect.height
    }
    return { jpeg: picture.jpeg.toString('base64'), points: { width: picture.width, height: picture.height }, subject: window.id }
  }

  inputRefusal(): string | null {
    return this.deps.remote.inputRefusal() ?? this.deps.hand.refusal()
  }

  async perform(gesture: Gesture): Promise<void> {
    const refusal = this.inputRefusal()
    if (refusal) throw new Error(refusal)
    await this.mustBeReadable()
    // A point is a ratio of a picture: with none yet, take one, so it is of what is there.
    if (!this.shown) await this.picture()
    // Where the window is now: it may have moved since the picture.
    const window = await this.resolve(true)
    const shown = this.shown as Shown | null
    if (!shown) throw new Error(`The screen capturer gave no picture of the '${this.target.name}' window`)
    const area: DisplayArea = { x: window.x + shown.dx, y: window.y + shown.dy, width: Math.min(shown.rectWidth, window.width), height: Math.min(shown.rectHeight, window.height) }
    const { calls, wheel } = xdotoolCalls(gesture, shown, area, this.wheel)
    this.wheel = wheel
    const focus = windowFocusCalls(window.id)
    // Asked again before each xdotool run: Stop, or the switch going off, cuts a long paste short.
    await this.deps.hand.send([focus.optional, focus.required, ...calls], () => this.remote.inputRefusal() ?? this.remote.agentRefusal())
  }

  title(): string {
    const w = this.window
    if (!w) return this.target.name
    return w.title && w.title !== w.app ? `${w.app} — ${w.title}` : w.app
  }

  /** For `status`: what stands in the way, with no picture taken. */
  async probe(): Promise<void> {
    await this.mustBeReadable()
    await this.resolve(true)
  }

  /** Which window this is stays; where it was does not. */
  rest(): void {
    this.window = null
    this.lookedAt = Number.NEGATIVE_INFINITY
    this.shown = null
    this.wheel = NO_WHEEL
  }
}
