import type { UseTarget } from '../shared/use-url'
import { useUrl } from '../shared/use-url'
import type { RemoteState } from '../shared/remote-access'
import { blockedSourceList, emptySourceList, readySourceList, type UseSource, type UseSourceList } from '../shared/use-sources'
import { NO_WHEEL, xdotoolCalls, type DisplayArea, type LinuxHand, type WheelCarry } from './linux-input'
import { DeviceBlockedError, type PixelDevice, type PixelFrame, type RemoteGate } from './pixel-instance'
import { THUMB_SIZE, type GrabbedSource, type SourceGrab } from './use-source-mac'
import type { UseSourceProvider } from './use-source-service'
import type { Gesture, ScreenPoints } from './vphone-input'

/**
 * THE WHOLE SCREEN ON LINUX, THROUGH ELECTRON'S CAPTURER.
 *
 * `screen://main` and `screen://<n>` work on X11, a frame at a time: each is
 * one desktopCapturer call, the same polling the Mac does with screencapture.
 * Windows and regions do not exist here, and each refusal is a sentence.
 *
 * Input goes the way a Mac's does: the desk decides (the machine switch, the
 * card's grant, a served workspace, Stop), then the hand (linux-input.ts) sends
 * it through xdotool. A point is a ratio of the last frame, laid on the display
 * that frame was of.
 *
 * Wayland is refused by name. XWayland sets DISPLAY too and then captures
 * black, so the session type is what is asked, not DISPLAY. The desk asks
 * (remote-desk.ts), along with the lock and the display, and the card says what
 * it answers: the same states as a Mac, with no System Settings in them.
 */

export interface LinuxEnv {
  readonly DISPLAY?: string
  readonly WAYLAND_DISPLAY?: string
  readonly XDG_SESSION_TYPE?: string
}

export const LINUX_WAYLAND =
  'This Linux session runs Wayland, and Cookrew can only read the screen on X11 — log in to an X11 session to share it'
export const LINUX_NO_DISPLAY = 'There is no X display here, so there is no screen to show'
export const LINUX_NO_WINDOW = 'Picking one window works on macOS only for now — on Linux, share the entire screen'
export const LINUX_NO_REGION = 'A region of the screen works on macOS only for now — on Linux, share the entire screen'

export function linuxScreenRefusal(env: LinuxEnv): string | null {
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return LINUX_WAYLAND
  return env.DISPLAY ? null : LINUX_NO_DISPLAY
}

/** The display an address names: the primary by id (else the first), or the nth; null when there is no such one. */
function pickDisplay<T extends { displayId: string }>(displays: readonly T[], name: string, primaryId: string | null): T | null {
  if (name === 'main') return displays.find((d) => d.displayId === primaryId) ?? displays[0] ?? null
  return displays[Number(name) - 1] ?? null
}

export interface LinuxFrame {
  readonly displayId: string
  /** Null when the capturer gave an empty picture of this display. */
  readonly jpeg: Buffer | null
  readonly width: number
  readonly height: number
}

/** Which display a frame was of: its id, and its place in the capturer's list (Xvfb gives no ids). */
export interface ShownDisplay {
  readonly displayId: string
  readonly index: number
}

export interface LinuxScreenDeps {
  remote: RemoteGate
  /** One picture of every display. */
  frames(): Promise<readonly LinuxFrame[]>
  primaryDisplayId(): string | null
  /** Where that display sits on the X screen, in pixels; null when it has gone. */
  area(shown: ShownDisplay): DisplayArea | null
  hand: LinuxHand
  readClipboard?: () => string
}

interface Shown extends ShownDisplay {
  readonly width: number
  readonly height: number
}

export class LinuxScreenDevice implements PixelDevice {
  readonly remote: RemoteGate
  readonly readClipboard?: () => string
  /** The display the last frame was of, at that frame's size: what a point is a ratio of. */
  private shown: Shown | null = null
  private wheel: WheelCarry = NO_WHEEL

  constructor(
    readonly target: UseTarget,
    private readonly deps: LinuxScreenDeps
  ) {
    this.remote = deps.remote
    this.readClipboard = deps.readClipboard
  }

  private async frame(): Promise<LinuxFrame & { readonly jpeg: Buffer }> {
    if (this.target.kind === 'window') throw new Error(LINUX_NO_WINDOW)
    if (this.target.roi) throw new Error(LINUX_NO_REGION)
    const blocked = await this.remote.blocked()
    if (blocked) throw new DeviceBlockedError(blocked)
    const frames = await this.deps.frames()
    const frame = pickDisplay(frames, this.target.name, this.deps.primaryDisplayId())
    if (!frame) throw new Error(`Display ${this.target.name} is not connected (this machine has ${frames.length})`)
    if (!frame.jpeg) throw new Error(`The screen capturer gave no picture of display ${this.target.name}`)
    this.shown = { displayId: frame.displayId, index: frames.indexOf(frame), width: frame.width, height: frame.height }
    return { ...frame, jpeg: frame.jpeg }
  }

  async open(): Promise<ScreenPoints> {
    const { width, height } = await this.frame()
    return { width, height }
  }

  async capture(): Promise<PixelFrame> {
    const { jpeg, width, height } = await this.frame()
    return { jpeg: jpeg.toString('base64'), points: { width, height } }
  }

  inputRefusal(): string | null {
    return this.deps.remote.inputRefusal() ?? this.deps.hand.refusal()
  }

  async perform(gesture: Gesture): Promise<void> {
    const refusal = this.inputRefusal()
    if (refusal) throw new Error(refusal)
    const blocked = await this.remote.blocked()
    if (blocked) throw new DeviceBlockedError(blocked)
    // A point is a ratio of a picture: with none yet, take one, so it is of what is there.
    if (!this.shown) await this.frame()
    const shown = this.shown as Shown | null
    if (!shown) throw new Error(`The screen capturer gave no picture of display ${this.target.name}`)
    const area = this.deps.area(shown)
    if (!area) throw new Error(`Display ${this.target.name} is not connected`)
    const { calls, wheel } = xdotoolCalls(gesture, shown, area, this.wheel)
    this.wheel = wheel
    await this.deps.hand.send(calls)
  }

  /** The session ended: the next frame says again what the display is. */
  rest(): void {
    this.shown = null
    this.wheel = NO_WHEEL
  }

  title(): string {
    return this.target.name === 'main' ? 'Main display' : `Display ${this.target.name}`
  }
}

export interface LinuxSourceDeps {
  /** What stands in the way, from the desk (remote-desk.ts). */
  blocked(): Promise<RemoteState | null>
  grab: SourceGrab
  primaryDisplayId(): string | null
}

const screenRow = (grabbed: GrabbedSource, name: string): UseSource => ({
  id: `screen:${name}`,
  kind: 'screen',
  title: name === 'main' ? 'Main display' : `Display ${name}`,
  app: null,
  address: useUrl({ kind: 'screen', name, detail: null, roi: null }),
  thumb: grabbed.thumb,
  icon: null,
  width: 0,
  height: 0
})

export function linuxSources(deps: LinuxSourceDeps): UseSourceProvider {
  return {
    // There is no grant to turn on here.
    openSettings: async (_pane) => undefined,
    async list(): Promise<UseSourceList> {
      try {
        const blocked = await deps.blocked()
        if (blocked) return blockedSourceList(blocked)
        const displays = (await deps.grab(['screen'], THUMB_SIZE)).filter((g) => g.id.startsWith('screen:'))
        const main = pickDisplay(displays, 'main', deps.primaryDisplayId())
        return readySourceList({
          windows: [],
          windowsNote: LINUX_NO_WINDOW,
          screens: [...(main ? [screenRow(main, 'main')] : []), ...displays.flatMap((d, i) => (d === main ? [] : [screenRow(d, String(i + 1))]))]
        })
      } catch (error) {
        return emptySourceList('unavailable', error instanceof Error ? error.message : String(error))
      }
    }
  }
}
