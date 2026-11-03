/**
 * THE WINDOW'S HOLD ON THE INBOX (R3).
 *
 * The renderer subscribes when its box opens and unsubscribes when it closes;
 * a reload or a closed window sends no unsubscribe, so the hold has to go
 * with the page that took it. Round 2 bound that to `once` listeners on the
 * webContents — re-registered on EVERY subscribe and never removed, so an
 * evening of ⌘K left a pile of dead closures on the window, and a same-document
 * navigation (a hash change) or an iframe's own navigation dropped the hold
 * under a box that was still open.
 *
 * One pair of NAMED handlers per hold: bound when the hold is taken, removed
 * when it is released — by the unsubscribe, by a main-frame navigation that is
 * not same-document, or by the webContents being destroyed.
 */

/** What a main-frame navigation looks like to us; Electron's details carry both flags. */
export interface NavigationDetails {
  isMainFrame?: boolean
  isSameDocument?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void

/** The slice of Electron's WebContents the hold needs — any EventEmitter fits. */
export interface HoldableContents {
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
}

export interface WindowHold {
  /** Take the hold for this page if none is held; idempotent while held. */
  subscribe(contents: HoldableContents): void
  /** Drop the hold and unbind its handlers; a no-op when nothing is held. */
  release(): void
  held(): boolean
}

/** A page navigation that leaves the document behind — not a hash change, not a subframe. */
export function leavesDocument(details: NavigationDetails | undefined): boolean {
  return details?.isMainFrame === true && details.isSameDocument !== true
}

export function createWindowHold(hold: () => () => void): WindowHold {
  let bound: { contents: HoldableContents; release: () => void; onNavigate: Listener; onDestroyed: Listener } | null = null

  const release = (): void => {
    const current = bound
    if (!current) return
    bound = null
    current.contents.removeListener('did-start-navigation', current.onNavigate)
    current.contents.removeListener('destroyed', current.onDestroyed)
    current.release()
  }

  const subscribe = (contents: HoldableContents): void => {
    if (bound) return
    const onNavigate: Listener = (details: NavigationDetails | undefined) => {
      if (leavesDocument(details)) release()
    }
    const onDestroyed: Listener = () => release()
    bound = { contents, release: hold(), onNavigate, onDestroyed }
    contents.on('did-start-navigation', onNavigate)
    contents.on('destroyed', onDestroyed)
  }

  return { subscribe, release, held: () => bound !== null }
}
