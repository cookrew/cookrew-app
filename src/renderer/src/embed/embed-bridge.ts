// The embed's side of the strata handoff (src/shared/strata.ts): it believes
// a message only from window.parent on its own origin, and speaks only to its
// parent on its own origin. Never a wildcard target: the shell is same-origin
// by construction, and anything else is not the shell.
import type { EmbedToShell, ShellToEmbed } from '../../../shared/strata'
import { fromShell } from '../../../strata/embed/messages'

export function tellShell(message: EmbedToShell): void {
  if (window.parent === window) return
  window.parent.postMessage(message, window.location.origin)
}

export function listenToShell(run: (message: ShellToEmbed) => void): () => void {
  const onMessage = (event: MessageEvent): void => {
    const message = fromShell(event, window.location.origin, window.parent, window)
    if (message) run(message)
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
