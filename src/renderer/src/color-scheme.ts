import { useEffect, useState, useSyncExternalStore } from 'react'

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
 */
export type ThemeName = 'ink' | 'root'

const THEME_KEY = 'cookrew.theme'

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

/** Only an exact 'root' is root: a stray or old value falls back to ink. */
export const themeFrom = (stored: string | null | undefined): ThemeName => (stored === 'root' ? 'root' : 'ink')

/** Sets the attribute the CSS reads; ink removes it, so ink is exactly the page it was. */
export const applyTheme = (next: ThemeName, root: HTMLElement = document.documentElement): ThemeName => {
  theme = next
  if (next === 'root') root.dataset.theme = 'root'
  else delete root.dataset.theme
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

/** The ⋯ menu's switch: remembered on this device, applied at once. */
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

/** Is the page drawn dark right now? For what CSS cannot reach (xterm's canvas). */
export const isNight = (): boolean => theme === 'root' || (mode === 'auto' && (darkQuery()?.matches ?? false))

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
