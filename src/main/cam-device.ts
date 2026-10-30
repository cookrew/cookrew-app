import type { UseTarget } from '../shared/use-url'
import type { PixelDevice, PixelFrame } from './pixel-instance'
import type { ScreenPoints } from './vphone-input'

/**
 * A CAMERA ON THE BENCH, AS A PIXEL DEVICE (hardware use).
 *
 * Hardware has no screen of its own that Cookrew can read; what the owner
 * needs to see while an agent flashes a board, drives a robot arm or pokes a
 * serial console is the thing itself — a camera pointed at it (or an HDMI
 * capture dongle, which macOS also lists as a camera). So a hardware card is
 * a camera, watched, never driven: input to the hardware is the agent's own
 * tools, and the pet says which (shared/use-signal.ts · useOfToolCall).
 *
 * The camera is held by the capture host (capture-host.ts — one hidden
 * window, one MediaStreamTrackProcessor per camera); this asks it for the
 * newest frame on the instance's cadence.
 */

export interface CameraHost {
  /** Opens a camera by index (`0`) or a fragment of its name; answers its size. */
  open(name: string): Promise<{ key: string; width: number; height: number; label: string }>
  grab(key: string, maxSide: number): Promise<{ jpeg: string; width: number; height: number }>
  close(key: string): Promise<void>
}

export interface CamDeps {
  host(): CameraHost
  /**
   * macOS's camera grant for Cookrew. `asking` means the macOS dialog is up:
   * the ask runs in the background and the card says to answer it, rather
   * than an open that waits on a dialog nobody may be looking at.
   */
  cameraAccess(): Promise<'granted' | 'denied' | 'asking'>
}

export const CAM_FRAME_MAX_SIDE = 1280

export const CAMERA_ASKING = 'Allow Cookrew to use the camera in the macOS dialog — the card goes live as soon as you do'

export const CAMERA_OFF =
  'Camera access is off for Cookrew — turn it on in System Settings › Privacy & Security › Camera, then restart Cookrew'

export class CamDevice implements PixelDevice {
  private key: string | null = null
  private label = ''

  constructor(
    readonly target: UseTarget,
    private readonly deps: CamDeps
  ) {}

  async open(): Promise<ScreenPoints> {
    const access = await this.deps.cameraAccess()
    if (access === 'asking') throw new Error(CAMERA_ASKING)
    if (access !== 'granted') throw new Error(CAMERA_OFF)
    if (this.key) await this.deps.host().close(this.key).catch(() => undefined)
    const opened = await this.deps.host().open(this.target.name)
    this.key = opened.key
    this.label = opened.label
    return { width: opened.width, height: opened.height }
  }

  async capture(): Promise<PixelFrame> {
    if (!this.key) throw new Error('the camera is not open yet')
    const frame = await this.deps.host().grab(this.key, CAM_FRAME_MAX_SIDE)
    return { jpeg: frame.jpeg, points: { width: frame.width, height: frame.height } }
  }

  title(): string {
    return this.label || `Camera ${this.target.name}`
  }

  async close(): Promise<void> {
    if (this.key) await this.deps.host().close(this.key)
    this.key = null
  }
}
