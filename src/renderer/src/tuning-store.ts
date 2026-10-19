// WHAT EACH AGENT IS RUNNING ON, per card, for every view of it.
//
// Its own KeyedStore rather than a field on activity, for the reason
// keyed-store.ts exists at all: activity changes several times a second while
// a turn runs, and the model an agent answers on changes perhaps twice a day.
// Folding one into the other would re-render every tag on every scrape.
//
// A card whose id is not in here draws NO tag. Absent means "not recorded
// yet" — a fresh agent that has not replied, a harness that keeps no session
// file, a plain shell — and an empty chip would be a claim of its own.

import { useCallback, useSyncExternalStore } from 'react'
import { KeyedStore } from './keyed-store'
import type { AgentTuning } from '../../shared/agent-tuning'

export const tuningStore = new KeyedStore<AgentTuning>()

/** One terminal's dials. Re-renders only when THIS id changes. */
export function useTuning(id: string): AgentTuning | undefined {
  // Keyed on the id: a fresh subscribe function per render would make React
  // unsubscribe and resubscribe on every render of the caller.
  const subscribe = useCallback((cb: () => void) => tuningStore.subscribeKey(id, cb), [id])
  const read = useCallback(() => tuningStore.get(id), [id])
  // Same reader as the server snapshot: the store is plain module state with
  // no DOM behind it, so there is nothing for a server pass to read
  // DIFFERENTLY. Passing it makes the tag renderable by renderToStaticMarkup,
  // which is how the render tests assert the markup at all.
  return useSyncExternalStore(subscribe, read, read)
}
