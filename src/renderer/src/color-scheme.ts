import { useEffect, useState } from 'react'

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

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** What a page in this shell does: a browser follows the system, the app stays light. */
export const schemeModeFor = (remote: boolean): SchemeMode => (remote ? 'auto' : 'light')

let mode: SchemeMode = 'light'

/** Once at boot, before the first paint the CSS decides. */
export const applyColorScheme = (remote: boolean, root: HTMLElement = document.documentElement): SchemeMode => {
  mode = schemeModeFor(remote)
  root.dataset.scheme = mode
  return mode
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null

/** Is the page drawn dark right now? For what CSS cannot reach (xterm's canvas). */
export const isNight = (): boolean => mode === 'auto' && (darkQuery()?.matches ?? false)

/** The same, as React state that follows the system flipping while the page is open. */
export const useNight = (): boolean => {
  const [night, setNight] = useState(isNight)
  useEffect(() => {
    const query = darkQuery()
    if (!query) return
    const update = (): void => setNight(isNight())
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return night
}
