import { execFile } from 'node:child_process'
import type { UseTarget } from '../shared/use-url'
import type { PixelDevice, PixelFrame } from './pixel-instance'
import type { Gesture, ScreenPoints } from './vphone-input'

/**
 * AN ANDROID DEVICE OVER ADB, AS A PIXEL DEVICE (phone use).
 *
 * Frames are `adb exec-out screencap -p` (a PNG, re-encoded to JPEG by the
 * caller's encoder — Electron's nativeImage in the app, a stub in tests).
 * Gestures arrive in density-independent POINTS, the same unit a phone
 * viewer's finger is measured in, and are scaled to pixels only here: a tap
 * slop of ten points is a tap on every screen density, where ten pixels would
 * turn a thumb's wobble into a swipe on a 1440p phone.
 *
 * The device's screen is read from each frame's own PNG header, so a rotated
 * phone is a landscape card on the next frame, with no extra round trip.
 */

export interface AdbDeps {
  /** Run `adb <args>`; resolves stdout. Rejects with stderr in the message. */
  run(args: readonly string[], timeoutMs: number): Promise<Buffer>
  /** PNG in, JPEG out, at most this many pixels on the long side. */
  toJpeg(png: Buffer, maxSide: number): Buffer
}

export const ADB_FRAME_MAX_SIDE = 1600
const CAPTURE_TIMEOUT_MS = 10_000
const INPUT_TIMEOUT_MS = 5_000

const KEYCODES: Record<string, number> = {
  return: 66,
  delete: 67,
  tab: 61,
  // Escape is Back: the one key every Android screen answers to.
  escape: 4,
  space: 62,
  up: 19,
  down: 20,
  left: 21,
  right: 22
}

export const adbKeyCode = (name: string): number | null => KEYCODES[name] ?? null

/** Quote one argument for the device's shell (adb joins `shell` args into one command line). */
export const deviceQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** `input text` reads `%s` as a space and refuses a literal one. */
export const inputText = (text: string): string => text.replace(/%/g, '%%').replace(/ /g, '%s')

export function pngSize(png: Buffer): ScreenPoints | null {
  // 8-byte signature, then IHDR: length(4) type(4) width(4) height(4).
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** `wm size` answers a physical size and, when someone set one, an override — the override is what is drawn. */
export function parseWmSize(text: string): ScreenPoints | null {
  const sizes = [...text.matchAll(/(Physical|Override) size:\s*(\d+)x(\d+)/g)]
  const chosen = sizes.find((m) => m[1] === 'Override') ?? sizes[0]
  return chosen ? { width: Number(chosen[2]), height: Number(chosen[3]) } : null
}

export function parseDensity(text: string): number | null {
  const all = [...text.matchAll(/(Physical|Override) density:\s*(\d+)/g)]
  const chosen = all.find((m) => m[1] === 'Override') ?? all[0]
  const dpi = chosen ? Number(chosen[2]) : NaN
  return Number.isFinite(dpi) && dpi > 0 ? dpi / 160 : null
}

/** The serial for `adb://default`: the one attached device, or a sentence saying why there is not exactly one. */
export function pickDevice(devicesOutput: string): string {
  const rows = devicesOutput
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0].length > 0)
  const ready = rows.filter((parts) => parts[1] === 'device').map((parts) => parts[0])
  if (ready.length === 1) return ready[0]
  if (ready.length > 1) throw new Error(`${ready.length} Android devices are attached (${ready.join(', ')}); name one: adb://<serial>`)
  const unauthorized = rows.find((parts) => parts[1] === 'unauthorized')
  if (unauthorized) throw new Error(`Android device ${unauthorized[0]} has not allowed this Mac — accept the USB debugging prompt on the phone`)
  throw new Error('No Android device is attached — plug one in with USB debugging on, or start an emulator')
}

export class AdbDevice implements PixelDevice {
  private serial: string | null = null
  private scale = 1

  constructor(
    readonly target: UseTarget,
    private readonly deps: AdbDeps
  ) {}

  private adb(args: readonly string[], timeoutMs: number): Promise<Buffer> {
    if (this.serial === null) return Promise.reject(new Error('the Android device is not connected yet'))
    return this.deps.run(['-s', this.serial, ...args], timeoutMs)
  }

  async open(): Promise<ScreenPoints> {
    this.serial =
      this.target.name === 'default'
        ? pickDevice((await this.deps.run(['devices'], INPUT_TIMEOUT_MS)).toString('utf8'))
        : this.target.name
    const size = parseWmSize((await this.adb(['shell', 'wm', 'size'], INPUT_TIMEOUT_MS)).toString('utf8'))
    if (!size) throw new Error(`adb device ${this.serial} did not say its screen size`)
    let density: number | null = null
    try {
      density = parseDensity((await this.adb(['shell', 'wm', 'density'], INPUT_TIMEOUT_MS)).toString('utf8'))
    } catch {
      // Density is a nicety: pixels as points still works, with a smaller slop.
    }
    this.scale = density ?? 1
    return this.pointsOf(size)
  }

  private pointsOf(pixels: ScreenPoints): ScreenPoints {
    return { width: Math.round(pixels.width / this.scale), height: Math.round(pixels.height / this.scale) }
  }

  async capture(): Promise<PixelFrame> {
    const png = await this.adb(['exec-out', 'screencap', '-p'], CAPTURE_TIMEOUT_MS)
    const size = pngSize(png)
    if (!size) throw new Error('the Android screenshot was not an image — is the screen locked by a secure app?')
    return { jpeg: this.deps.toJpeg(png, ADB_FRAME_MAX_SIDE).toString('base64'), points: this.pointsOf(size) }
  }

  private px(n: number | string): string {
    return String(Math.round(Number(n) * this.scale))
  }

  async perform(gesture: Gesture): Promise<void> {
    const p = gesture.params
    switch (gesture.method) {
      case 'input.tap':
        await this.adb(['shell', 'input', 'tap', this.px(p.x), this.px(p.y)], INPUT_TIMEOUT_MS)
        return
      case 'input.swipe': {
        const ms = String(Math.round(Number(p.seconds) * 1000))
        await this.adb(['shell', 'input', 'swipe', this.px(p.x1), this.px(p.y1), this.px(p.x2), this.px(p.y2), ms], INPUT_TIMEOUT_MS)
        return
      }
      case 'input.scroll': {
        const toY = Number(p.y) - Number(p.dy)
        await this.adb(['shell', 'input', 'swipe', this.px(p.x), this.px(p.y), this.px(p.x), this.px(toY), '200'], INPUT_TIMEOUT_MS)
        return
      }
      case 'input.key': {
        const code = adbKeyCode(String(p.name))
        if (code === null) throw new Error(`Android has no '${String(p.name)}' key`)
        await this.adb(['shell', 'input', 'keyevent', String(code)], INPUT_TIMEOUT_MS)
        return
      }
      case 'input.type':
        await this.adb(['shell', 'input', 'text', deviceQuote(inputText(String(p.text)))], INPUT_TIMEOUT_MS)
        return
      case 'input.paste':
        throw new Error("Android's input command types ASCII only; this text has other characters")
    }
  }

  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses open on an Android device')
    await this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deviceQuote(url)], INPUT_TIMEOUT_MS)
  }

  title(): string {
    return this.serial ? `Android ${this.serial}` : 'Android'
  }
}

/** The real adb, found on PATH or at Homebrew's place for a GUI launch whose PATH is short. */
export function adbRunner(binary: string): AdbDeps['run'] {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error) {
          const said = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : ''
          reject(new Error(said.length > 0 ? `adb: ${said.split('\n')[0]}` : `adb failed: ${error.message}`))
          return
        }
        resolve(stdout)
      })
    })
}
