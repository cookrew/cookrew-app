/**
 * WHAT THE MAC SAID ABOUT ITS OWN NAMES, the last time the card was read.
 *
 * `/api/reach` now carries `publish` (main reach.ts · reachAnswer): when the
 * registry last took this Mac's card, its standing refusal, and whether the
 * zone is still answering the names the card lists. The badge reads it to
 * stop saying "your Mac is not on this network" about a Mac whose names were
 * simply not published (2026-10-04, five days of NXDOMAIN).
 *
 * Shaped like path-link.ts — a value, a set of listeners, a subscribe —
 * because the thing that writes it is the switcher's card fetch, not React.
 */

export interface ReachPublish {
  readonly at: number | null
  readonly refused: string | null
  readonly live: boolean
}

let state: ReachPublish | null = null
const listeners = new Set<(next: ReachPublish | null) => void>()

export const reachPublish = (): ReachPublish | null => state

export const setReachPublish = (next: ReachPublish | null): void => {
  if (state?.at === next?.at && state?.refused === next?.refused && state?.live === next?.live) return
  state = next
  for (const listener of listeners) listener(state)
}

export const subscribeReachPublish = (
  listener: (next: ReachPublish | null) => void
): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * THE WORD THE BADGE NEEDS, or nothing.
 *
 * Nothing while the names are live, and nothing while the card has simply
 * not been read yet; the registry's refusal when there is one; 'stale' when
 * a card was accepted once and the zone has since forgotten it.
 */
export const unpublishedReason = (publish: ReachPublish | null): string | undefined => {
  if (publish === null || publish.live) return undefined
  if (publish.refused !== null) return publish.refused
  return publish.at !== null ? 'stale' : undefined
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetReachPublish = (): void => {
  state = null
  listeners.clear()
}
