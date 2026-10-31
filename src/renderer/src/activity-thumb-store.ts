import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { KeyedStore } from './keyed-store'
import type { TerminalActivity, TurnPhase } from '../../shared/turn'

/**
 * Per-terminal activity and per-browser thumbnails, moved OUT of the canvas-ui
 * context so a stream of activity events no longer re-renders every card. Each
 * card subscribes to its own id (useActivity/useThumb) and re-renders only when
 * that id changes; the few whole-map readers use the snapshot hooks.
 */
export const activityStore = new KeyedStore<TerminalActivity>()
export const thumbStore = new KeyedStore<string>()

/**
 * HAS THE ACTIVITY SNAPSHOT LANDED? Until it has, a card cannot tell "idle,
 * show my last turn" from "the answer is still on its way" — and it used to
 * guess idle: every terminal card on a booting phone read its stream tail,
 * then the snapshot arrived and threw the answer away. Twenty-three
 * exchanges through the relay for nothing (perf lane L7, measured
 * 2026-09-08). Flipped once by App when the snapshot resolves OR is refused,
 * so a refused snapshot degrades to the old behaviour rather than to cards
 * that never show a preview.
 */
/** How long a card waits for the activity snapshot before it stops waiting. */
export const ACTIVITY_SEED_DEADLINE_MS = 3_000

let activitySeeded = false
const seedListeners = new Set<() => void>()

export function markActivitySeeded(): void {
  if (activitySeeded) return
  activitySeeded = true
  for (const listener of seedListeners) listener()
}

/** Test seam: a fresh module state between cases. */
export function resetActivitySeededForTests(): void {
  activitySeeded = false
}

export function isActivitySeeded(): boolean {
  return activitySeeded
}

const subscribeSeed = (cb: () => void): (() => void) => {
  seedListeners.add(cb)
  return () => seedListeners.delete(cb)
}
const readSeed = (): boolean => activitySeeded

export function useActivitySeeded(): boolean {
  // Module-level functions, so a re-render never resubscribes.
  return useSyncExternalStore(subscribeSeed, readSeed, readSeed)
}

/** One terminal's latest activity. Re-renders only when THIS id changes. */
export function useActivity(id: string): TerminalActivity | undefined {
  // Keyed on the id: a fresh subscribe function per render would make React
  // unsubscribe and resubscribe on every render of the caller.
  const subscribe = useCallback((cb: () => void) => activityStore.subscribeKey(id, cb), [id])
  // The third read is the server snapshot: static renders (tests, previews) of
  // a Dock read the same store instead of throwing.
  return useSyncExternalStore(subscribe, () => activityStore.get(id), () => activityStore.get(id))
}

/** The whole activity map — for the header count / roster. Re-renders on any change. */
export function useActivitiesSnapshot(): Record<string, TerminalActivity> {
  return useSyncExternalStore(
    (cb) => activityStore.subscribeGlobal(cb),
    () => activityStore.getSnapshot()
  )
}

/**
 * How many of `ids` are in `phase` — the header's WORKING / attention counts.
 * A number, so the caller re-renders when the COUNT changes (an agent starts
 * or finishes), not on every activity event: App read the whole map for these
 * two counts and re-rendered — with the dock and the header — four times a
 * second while any agent worked (perf lane L6, 2026-09-06).
 */
export function useActivityPhaseCount(ids: readonly string[], phase: TurnPhase): number {
  return useSyncExternalStore(
    (cb) => activityStore.subscribeGlobal(cb),
    () => {
      let count = 0
      for (const id of ids) if (activityStore.get(id)?.phase === phase) count += 1
      return count
    }
  )
}

/**
 * The whole activity map, at most once per `ms`. The first change after a
 * quiet spell goes out at once and the last change always lands; only the
 * ones in between are folded together. For readers high in the tree: the
 * crew (App.tsx · useCrew) read every event and re-rendered the whole app
 * 10 to 20 times a second while agents worked (perf, 2026-11-01).
 */
export function useActivitiesEvery(ms: number): Record<string, TerminalActivity> {
  const [snapshot, setSnapshot] = useState(() => activityStore.getSnapshot())
  useEffect(() => {
    const read = (): void => setSnapshot(activityStore.getSnapshot())
    const off = coalesceEvery(ms, (cb) => activityStore.subscribeGlobal(cb), read)
    // Whatever changed between the first render and this subscription.
    read()
    return off
  }, [ms])
  return snapshot
}

/**
 * Calls `flush` for the changes `subscribe` reports, at most once per `ms`:
 * the first after a quiet spell at once (next task), the rest folded into one
 * at the end of the window. Returns the unsubscribe.
 */
export function coalesceEvery(ms: number, subscribe: (cb: () => void) => () => void, flush: () => void, now: () => number = Date.now): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = Number.NEGATIVE_INFINITY
  const fire = (): void => {
    timer = null
    last = now()
    flush()
  }
  const off = subscribe(() => {
    if (timer !== null) return
    timer = setTimeout(fire, Math.max(0, last + ms - now()))
  })
  return () => {
    off()
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The agents that are busy: waiting on you first, then thinking, each group
 * in the map's order, as one string (ids joined by spaces). A string, so a
 * reader re-renders when the list changes, not on every activity event:
 * the item pets read the whole map for this and rebuilt every item's JSX
 * several times a second while any agent worked (perf, 2026-11-01).
 */
export function busyAgentsKey(activities: Readonly<Record<string, TerminalActivity>>): string {
  const waiting: string[] = []
  const thinking: string[] = []
  for (const [id, activity] of Object.entries(activities)) {
    if (activity.phase === 'waiting') waiting.push(id)
    else if (activity.phase === 'thinking') thinking.push(id)
  }
  return [...waiting, ...thinking].join(' ')
}

export function useBusyAgents(): readonly string[] {
  const key = useSyncExternalStore(
    (cb) => activityStore.subscribeGlobal(cb),
    () => busyAgentsKey(activityStore.getSnapshot())
  )
  return useMemo(() => (key ? key.split(' ') : []), [key])
}

/** One browser's latest thumbnail data URL. Re-renders only when THIS id changes. */
export function useThumb(id: string): string | undefined {
  const subscribe = useCallback((cb: () => void) => thumbStore.subscribeKey(id, cb), [id])
  // A third argument for the server snapshot: a card can be rendered to markup
  // in a test without a store, and then it simply has no picture yet.
  return useSyncExternalStore(subscribe, () => thumbStore.get(id), () => undefined)
}

/** The whole thumbnail map — for the roster sidebar. Re-renders on any change. */
export function useThumbsSnapshot(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => thumbStore.subscribeGlobal(cb),
    () => thumbStore.getSnapshot()
  )
}
