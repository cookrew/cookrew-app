import { useEffect, useState, useSyncExternalStore } from 'react'
import { skinFrom, skinInfo, type SkinId } from '../../shared/skins'

/**
 * LIGHT OR DARK — the companion follows the phone, the desktop stays paper.
 *
 * The app had one scheme, cream and ink, and the phone companion was shown
 * in a phone's dark mode anyway: Samsung Internet (and Chrome's auto dark)
 * darken a page that does not say it has a dark scheme, by inverting colours
 * it knows nothing about — grey slabs for cards, a black bar where the paper's
 * prompt line was, amber left glaring (2026-10-30, the owner's screenshot).
 * So a page served to a browser follows the system's scheme with real night
 * tokens (night.css) and says so (`color-scheme`), which stops the forced
 * darkening.
 *
 * THE DESKTOP APP STAYS LIGHT, as it already did for the levels (af07534): it
 * has no dark theme the owner asked for, and a dark-mode Mac must not get one
 * by accident. `data-scheme` on <html> is the one switch the CSS reads:
 * 'auto' follows `prefers-color-scheme`, 'light' never does.
 */

export type SchemeMode = 'auto' | 'light'

/**
 * THE THEME, a second axis (owner 2026-11-03): `ink` is the paper the app has
 * worn since 10-31; `root` is the Mr. Robot look, the same ink theme
 * recoloured (zoom/root-theme.css), with every shape kept. `data-theme="root"`
 * on <html> is its one switch; ink sets nothing. Root is always dark, so it
 * draws night even on the desktop, which otherwise stays paper.
 *
 * THE THEME IS THE SKIN now (owner 2026-11-12): fourteen looks, the account's
 * pick (shared/skins.ts, skins/skin-sync.ts). Still one attribute, still
 * nothing for ink. Root keeps its own sheet; the other twelve are drawn from
 * their palettes (skins/skin-look.ts), only the one worn in the page. A dark
 * skin draws night everywhere, a light one never, and a skin with both
 * follows the scheme above, so the desktop wears its light side.
 *
 * The drawing is a chunk of its own, so the console's first load stays small
 * (console-first-load.test.ts). A page never waits on it to paint: the sheet
 * last drawn is kept on the device and worn at boot as it was, then drawn
 * again by this build.
 */
export type ThemeName = SkinId

const THEME_KEY = 'cookrew.theme'
const SKIN_CSS_KEY = 'cookrew.skin-css'
const SKIN_STYLE_ID = 'cr-skin'
/** The two skins with sheets of their own (ink-theme.css, root-theme.css). */
const OWN_SHEET: ReadonlySet<ThemeName> = new Set<ThemeName>(['ink', 'root'])

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** What a page in this shell does: a browser follows the system, the app stays light. */
export const schemeModeFor = (remote: boolean): SchemeMode => (remote ? 'auto' : 'light')

let mode: SchemeMode = 'light'
let theme: ThemeName = 'ink'
const themeListeners = new Set<() => void>()

/** Once at boot, before the first paint the CSS decides. */
export const applyColorScheme = (remote: boolean, root: HTMLElement = document.documentElement): SchemeMode => {
  mode = schemeModeFor(remote)
  root.dataset.scheme = mode
  return mode
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null

/** Only an exact skin id is a skin: a stray or old value falls back to ink. */
export const themeFrom = (stored: string | null | undefined): ThemeName => skinFrom(stored)

/** The sheet this device last drew for `skin`, if that is the one it holds. */
const keptSheet = (skin: ThemeName): string | null => {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(SKIN_CSS_KEY) ?? 'null') as { skin?: unknown; css?: unknown } | null
    return kept?.skin === skin && typeof kept.css === 'string' ? kept.css : null
  } catch {
    return null
  }
}

const keepSheet = (skin: ThemeName, css: string): void => {
  try {
    globalThis.localStorage?.setItem(SKIN_CSS_KEY, JSON.stringify({ skin, css }))
  } catch {
    // Full or private: the next boot draws it a moment later.
  }
}

/** Which skin this build has drawn into the page; a kept sheet may be an older build's. */
let drawnHere: ThemeName | null = null

/** The worn skin's own stylesheet, swapped whole; none for ink and root, which have theirs. */
const wearSheet = (next: ThemeName, root: HTMLElement): void => {
  const doc = root.ownerDocument
  if (!doc?.head) return
  const put = (css: string): void => {
    if (theme !== next) return
    const style = doc.getElementById(SKIN_STYLE_ID) ?? doc.createElement('style')
    style.id = SKIN_STYLE_ID
    style.dataset.skin = next
    style.textContent = css
    // Last in <head>, after every sheet it recolours.
    doc.head.appendChild(style)
  }
  if (OWN_SHEET.has(next)) {
    doc.getElementById(SKIN_STYLE_ID)?.remove()
    return
  }
  if (drawnHere === next && doc.getElementById(SKIN_STYLE_ID)?.dataset.skin === next) return
  const kept = keptSheet(next)
  if (kept !== null) put(kept)
  void import('./skins/skin-look').then(({ isDrawnSkin, skinCss }) => {
    if (theme !== next || !isDrawnSkin(next)) return
    const css = skinCss(next)
    drawnHere = next
    if (css !== kept) put(css)
    keepSheet(next, css)
  })
}

/** Sets the attribute the CSS reads; ink removes it, so ink is exactly the page it was. */
export const applyTheme = (next: ThemeName, root: HTMLElement = document.documentElement): ThemeName => {
  theme = next
  if (next === 'ink') delete root.dataset.theme
  else root.dataset.theme = next
  wearSheet(next, root)
  return next
}

/** The stored theme, once at boot before the first paint. */
export const storedTheme = (): ThemeName => {
  try {
    return themeFrom(globalThis.localStorage?.getItem(THEME_KEY))
  } catch {
    return 'ink'
  }
}

export const themeNow = (): ThemeName => theme

/** Remembered on this device too, so the next boot paints the account's skin before it hears from it. */
export const setTheme = (next: ThemeName): void => {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, next)
  } catch {
    // Private mode: the switch still works for this page.
  }
  applyTheme(next)
  themeListeners.forEach((listener) => listener())
}

const subscribeTheme = (listener: () => void): (() => void) => {
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

export const useTheme = (): ThemeName => useSyncExternalStore(subscribeTheme, themeNow, themeNow)

/** Would a skin with both sides wear its dark one here? Only a page that follows a dark system. */
export const schemeIsDark = (): boolean => mode === 'auto' && (darkQuery()?.matches ?? false)

/** Is the page drawn dark right now? For what CSS cannot reach (xterm's canvas). */
export const isNight = (): boolean => {
  const skin = skinInfo(theme).mode
  return skin === 'both' ? schemeIsDark() : skin === 'dark'
}

/** The same, as React state that follows the system flipping while the page is open. */
export const useNight = (): boolean => {
  const [night, setNight] = useState(isNight)
  useEffect(() => {
    const query = darkQuery()
    const update = (): void => setNight(isNight())
    update()
    const unsubscribe = subscribeTheme(update)
    query?.addEventListener('change', update)
    return () => {
      unsubscribe()
      query?.removeEventListener('change', update)
    }
  }, [])
  return night
}
