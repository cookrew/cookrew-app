import type { LocalNetworkState } from './local-network'

/**
 * THE ONE PLACE THAT KNOWS WHAT THE BROWSER SAYS ABOUT THE LOCAL NETWORK.
 *
 * The companion reads the permission once per race (path/companion.ts) and
 * reports it to the Mac with the path report; nothing on screen draws it since
 * the names went (2026-11-19: the WebRTC link does not ask for it). Same
 * shape as path-link.ts — a value, a set of listeners, and a subscribe — and
 * for the same reason: the thing that feeds it is not React.
 *
 * NOTHING HERE ASKS FOR IT ANY MORE. The ALLOW button raised Chrome's prompt
 * with a request to one of the Mac's names under d.cookrew.dev; those names
 * are gone (2026-11-16), so there is nothing left to aim an ask at. The
 * permission is the browser's, and it is not one machine's, so it is kept
 * across a change of machine.
 */

let state: LocalNetworkState = 'unsupported'
const listeners = new Set<(next: LocalNetworkState) => void>()

export const localNetworkGate = (): LocalNetworkState => state

export const setLocalNetwork = (next: LocalNetworkState): void => {
  if (state === next) return
  state = next
  for (const listener of listeners) listener(state)
}

export const subscribeLocalNetwork = (
  listener: (next: LocalNetworkState) => void
): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetLocalNetworkGate = (): void => {
  state = 'unsupported'
  listeners.clear()
}
