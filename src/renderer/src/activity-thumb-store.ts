import { useCallback, useSyncExternalStore } from 'react'
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

export function useActivitySeeded(): boolean {
  return useSyncExternalStore(
    (cb) => {
      seedListeners.add(cb)
      return () => seedListeners.delete(cb)
    },
    () => activitySeeded
  )
}

/** One terminal's latest activity. Re-renders only when THIS id changes. */
export function useActivity(id: string): TerminalActivity | undefined {
  // Keyed on the id: a fresh subscribe function per render would make React
  // unsubscribe and resubscribe on every render of the caller.
  const subscribe = useCallback((cb: () => void) => activityStore.subscribeKey(id, cb), [id])
  return useSyncExternalStore(subscribe, () => activityStore.get(id))
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

/** One browser's latest thumbnail data URL. Re-renders only when THIS id changes. */
export function useThumb(id: string): string | undefined {
  const subscribe = useCallback((cb: () => void) => thumbStore.subscribeKey(id, cb), [id])
  return useSyncExternalStore(subscribe, () => thumbStore.get(id))
}

/** The whole thumbnail map — for the roster sidebar. Re-renders on any change. */
export function useThumbsSnapshot(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => thumbStore.subscribeGlobal(cb),
    () => thumbStore.getSnapshot()
  )
}
