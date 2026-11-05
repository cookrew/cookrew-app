import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Roi, UseTarget } from '../shared/use-url'
import { windowAppName } from '../shared/use-url'
import { macKeyCode, type MacInput, type MacOp, type MacScreens, type MacWindow } from './mac-bridge'
import { DeviceGoneError, type PixelDevice, type PixelFrame } from './pixel-instance'
import type { Gesture, ScreenPoints } from './vphone-input'

/**
 * A REGION OF THIS MAC'S SCREEN, AS A PIXEL DEVICE (computer use).
 *
 * `screen://` is a display, `window://<app>[/<title>]` a window — each with
 * an optional `roi` in its own points. The region is resolved to GLOBAL
 * points (the space both `screencapture -R` and CGEvent speak), captured, and
 * every gesture is translated from region points to global points and
 * CLAMPED to the region: a viewer's drag that wanders off the card's frame
 * stops at its edge rather than landing on whatever else is on the desktop.
 *
 * A window is captured by its id (`screencapture -l`), so the card keeps
 * showing it when another window covers it; a display region is captured by
 * rectangle. The window is looked up again at most once a second — it moves,
 * it resizes, it closes and reopens with a new id — and before any input
 * whose last lookup is older than that, so a click never lands where the
 * window used to be.
 *
 * A BOUND CARD (`?id=`, what the picker writes) holds that one window. Its
 * id must still be on screen and still be the app's; nothing else of that
 * name stands in. Missing from the on-screen list it is asked after directly:
 * alive but off screen is an ordinary offline that recovers by itself, and
 * only a window macOS no longer knows is gone (DeviceGoneError).
 *
 * TWO GRANTS GATE IT, and each refusal is a sentence: Screen Recording (no
 * frames, no titles without it), and input, which is off unless the owner
 * set COOKREW_COMPUTER_INPUT=1 — a viewer that may drive this Mac is a
 * decision, never a default — and then also needs Accessibility.
 */

export interface ScreenDeps {
  list(): Promise<MacScreens>
  /** The app holding this window id anywhere (off screen too), or null when macOS no longer knows it. */
  windowAlive(id: number): Promise<{ readonly app: string } | null>
  /** Runs `screencapture` with these args; the file is the last one. */
  capture(args: readonly string[]): Promise<void>
  read(file: string): Promise<Buffer>
  remove(file: string): Promise<void>
  /** JPEG in, JPEG out: crop (as FRACTIONS of the image, 0..1) then fit the long side. */
  encode(jpeg: Buffer, crop: Roi | null, maxSide: number): Buffer
  screenAccess(): string
  inputEnabled(): boolean
  accessibility(): boolean
  hand(): MacInput
  now?: () => number
  tmp?: string
}

export const SCREEN_FRAME_MAX_SIDE = 1920
const RELIST_MS = 1000

export const SCREEN_RECORDING_OFF =
  'Screen Recording is off for Cookrew — turn it on in System Settings › Privacy & Security › Screen & System Audio Recording, then restart Cookrew'
export const COMPUTER_INPUT_OFF =
  'Driving this Mac is off — start Cookrew with COOKREW_COMPUTER_INPUT=1 to let viewers and agents click and type here'
export const ACCESSIBILITY_OFF =
  'Accessibility is off for Cookrew — turn it on in System Settings › Privacy & Security › Accessibility'

const sameApp = (a: string, b: string): boolean => windowAppName(a).toLowerCase() === windowAppName(b).toLowerCase()

/** The window an address names: exact app name first, then a name that contains it; the title must contain the detail. Front-most wins. */
export function findWindow(windows: readonly MacWindow[], app: string, title: string | null): MacWindow | null {
  const wanted = app.toLowerCase()
  const titled = (w: MacWindow): boolean => title === null || w.title.toLowerCase().includes(title.toLowerCase())
  return (
    windows.find((w) => w.app.toLowerCase() === wanted && titled(w)) ??
    windows.find((w) => w.app.toLowerCase().includes(wanted) && titled(w)) ??
    null
  )
}

interface Region {
  /** Global points of the region's top-left, and its size. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** For a window: its id and its own bounds (the roi is inside them). */
  readonly window: MacWindow | null
}

/** A roi inside an area, clipped to it; null when nothing of it is inside. */
export function clipRoi(area: { width: number; height: number }, roi: Roi | null): Roi | null {
  if (!roi) return { x: 0, y: 0, width: area.width, height: area.height }
  const x = Math.min(roi.x, area.width)
  const y = Math.min(roi.y, area.height)
  const width = Math.min(roi.width, area.width - x)
  const height = Math.min(roi.height, area.height - y)
  return width >= 16 && height >= 16 ? { x, y, width, height } : null
}

export class ScreenDevice implements PixelDevice {
  private region: Region | null = null
  private screens: MacScreens | null = null
  private listedAt = Number.NEGATIVE_INFINITY
  private readonly file: string
  private readonly now: () => number

  constructor(
    readonly target: UseTarget,
    private readonly deps: ScreenDeps
  ) {
    this.now = deps.now ?? Date.now
    this.file = path.join(deps.tmp ?? tmpdir(), `cookrew-roi-${randomUUID()}.jpg`)
  }

  private async resolve(force = false): Promise<Region> {
    if (!force && this.region && this.now() - this.listedAt < RELIST_MS) return this.region
    if (this.deps.screenAccess() !== 'granted') throw new Error(SCREEN_RECORDING_OFF)
    const screens = await this.deps.list()
    this.screens = screens
    this.listedAt = this.now()
    let area: { x: number; y: number; width: number; height: number }
    let window: MacWindow | null = null
    if (this.target.kind === 'window') {
      window = this.target.windowId ? await this.boundWindow(screens, this.target.windowId) : this.namedWindow(screens)
      area = window
    } else {
      const index = this.target.name === 'main' ? 1 : Number(this.target.name)
      const display = screens.displays.find((d) => d.index === index)
      if (!display) throw new Error(`Display ${this.target.name} is not connected (this Mac has ${screens.displays.length})`)
      area = display
    }
    const roi = clipRoi(area, this.target.roi)
    if (!roi) throw new Error(`The region ${JSON.stringify(this.target.roi)} lies outside the ${this.target.kind}`)
    this.region = { x: area.x + roi.x, y: area.y + roi.y, width: roi.width, height: roi.height, window }
    return this.region
  }

  private namedWindow(screens: MacScreens): MacWindow {
    const window = findWindow(screens.windows, this.target.name, this.target.detail)
    if (window) return window
    const what = this.target.detail ? `'${this.target.name}' window titled '${this.target.detail}'` : `'${this.target.name}' window`
    throw new Error(`No ${what} is on screen — open it, or bring it to this Space`)
  }

  /** The bound window, or the reason it cannot be shown. A failed lookup throws as itself: that proves nothing closed. */
  private async boundWindow(screens: MacScreens, id: number): Promise<MacWindow> {
    const closed = new DeviceGoneError('window', `The '${this.target.name}' window this card showed has closed`)
    const window = screens.windows.find((w) => w.id === id)
    if (window) {
      if (!sameApp(window.app, this.target.name)) throw closed
      return window
    }
    const alive = await this.deps.windowAlive(id)
    if (!alive || !sameApp(alive.app, this.target.name)) throw closed
    throw new Error(`The '${this.target.name}' window is minimised or on another Space — bring it back to see it here`)
  }

  async open(): Promise<ScreenPoints> {
    const region = await this.resolve(true)
    return { width: region.width, height: region.height }
  }

  async capture(): Promise<PixelFrame> {
    const region = await this.resolve()
    const args = region.window
      ? ['-x', '-o', '-t', 'jpg', `-l${region.window.id}`, this.file]
      : ['-x', '-t', 'jpg', `-R${region.x},${region.y},${region.width},${region.height}`, this.file]
    try {
      await this.deps.capture(args)
      const raw = await this.deps.read(this.file)
      // A window image is the whole window; its roi is cut out as a fraction
      // of it, which needs no knowledge of the display's pixel scale.
      const w = region.window
      const crop =
        w && this.target.roi
          ? { x: (region.x - w.x) / w.width, y: (region.y - w.y) / w.height, width: region.width / w.width, height: region.height / w.height }
          : null
      const jpeg = this.deps.encode(raw, crop, SCREEN_FRAME_MAX_SIDE)
      return { jpeg: jpeg.toString('base64'), points: { width: region.width, height: region.height } }
    } catch (error) {
      // The window may be gone: look it up afresh next time.
      this.listedAt = Number.NEGATIVE_INFINITY
      if (this.deps.screenAccess() !== 'granted') throw new Error(SCREEN_RECORDING_OFF)
      // A bound window: say what happened to it, not what screencapture said.
      if (this.target.windowId) await this.resolve(true)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      await this.deps.remove(this.file).catch(() => undefined)
    }
  }

  inputRefusal(): string | null {
    if (!this.deps.inputEnabled()) return COMPUTER_INPUT_OFF
    if (!this.deps.accessibility()) return ACCESSIBILITY_OFF
    return null
  }

  async perform(gesture: Gesture): Promise<void> {
    const refusal = this.inputRefusal()
    if (refusal) throw new Error(refusal)
    // A window card's input is checked against the window list AS IT IS NOW:
    // the card shows the window even when something covers it (captured by
    // id), but a click lands on whatever is on top and keys go to whatever
    // has focus. Read front to back, every time.
    const region = await this.resolve(this.target.kind === 'window')
    const at = (x: number | string, y: number | string): { x: number; y: number } => ({
      x: region.x + clamp(Number(x), 0, region.width - 1),
      y: region.y + clamp(Number(y), 0, region.height - 1)
    })
    const p = gesture.params
    let op: MacOp
    switch (gesture.method) {
      case 'input.tap':
        op = { op: 'click', ...at(p.x, p.y) }
        break
      case 'input.swipe': {
        const a = at(p.x1, p.y1)
        const b = at(p.x2, p.y2)
        op = { op: 'drag', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ms: Math.round(Number(p.seconds) * 1000) }
        break
      }
      case 'input.scroll':
        op = { op: 'scroll', ...at(p.x, p.y), dx: Number(p.dx), dy: Number(p.dy) }
        break
      case 'input.key': {
        const code = macKeyCode(String(p.name))
        if (code === null) throw new Error(`no '${String(p.name)}' key on this Mac`)
        op = { op: 'key', code }
        break
      }
      case 'input.type':
      case 'input.paste':
        op = { op: 'type', text: String(p.text) }
        break
    }
    if (region.window) this.confine(region.window, op)
    await this.deps.hand().send(op)
  }

  /** Refuses an op that would land outside the card's window, in a sentence that says what is in the way. */
  private confine(window: MacWindow, op: MacOp): void {
    const windows = this.screens?.windows ?? []
    const name = window.title ? `${window.app} — ${window.title}` : window.app
    if (op.op === 'key' || op.op === 'type') {
      const front = windows[0]
      if (front && front.id !== window.id) {
        throw new Error(`'${name}' is not the front window, so keys would go to '${front.app}' — tap the card first to bring it forward`)
      }
      return
    }
    const point = op.op === 'drag' ? { x: op.x1, y: op.y1 } : op.op === 'ping' ? null : { x: op.x, y: op.y }
    if (!point) return
    const top = windows.find((w) => point.x >= w.x && point.x < w.x + w.width && point.y >= w.y && point.y < w.y + w.height)
    if (top && top.id !== window.id) {
      throw new Error(`'${name}' is covered there by '${top.app}' — bring '${window.app}' to the front first`)
    }
  }

  title(): string {
    const w = this.region?.window
    if (w) return w.title ? `${w.app} — ${w.title}` : w.app
    return this.target.kind === 'screen' ? `Display ${this.target.name}` : this.target.name
  }

  async close(): Promise<void> {
    await this.deps.remove(this.file).catch(() => undefined)
  }
}

const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo)

/** The real screencapture, file I/O and tmp dir. */
export const screenCaptureRunner = (args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', [...args], { timeout: 8000 }, (error, _stdout, stderr) => {
      if (error) return reject(new Error(`screencapture: ${String(stderr).trim() || error.message}`))
      resolve()
    })
  })

export const screenFiles = {
  read: (file: string): Promise<Buffer> => readFile(file),
  remove: (file: string): Promise<void> => rm(file, { force: true })
}
