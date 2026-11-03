/**
 * WHO IS RUNNING THIS PAGE — a browser tab, or a Home Screen web app.
 *
 * On iOS the two are different processes with different privileges, and
 * local network privacy is decided per PROCESS (Apple TN3179): Safari's own
 * traffic is exempt, a web app pinned to the Home Screen is its own thing.
 * On 2026-10-11 every knock from the owner's phone — fetch, socket, image —
 * timed out at the LAN name while a Safari tab had worked during the day;
 * the report could not say which of the two had made the attempt. Now it
 * does, in one word, so the Mac's log reads "standalone" where that is the
 * fact and nobody diagnoses a browser from a photograph of a web app.
 */

export type PageContext = 'standalone' | 'browser'

export interface PageContextDeps {
  readonly standalone?: boolean
  readonly matchMedia?: (query: string) => { matches: boolean }
}

export const pageContextOf = (deps: PageContextDeps): PageContext => {
  if (deps.standalone === true) return 'standalone'
  try {
    if (deps.matchMedia?.('(display-mode: standalone)').matches) return 'standalone'
  } catch {
    // No media queries is a plain browser as far as this word goes.
  }
  return 'browser'
}

/** The live page: iOS's `navigator.standalone`, and the standard display-mode query. */
export const pageContext = (): PageContext =>
  pageContextOf({
    standalone: (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone,
    matchMedia: typeof globalThis.matchMedia === 'function' ? (q) => globalThis.matchMedia(q) : undefined
  })
