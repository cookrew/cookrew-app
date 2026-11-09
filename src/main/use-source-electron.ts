import { clipboard, desktopCapturer, screen, shell, systemPreferences, type NativeImage } from 'electron'
import type { DisplayArea } from './linux-input'
import type { LinuxFrame, ShownDisplay } from './linux-screen'
import { withDeadline } from './pixel-instance'
import { type GrabbedSource, type SourceGrab } from './use-source-mac'

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
