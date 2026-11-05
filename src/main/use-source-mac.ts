import { useUrl, windowAppName } from '../shared/use-url'
import type { RemoteState } from '../shared/remote-access'
import { blockedSourceList, emptySourceList, readySourceList, type UseSource, type UseSourceList } from '../shared/use-sources'
import type { MacDisplay, MacScreens, MacWindow } from './mac-bridge'
import { withDeadline } from './pixel-instance'
import type { SettingsPane } from './remote-desk'
import type { UseSourceProvider } from './use-source-service'

/**
 * THE MAC'S WINDOWS AND DISPLAYS, AS THE PICKER SHOWS THEM.
 *
 * Two sources, joined on the window id. The rows come from the same list a
 * card binds to (mac-bridge.ts), so a row in the sheet is a window a card can
 * show. The pictures and icons come from the capturer, which is allowed to
 * fail: a row with no picture is still a window, and the sheet draws it from
 * its name.
 *
 * While the screen cannot be read neither is touched: without Screen Recording
 * the list comes back with every title blank and the capturer with empty
 * pictures, which is a sheet that looks broken. It answers the desk's state
 * instead, the same one the card shows.
 *
 * Cookrew's own windows are left out: a card showing Cookrew inside Cookrew
 * is a mirror facing a mirror.
 */

export interface GrabbedSource {
  /** The capturer's own id: `window:<CGWindowID>:0`, `screen:<n>:0`. */
  readonly id: string
  readonly name: string
  readonly displayId: string
  readonly thumb: string | null
  readonly icon: string | null
}

export type SourceGrab = (kinds: ReadonlyArray<'window' | 'screen'>, size: { width: number; height: number }) => Promise<readonly GrabbedSource[]>

export interface MacSourceDeps {
  /** What stands in the way, from the desk (remote-desk.ts). */
  blocked(): Promise<RemoteState | null>
  screens(): Promise<MacScreens>
  grab: SourceGrab
  selfPid: number
  openSettings(pane: SettingsPane): Promise<void>
}

/** Enough for a phone to pick from, and bounded: each row carries a picture. */
export const MAX_WINDOWS = 24
export const THUMB_SIZE = { width: 400, height: 250 }
/** The capturer has no deadline of its own, and the rows should not wait on it for ever. */
export const GRAB_DEADLINE_MS = 8_000

const windowIdOf = (grabbed: GrabbedSource): number | null => {
  const match = /^window:(\d+):/.exec(grabbed.id)
  return match ? Number(match[1]) : null
}

const windowRow = (window: MacWindow, picture: GrabbedSource | undefined): UseSource => ({
  id: `window:${window.id}`,
  kind: 'window',
  title: window.title || window.app || 'Window',
  app: window.app || null,
  address: useUrl({ kind: 'window', name: windowAppName(window.app), detail: null, roi: null, windowId: window.id }),
  thumb: picture?.thumb ?? null,
  icon: picture?.icon ?? null,
  width: window.width,
  height: window.height
})

const screenRow = (display: MacDisplay, picture: GrabbedSource | undefined): UseSource => {
  const main = display.index === 1
  return {
    id: `screen:${main ? 'main' : display.index}`,
    kind: 'screen',
    title: main ? 'Main display' : `Display ${display.index}`,
    app: null,
    address: useUrl({ kind: 'screen', name: main ? 'main' : String(display.index), detail: null, roi: null }),
    thumb: picture?.thumb ?? null,
    icon: null,
    width: display.width,
    height: display.height
  }
}

async function pictures(grab: SourceGrab): Promise<readonly GrabbedSource[]> {
  try {
    return await withDeadline(grab(['window', 'screen'], THUMB_SIZE), GRAB_DEADLINE_MS, 'the screen capturer')
  } catch {
    // The rows stand without their pictures.
    return []
  }
}

export function macSources(deps: MacSourceDeps): UseSourceProvider {
  return {
    openSettings: (pane) => deps.openSettings(pane),
    async list(): Promise<UseSourceList> {
      try {
        const blocked = await deps.blocked()
        if (blocked) return blockedSourceList(blocked)
        const [screens, grabbed] = await Promise.all([deps.screens(), pictures(deps.grab)])
        const byWindow = new Map(grabbed.flatMap((g) => {
          const id = windowIdOf(g)
          return id === null ? [] : [[id, g] as const]
        }))
        const byDisplay = new Map(grabbed.filter((g) => g.id.startsWith('screen:')).map((g) => [g.displayId, g] as const))
        return readySourceList({
          windows: screens.windows
            .filter((w) => w.pid !== deps.selfPid)
            .slice(0, MAX_WINDOWS)
            .map((w) => windowRow(w, byWindow.get(w.id))),
          screens: [...screens.displays].sort((a, b) => a.index - b.index).map((d) => screenRow(d, byDisplay.get(String(d.id))))
        })
      } catch (error) {
        return emptySourceList('unavailable', error instanceof Error ? error.message : String(error))
      }
    }
  }
}
