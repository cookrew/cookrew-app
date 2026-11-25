import type { GuestCommand, GuestReport } from '../../../shared/machine-guest'

/**
 * THE GUEST'S TWO WORDS WITH THE WINDOW THAT HOLDS IT (shared/machine-guest.ts;
 * preload/machine-guest.ts puts them here). Absent everywhere but in a guest:
 * the desktop's own window, a phone and the console all get null, and every
 * caller is then a no-op.
 */
export interface GuestBridge {
  report(message: GuestReport): void
  onCommand(cb: (command: GuestCommand) => void): () => void
}

export function guestBridge(): GuestBridge | null {
  if (typeof window === 'undefined') return null
  const held = (window as { cookrewGuest?: GuestBridge }).cookrewGuest
  return held && typeof held.report === 'function' && typeof held.onCommand === 'function' ? held : null
}

/** The last route said, so a render that changed nothing says nothing. */
let lastRoute = ''

/** Where the guest stands, as its own title line names it: the window draws these on its own line. */
export function reportGuestRoute(workspace: string | null, agent: string | null): void {
  const bridge = guestBridge()
  if (bridge === null) return
  const said = JSON.stringify([workspace, agent])
  if (said === lastRoute) return
  lastRoute = said
  bridge.report({ kind: 'route', workspace, agent })
}
