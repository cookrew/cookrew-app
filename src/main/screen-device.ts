import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Roi, UseTarget } from '../shared/use-url'
import { windowAppName } from '../shared/use-url'
import type { WindowMemo, WindowMemory } from './use-window-memory'
import { macKeyCode, type MacInput, type MacOp, type MacScreens, type MacWindow } from './mac-bridge'
import { DeviceBlockedError, DeviceGoneError, type PixelDevice, type PixelFrame, type RemoteGate } from './pixel-instance'
import type { Gesture, ScreenPoints } from './vphone-input'
import { machineCopy } from '../shared/machine-words'

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
 * id must still be on screen and still be the app's. Missing from the on-screen
 * list it is asked after directly: alive but off screen is an ordinary offline
 * that recovers by itself, and only a window macOS no longer knows is gone
 * (DeviceGoneError).
 *
 * An app that quit and came back has new window ids, so the card finds its window
 * again by what it remembers (use-window-memory.ts): same app, same title, exactly
 * one such window, and a NEW process. The same process means the app never went, so
 * a window of that title is a sibling. Anything looser would show the owner's other
 * windows on a card meant for one; failing that it stays gone.
 *
 * Nothing is pressed into a window other than the one last captured, for a card by
 * name as much as a bound one: it may be showing something else now.
 *
 * THE DESK DECIDES (remote-desk.ts). Before every frame and every gesture
 * this asks what stands in the way: the lock, Screen Recording, the display.
 * A blocked screen gives no frame and takes no input. Input is off unless the
 * machine switch is on, because a viewer that may drive this Mac is a decision,
 * never a default; a viewer also has to hold the card's own grant.
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
  remote: RemoteGate
  hand(): MacInput
  readClipboard?: () => string
  now?: () => number
  tmp?: string
  /** What this card knows of its window, across restarts. */
  memory?: WindowMemory
  /** The card now shows a window it found again: control was given over the old one. */
  rebound?: () => void
}

export const SCREEN_FRAME_MAX_SIDE = 1920
const RELIST_MS = 1000

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
  private boundId: number | undefined
  private bound: WindowMemo | null = null
  /** The window the last frame was of. */
  private capturedId: number | null = null
  private readonly file: string
  private readonly now: () => number

  readonly remote: RemoteGate
  readonly readClipboard?: () => string

  constructor(
    readonly target: UseTarget,
    private readonly deps: ScreenDeps
  ) {
    this.remote = deps.remote
    this.readClipboard = deps.readClipboard
    this.now = deps.now ?? Date.now
    this.boundId = target.windowId
    const held = target.windowId ? (deps.memory?.read() ?? null) : null
    if (held && held.from === target.windowId) {
      this.bound = held
      this.boundId = held.id
    }
    this.file = path.join(deps.tmp ?? tmpdir(), `cookrew-roi-${randomUUID()}.jpg`)
  }

  private async resolve(force = false): Promise<Region> {
    if (!force && this.region && this.now() - this.listedAt < RELIST_MS) return this.region
    const screens = await this.deps.list()
    this.screens = screens
    this.listedAt = this.now()
    let area: { x: number; y: number; width: number; height: number }
    let window: MacWindow | null = null
    if (this.target.kind === 'window') {
      window = this.boundId ? await this.boundWindow(screens, this.boundId) : this.namedWindow(screens)
      area = window
    } else {
      const index = this.target.name === 'main' ? 1 : Number(this.target.name)
      const display = screens.displays.find((d) => d.index === index)
      if (!display) throw new Error(`Display ${this.target.name} is not connected (${machineCopy('this Mac', process.platform)} has ${screens.displays.length})`)
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
    const window = screens.windows.find((w) => w.id === id)
    if (window && sameApp(window.app, this.target.name) && !this.isAnother(window)) {
      this.remember(window, screens)
      return window
    }
    if (!window) {
      const alive = await this.deps.windowAlive(id)
      if (alive && sameApp(alive.app, this.target.name)) {
        throw new Error(`The '${this.target.name}' window is minimised or on another Space — bring it back to see it here`)
      }
    }
    const back = this.cameBack(screens)
    if (back) return back
    const after = this.bound ? ' — open it again, then take a screenshot; if the card still cannot find it, pick the window again' : ''
    throw new DeviceGoneError('window', `The '${this.target.name}' window this card showed has closed${after}`)
  }

  /** The id came round again: same number, another process, so not this window. */
  private isAnother(window: MacWindow): boolean {
    const held = this.bound
    return held !== null && held.id === window.id && held.pid !== null && window.pid !== undefined && held.pid !== window.pid
  }

  private sharing(screens: MacScreens, title: string): readonly MacWindow[] {
    return screens.windows.filter((w) => sameApp(w.app, this.target.name) && w.title === title)
  }

  /** A title macOS is hiding (no Screen Recording) teaches nothing. */
  private remember(window: MacWindow, screens: MacScreens): void {
    const from = this.target.windowId
    if (from === undefined || !window.title) return
    const alone = this.sharing(screens, window.title).length === 1
    const next: WindowMemo = { from, id: window.id, title: window.title, pid: window.pid ?? null, alone }
    const held = this.bound
    if (held && held.id === next.id && held.title === next.title && held.pid === next.pid && held.alone === alone) return
    this.bound = next
    this.deps.memory?.write(next)
  }

  private cameBack(screens: MacScreens): MacWindow | null {
    const held = this.bound
    // A title it shared before: there is no telling which of the two came back.
    if (!held || held.pid === null || !held.alone) return null
    const same = this.sharing(screens, held.title)
    const [window] = same
    if (same.length !== 1 || window.pid === undefined || window.pid === held.pid) return null
    this.boundId = window.id
    this.remember(window, screens)
    this.deps.rebound?.()
    return window
  }

  /** Throws what stands in the way, in the words the card shows. */
  private async mustBeReadable(afterFailure = false): Promise<void> {
    const blocked = await this.deps.remote.blocked(afterFailure ? { afterFailure } : undefined)
    if (blocked) throw new DeviceBlockedError(blocked)
  }

  async open(): Promise<ScreenPoints> {
    await this.mustBeReadable()
    const region = await this.resolve(true)
    return { width: region.width, height: region.height }
  }

  async capture(): Promise<PixelFrame> {
    await this.mustBeReadable()
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
      this.capturedId = region.window?.id ?? null
      return { jpeg: jpeg.toString('base64'), points: { width: region.width, height: region.height }, ...(region.window ? { subject: region.window.id } : {}) }
    } catch (error) {
      // The window may be gone: look it up afresh next time.
      this.listedAt = Number.NEGATIVE_INFINITY
      await this.mustBeReadable(true)
      // A bound window: say what happened to it, not what screencapture said.
      if (this.boundId) await this.resolve(true)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      await this.deps.remove(this.file).catch(() => undefined)
    }
  }

  inputRefusal(): string | null {
    return this.deps.remote.inputRefusal()
  }

  async perform(gesture: Gesture, subject?: number): Promise<void> {
    const refusal = this.inputRefusal()
    if (refusal) throw new Error(refusal)
    await this.mustBeReadable()
    // A window card's input is checked against the window list AS IT IS NOW:
    // the card shows the window even when something covers it (captured by
    // id), but a click lands on whatever is on top and keys go to whatever
    // has focus. Read front to back, every time.
    const region = await this.resolve(this.target.kind === 'window')
    const aimedAt = subject ?? this.capturedId
    if (region.window && aimedAt !== null && region.window.id !== aimedAt) {
      throw new Error(`The '${this.target.name}' window has changed: take a screenshot first, it may be showing something else`)
    }
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
        if (code === null) throw new Error(`no '${String(p.name)}' key on ${machineCopy('this Mac', process.platform)}`)
        op = p.mods === 'cmd' ? { op: 'key', code, cmd: true } : { op: 'key', code }
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
    const point = op.op === 'drag' ? { x: op.x1, y: op.y1 } : op.op === 'ping' || op.op === 'unlock' ? null : { x: op.x, y: op.y }
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

  /** For `status`: what stands in the way, with no frame taken. */
  async probe(): Promise<void> {
    await this.mustBeReadable()
    await this.resolve(true)
  }

  /** Which window this is stays; where it was does not. */
  rest(): void {
    this.region = null
    this.screens = null
    this.listedAt = Number.NEGATIVE_INFINITY
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
