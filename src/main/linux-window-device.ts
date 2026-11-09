import { windowAppName, type UseTarget } from '../shared/use-url'
import { LINUX_WINDOWS_NEED_XDOTOOL } from '../shared/remote-access'
import { NO_WHEEL, xdotoolCalls, type DisplayArea, type LinuxHand, type WheelCarry } from './linux-input'
import { activeWindow, findX11Window, listX11Windows, lookupX11Window, windowFocusCalls, type X11Deps, type X11Window } from './linux-windows'
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
 * WHERE THE WINDOW IS is asked at most once a second for frames, and afresh
 * inside the hand's own turn for every gesture (nothing of another card's runs
 * between that read and the press): it moves, it resizes, it closes. A point is
 * a ratio of the last picture laid on the window where it is NOW, and stops at
 * its edge. A window that changed size, or moved off the screen, since the
 * picture is not pressed until the next picture: the old one no longer says
 * what is where.
 *
 * THE SAME WINDOW. X gives a closed window's id to the next window made, often
 * another app's. The card remembers the app and process it was bound to, and a
 * window under that id with another one is the bound window gone.
 *
 * IN FRONT. Before any input the window is brought to the front and given the
 * keyboard (linux-windows.ts · windowFocusCalls). If it was not in front, the
 * picture may have shown another window over it, so that first press only
 * brings it forward and asks again, as a Mac card asks for a tap first. In
 * front means the last window Cookrew raised and, with a window manager, also
 * the active one, checked again after asking. A program that raises its own
 * window over this one, without Cookrew, is not seen: that press lands on this
 * window, raised, where the picture showed the other.
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

/** Which window Cookrew last raised, shared by every window card: with no window manager, that is the one in front. */
export interface WindowStack {
  front(): number | null
  raised(id: number): void
}

export function windowStack(): WindowStack {
  let front: number | null = null
  return {
    front: () => front,
    raised: (id) => {
      front = id
    }
  }
}

export interface LinuxWindowDeps {
  remote: RemoteGate
  hand: LinuxHand
  stack: WindowStack
  /** The X screen's extent in pixels, null when it cannot be told: nothing is pressed off it. */
  screen(): DisplayArea | null
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
  /** The window's own size when it was pictured. */
  readonly windowWidth: number
  readonly windowHeight: number
}

/** The app and process a bound card first saw under its id. */
interface Identity {
  readonly app: string
  readonly pid: number | null
}

const inside = (inner: DisplayArea, outer: DisplayArea): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

const POINTER_METHODS = new Set(['input.tap', 'input.swipe', 'input.scroll'])

export class LinuxWindowDevice implements PixelDevice {
  readonly remote: RemoteGate
  readonly readClipboard?: () => string
  private window: X11Window | null = null
  private lookedAt = Number.NEGATIVE_INFINITY
  private shown: Shown | null = null
  private identity: Identity | null = null
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

  private gone(): DeviceGoneError {
    this.window = null
    return new DeviceGoneError('window', `The '${this.target.name}' window this card showed has closed`)
  }

  private async bound(id: number, x: X11Deps): Promise<X11Window> {
    const found = await lookupX11Window(id, x, this.identity?.app)
    if (found.state === 'gone') throw this.gone()
    if (found.state === 'hidden') {
      this.window = null
      throw new Error(`The '${this.target.name}' window is minimised or hidden — bring it back to see it here`)
    }
    const window = found.window
    // The id came round again: another app, or the same app's new process, under the old number.
    const held = this.identity
    if (held === null) {
      if (windowAppName(window.app).toLowerCase() !== this.target.name.toLowerCase()) throw this.gone()
      this.identity = { app: window.app, pid: window.pid }
    } else if (held.pid !== null && window.pid !== null && held.pid !== window.pid) {
      throw this.gone()
    }
    return window
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
      rectHeight: picture.rect.height,
      windowWidth: window.width,
      windowHeight: window.height
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
    const stopped = (): string | null => this.remote.inputRefusal() ?? this.remote.agentRefusal()
    await this.deps.hand.exclusive(async (run) => {
      // Where the window is now, read inside this turn: nothing else presses before we do.
      const window = await this.resolve(true)
      const area = this.areaFor(window)
      const { calls, wheel } = xdotoolCalls(gesture, this.shown as Shown, area, this.wheel)
      await this.toFront(window, run, stopped)
      this.wheel = wheel
      await run(calls, stopped)
    })
  }

  /** Where the last picture lies on the window now; refused when that picture no longer says what is where. */
  private areaFor(window: X11Window): DisplayArea {
    const shown = this.shown
    if (!shown) throw new Error(`The screen capturer gave no picture of the '${this.target.name}' window`)
    if (window.width !== shown.windowWidth || window.height !== shown.windowHeight) {
      this.shown = null
      throw new Error(`The '${this.target.name}' window changed size: look at it again, then press`)
    }
    const area: DisplayArea = { x: window.x + shown.dx, y: window.y + shown.dy, width: shown.rectWidth, height: shown.rectHeight }
    const screen = this.deps.screen()
    if (screen && !inside(area, screen)) {
      this.shown = null
      throw new Error(`The '${this.target.name}' window moved off the screen: look at it again, then press`)
    }
    return area
  }

  /**
   * The window to the front, and the keyboard to it. A press on a window that was
   * not in front would land on what the picture showed over it: that first press
   * only brings it forward.
   */
  private async toFront(window: X11Window, run: Parameters<Parameters<LinuxHand['exclusive']>[0]>[0], stopped: () => string | null): Promise<void> {
    const x = this.x11()
    const active = await activeWindow(x)
    const managed = active !== null
    // Active is not on top: a window that takes no keys (xeyes) can be raised over the active one.
    // So it must also be the one Cookrew raised last. Another program raising itself is not seen.
    const wasFront = (!managed || active === window.id) && this.deps.stack.front() === window.id
    const focus = windowFocusCalls(window.id)
    await run([focus.optional, focus.required], stopped)
    this.deps.stack.raised(window.id)
    if (managed && (await activeWindow(x)) !== window.id) {
      throw new Error(`The window manager would not bring the '${this.target.name}' window to the front, so nothing was pressed`)
    }
    if (!wasFront) throw new Error(`Brought the '${this.target.name}' window to the front: look at it again, then press`)
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
