import { useSyncExternalStore } from 'react'

/**
 * FULL SCREEN ON THE PHONE. Chrome on Android hides its address bar, the
 * status bar and the navigation bar only through the Fullscreen API, and only
 * from a tap: the ⋯ row (HeaderMore.tsx) asks from its own click, which is the
 * user gesture the browser wants.
 *
 * The browser owns the state, not us. The system back gesture leaves full
 * screen without asking, a reload drops it, and a refusal (no gesture, a
 * policy) is just "not full screen": the row reads fullscreenElement through
 * fullscreenchange and never keeps a copy that could disagree.
 *
 * The camera cutout: Chrome lets a full screen page draw into it only under
 * viewport-fit=cover, and the phone bar's safe-area padding (styles.css) then
 * keeps the route clear of it. The flag is added to the live viewport tag at
 * the moment of asking, not in index.html: the companion's boot script
 * (mobile-server.ts) rewrites that tag, and a page that never goes full screen
 * keeps exactly the viewport it had.
 *
 * iPhone (WebKit, Chrome there included) gives a page no fullscreenEnabled,
 * so the row is simply not offered. Nothing here may throw into the app.
 *
 * Installed on the home screen, the manifest's display: fullscreen does the
 * hiding and nothing ever asks: the row is not offered, and the cutout flag is
 * set at boot instead. A tab in the Fullscreen API matches the same media
 * query, so "installed" also means no element is full screen.
 */

/** The slice of Document this needs, so a test can hand in a fake one. */
export interface FullscreenDoc {
  readonly fullscreenEnabled?: boolean
  querySelector(selector: 'meta[name="viewport"]'): Pick<Element, 'getAttribute' | 'setAttribute'> | null
  readonly fullscreenElement: Element | null
  readonly documentElement: { requestFullscreen?: (options?: FullscreenOptions) => Promise<void> }
  exitFullscreen?: () => Promise<void>
  addEventListener(type: 'fullscreenchange', cb: () => void): void
  removeEventListener(type: 'fullscreenchange', cb: () => void): void
}

export const canFullscreen = (doc: FullscreenDoc): boolean =>
  doc.fullscreenEnabled === true && typeof doc.documentElement.requestFullscreen === 'function'

export const isFullscreen = (doc: FullscreenDoc): boolean => doc.fullscreenElement != null

/** A viewport content with viewport-fit=cover, whatever fit it had; the rest untouched. */
export function withCover(content: string): string {
  const kept = content
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^viewport-fit\s*=/i.test(part))
  return [...kept, 'viewport-fit=cover'].join(', ')
}

function coverCutout(doc: FullscreenDoc): void {
  const meta = doc.querySelector('meta[name="viewport"]')
  if (!meta) return
  const content = meta.getAttribute('content') ?? ''
  const next = withCover(content)
  if (next !== content) meta.setAttribute('content', next)
}

/** Reads a media query; a parameter so a test needs no window. */
export type MediaMatch = (query: string) => { matches: boolean }

export const pageMedia: MediaMatch = (query) => window.matchMedia(query)

export const installedFullscreen = (doc: FullscreenDoc, match: MediaMatch): boolean =>
  !isFullscreen(doc) && match('(display-mode: fullscreen)').matches

export function coverInstalledApp(doc: FullscreenDoc, match: MediaMatch): void {
  if (installedFullscreen(doc, match)) coverCutout(doc)
}

/**
 * At boot, and again at DOMContentLoaded: this module runs before that event,
 * and the companion's boot script rewrites the viewport tag during it.
 */
export function startInstalledCover(): void {
  const cover = (): void => coverInstalledApp(document, pageMedia)
  cover()
  document.addEventListener('DOMContentLoaded', cover, { once: true })
}

/** Into full screen or back out; resolves to whether the page is full screen after. */
export async function toggleFullscreen(doc: FullscreenDoc): Promise<boolean> {
  if (!canFullscreen(doc)) return false
  try {
    if (isFullscreen(doc)) await doc.exitFullscreen?.()
    else {
      coverCutout(doc)
      await doc.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
    }
  } catch {
    // Refused: the page stays as it is, and the row says so from the browser's state.
  }
  return isFullscreen(doc)
}

export function subscribeFullscreen(doc: FullscreenDoc, cb: () => void): () => void {
  doc.addEventListener('fullscreenchange', cb)
  return () => doc.removeEventListener('fullscreenchange', cb)
}

const subscribeDocument = (cb: () => void): (() => void) => subscribeFullscreen(document, cb)
const readDocument = (): boolean => isFullscreen(document)
const readServer = (): boolean => false

export function useFullscreen(): boolean {
  return useSyncExternalStore(subscribeDocument, readDocument, readServer)
}
