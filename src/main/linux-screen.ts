import type { UseTarget } from '../shared/use-url'
import { useUrl } from '../shared/use-url'
import { emptySourceList, readySourceList, type UseSource, type UseSourceList } from '../shared/use-sources'
import type { PixelDevice, PixelFrame } from './pixel-instance'
import { THUMB_SIZE, type GrabbedSource, type SourceGrab } from './use-source-mac'
import type { UseSourceProvider } from './use-source-service'
import type { ScreenPoints } from './vphone-input'

/**
 * THE WHOLE SCREEN ON LINUX, THROUGH ELECTRON'S CAPTURER.
 *
 * `screen://main` and `screen://<n>` work on X11, a frame at a time: each is
 * one desktopCapturer call, the same polling the Mac does with screencapture.
 * Windows, regions and input do not exist here, and each refusal is a
 * sentence: this device has no `perform`, so a viewer's input goes nowhere and
 * an agent is told why.
 *
 * Wayland is refused by name. XWayland sets DISPLAY too and then captures
 * black, so the session type is what is asked, not DISPLAY.
 */

export interface LinuxEnv {
  readonly DISPLAY?: string
  readonly WAYLAND_DISPLAY?: string
  readonly XDG_SESSION_TYPE?: string
}

export const LINUX_WAYLAND =
  'This Linux session runs Wayland, and Cookrew can only read the screen on X11 — log in to an X11 session to share it'
export const LINUX_NO_DISPLAY = 'There is no X display here (DISPLAY is not set), so there is no screen to show'
export const LINUX_NO_WINDOW = 'Picking one window works on macOS only for now — on Linux, share the entire screen'
export const LINUX_NO_REGION = 'A region of the screen works on macOS only for now — on Linux, share the entire screen'
export const LINUX_INPUT_OFF = 'Driving this machine is not available on Linux: the screen is view only'

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

export interface LinuxScreenDeps {
  env(): LinuxEnv
  /** One picture of every display. */
  frames(): Promise<readonly LinuxFrame[]>
  primaryDisplayId(): string | null
}

export class LinuxScreenDevice implements PixelDevice {
  constructor(
    readonly target: UseTarget,
    private readonly deps: LinuxScreenDeps
  ) {}

  private async frame(): Promise<LinuxFrame & { readonly jpeg: Buffer }> {
    if (this.target.kind === 'window') throw new Error(LINUX_NO_WINDOW)
    if (this.target.roi) throw new Error(LINUX_NO_REGION)
    const refusal = linuxScreenRefusal(this.deps.env())
    if (refusal) throw new Error(refusal)
    const frames = await this.deps.frames()
    const frame = pickDisplay(frames, this.target.name, this.deps.primaryDisplayId())
    if (!frame) throw new Error(`Display ${this.target.name} is not connected (this machine has ${frames.length})`)
    if (!frame.jpeg) throw new Error(`The screen capturer gave no picture of display ${this.target.name}`)
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

  inputRefusal(): string {
    return LINUX_INPUT_OFF
  }

  title(): string {
    return this.target.name === 'main' ? 'Main display' : `Display ${this.target.name}`
  }
}

export interface LinuxSourceDeps {
  env(): LinuxEnv
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
    openSettings: async () => undefined,
    async list(): Promise<UseSourceList> {
      const refusal = linuxScreenRefusal(deps.env())
      if (refusal) return emptySourceList('unavailable', refusal)
      try {
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
