import { clipboard, desktopCapturer, screen, shell, systemPreferences, type NativeImage } from 'electron'
import type { DisplayArea } from './linux-input'
import type { LinuxFrame, ShownDisplay } from './linux-screen'
import { withDeadline } from './pixel-instance'
import { GRAB_DEADLINE_MS, THUMB_SIZE, type GrabbedSource, type SourceGrab } from './use-source-mac'

/**
 * ELECTRON'S SCREEN CAPTURER, FOR THE PLAIN-CODE SOURCES.
 *
 * desktopCapturer answers the picker's pictures on both platforms and the
 * frames of a Linux screen card. On a Mac its window ids are CGWindowIDs, the
 * ids mac-bridge.ts lists. Nothing here decides what may be read: the grant
 * and the served gate come first (use-source-mac.ts, use-source-service.ts).
 */

const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
/** How long the system's own question may hold the settings page back. */
export const ASK_DEADLINE_MS = 5_000
const ICON_PX = 32
const JPEG_QUALITY = 60

const jpegUrl = (image: NativeImage): string | null =>
  image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(JPEG_QUALITY).toString('base64')}`

const iconUrl = (image: NativeImage | null): string | null =>
  !image || image.isEmpty() ? null : `data:image/png;base64,${image.resize({ width: ICON_PX, height: ICON_PX }).toPNG().toString('base64')}`

export const grabSources: SourceGrab = async (kinds, size) => {
  const sources = await desktopCapturer.getSources({ types: [...kinds], thumbnailSize: size, fetchWindowIcons: kinds.includes('window') })
  return sources.map((source): GrabbedSource => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumb: jpegUrl(source.thumbnail),
    icon: iconUrl(source.appIcon)
  }))
}

/** One picture of every display, fitted to the long side. */
export async function grabScreenFrames(maxSide: number): Promise<readonly LinuxFrame[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxSide, height: maxSide } })
  // An empty picture keeps its place: a display's number is its place in this list.
  return sources.map((source): LinuxFrame => {
    if (source.thumbnail.isEmpty()) return { displayId: source.display_id, jpeg: null, width: 0, height: 0 }
    const { width, height } = source.thumbnail.getSize()
    return { displayId: source.display_id, jpeg: source.thumbnail.toJPEG(70), width, height }
  })
}

export const primaryDisplayId = (): string | null => String(screen.getPrimaryDisplay().id)

/**
 * Where a captured display sits on the X screen, in pixels (what xdotool moves in).
 * By id; else, as Xvfb gives the capturer no ids, the only display there is. With
 * several and no id nothing says which one the picture was of, and a guess would
 * click on the wrong screen: null, which the card says. Electron's bounds are in its
 * own points, so they are scaled back by the display's factor.
 */
export function displayArea(shown: ShownDisplay): DisplayArea | null {
  const displays = screen.getAllDisplays()
  const display = displays.find((d) => String(d.id) === shown.displayId) ?? (displays.length === 1 ? displays[0] : null)
  if (!display) return null
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const { x, y, width, height } = display.bounds
  return { x: Math.round(x * scale), y: Math.round(y * scale), width: Math.round(width * scale), height: Math.round(height * scale) }
}

export const readMachineClipboard = (): string => clipboard.readText()

export interface RectPicture {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  /** The part of the X screen it is of: the rect, cut to the display it is on. */
  readonly rect: DisplayArea
}

const physicalArea = (display: Electron.Display): DisplayArea => {
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const { x, y, width, height } = display.bounds
  return { x: Math.round(x * scale), y: Math.round(y * scale), width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * Pictures of parts of the X screen (one window each), from ONE capture of the
 * displays at their full size. Chromium lists X11 windows only when a window
 * manager has marked them, so a bare Xvfb has none to capture by id; a crop of
 * the screen works with or without one (linux-window-device.ts). A rect is cut
 * to the display its middle is on; none where that display, or its picture,
 * cannot be told apart from another (several displays, no ids).
 */
export async function captureRects(rects: readonly DisplayArea[], maxSide: number): Promise<Array<RectPicture | null>> {
  if (rects.length === 0) return []
  const displays = screen.getAllDisplays().map((d) => ({ id: String(d.id), area: physicalArea(d) }))
  const size = { width: Math.max(...displays.map((d) => d.area.width), 1), height: Math.max(...displays.map((d) => d.area.height), 1) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  return rects.map((rect) => {
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const display = displays.find(({ area }) => cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height)
    if (!display) return null
    const source = sources.find((s) => s.display_id === display.id) ?? (sources.length === 1 && displays.length === 1 ? sources[0] : null)
    if (!source || source.thumbnail.isEmpty()) return null
    const { area } = display
    const left = Math.max(rect.x, area.x)
    const top = Math.max(rect.y, area.y)
    const cut = { x: left, y: top, width: Math.min(rect.x + rect.width, area.x + area.width) - left, height: Math.min(rect.y + rect.height, area.y + area.height) - top }
    if (cut.width < 2 || cut.height < 2) return null
    const picture = source.thumbnail.getSize()
    const sx = picture.width / area.width
    const sy = picture.height / area.height
    let image = source.thumbnail.crop({ x: Math.round((cut.x - area.x) * sx), y: Math.round((cut.y - area.y) * sy), width: Math.max(1, Math.round(cut.width * sx)), height: Math.max(1, Math.round(cut.height * sy)) })
    const got = image.getSize()
    const fit = Math.min(1, maxSide / Math.max(got.width, got.height))
    if (fit < 1) image = image.resize({ width: Math.max(1, Math.round(got.width * fit)), height: Math.max(1, Math.round(got.height * fit)) })
    const out = image.getSize()
    return { jpeg: image.toJPEG(70), width: out.width, height: out.height, rect: cut }
  })
}

/** The picker's window pictures, as data: URLs. */
export async function windowThumbs(rects: readonly DisplayArea[]): Promise<Array<string | null>> {
  const pictures = await withDeadline(captureRects(rects, Math.max(THUMB_SIZE.width, THUMB_SIZE.height)), GRAB_DEADLINE_MS, 'the screen capturer')
  return pictures.map((p) => (p ? `data:image/jpeg;base64,${p.jpeg.toString('base64')}` : null))
}

/**
 * The Accessibility page. Like Screen Recording it lists an app only once the
 * app has asked, and asking with a prompt is what makes the row. It grants
 * nothing: the switch in that row is the owner's to turn.
 */
export async function openAccessibilitySettings(): Promise<void> {
  systemPreferences.isTrustedAccessibilityClient(true)
  await shell.openExternal(ACCESSIBILITY_PANE)
}

/**
 * The Screen Recording page. macOS lists an app there only once it has asked,
 * so anything short of a grant asks first: one tiny capture raises the system's
 * own question, and from then on the page has a row to switch on. The status
 * cannot tell who was asked: Electron answers `denied` for an app macOS has
 * never heard of, and never `not-determined`. Asked once, this raises nothing.
 */
export async function openScreenRecordingSettings(access: string): Promise<void> {
  if (access !== 'granted') {
    await withDeadline(desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }), ASK_DEADLINE_MS, 'the system').catch(() => undefined)
  }
  await shell.openExternal(SCREEN_RECORDING_PANE)
}
