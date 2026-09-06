import type { LocalNetworkState } from './local-network'

/**
 * THE ONE PLACE THAT KNOWS WHETHER THE BROWSER WILL LET US IN.
 *
 * Three parties need this fact and none of them can own it: the plane switcher
 * decides whether to race on it, the badge decides which sentence to say on
 * it, and the explainer row is the only surface allowed to CHANGE it. So it is
 * the same shape as path-link.ts — a value, a set of listeners, and a
 * subscribe — and for the same reason: the thing that feeds it is not React.
 *
 * THE ASK IS AN OFFER, NOT A CAPABILITY. `offerLocalNetwork` is called by the
 * switcher's wiring once it knows a trusted name worth probing, and until then
 * the row renders nothing. A button that raises a permission prompt with no
 * address to aim it at would spend the one ask a reader will ever grant on a
 * request that cannot succeed — and a dismissed prompt is a refusal that
 * persists.
 */

let state: LocalNetworkState = 'unsupported'
let ask: (() => Promise<void>) | null = null
const listeners = new Set<(next: LocalNetworkState) => void>()

export const localNetworkGate = (): LocalNetworkState => state

/** True once the switcher has somewhere to point the ask. */
export const localNetworkOffered = (): boolean => ask !== null

export const setLocalNetwork = (next: LocalNetworkState): void => {
  if (state === next) return
  state = next
  for (const listener of listeners) listener(state)
}

/** Register the ask for the life of the switcher; call the result to drop it. */
export const offerLocalNetwork = (handler: () => Promise<void>): (() => void) => {
  ask = handler
  for (const listener of listeners) listener(state)
  return () => {
    if (ask === handler) ask = null
  }
}

/**
 * The reader pressed ALLOW. Exactly one attempt, and never a retry.
 *
 * A rejection is swallowed on purpose: the handler's whole job is to update
 * this store, so a failure has already been recorded as whatever the
 * permission store now says, and there is nothing a caller could usefully do.
 */
export const acceptLocalNetwork = async (): Promise<void> => {
  const handler = ask
  if (!handler) return
  try {
    await handler()
  } catch {
    // Left as whatever the permission store last said.
  }
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
  ask = null
  listeners.clear()
}
