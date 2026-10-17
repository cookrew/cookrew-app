/**
 * THE COMPANION UPDATES ITSELF — the Mac names its build (main/build-id.ts)
 * on the event stream, and a page running another build reloads.
 *
 * Never while the reader is looking at it: a reload under a finger loses a
 * half-typed prompt. The reload waits for the page to be hidden or shown
 * again — the owner switching apps — which on iOS is the one moment a
 * resident Home Screen app is ever between uses. The first id a page hears
 * is its own build, so a page never reloads for the build it loaded.
 */

export interface BuildWatchDeps {
  /** Subscribe to the Mac's build id; returns the unsubscribe. */
  readonly onBuild: (cb: (id: string) => void) => () => void
  readonly reload: () => void
  readonly onVisibility: (cb: () => void) => () => void
}

export const watchBuild = (deps: BuildWatchDeps): (() => void) => {
  let mine: string | null = null
  let stale = false
  const offBuild = deps.onBuild((id) => {
    if (typeof id !== 'string' || id.length === 0) return
    if (mine === null) {
      mine = id
      return
    }
    if (id !== mine) stale = true
  })
  const offVisibility = deps.onVisibility(() => {
    if (stale) deps.reload()
  })
  return () => {
    offBuild()
    offVisibility()
  }
}
