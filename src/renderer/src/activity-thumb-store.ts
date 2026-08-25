import { useSyncExternalStore } from 'react'
import { KeyedStore } from './keyed-store'
import type { TerminalActivity } from '../../shared/turn'

/**
 * Per-terminal activity and per-browser thumbnails, moved OUT of the canvas-ui
 * context so a stream of activity events no longer re-renders every card. Each
 * card subscribes to its own id (useActivity/useThumb) and re-renders only when
 * that id changes; the few whole-map readers use the snapshot hooks.
 */
export const activityStore = new KeyedStore<TerminalActivity>()
export const thumbStore = new KeyedStore<string>()

/** One terminal's latest activity. Re-renders only when THIS id changes. */
export function useActivity(id: string): TerminalActivity | undefined {
  return useSyncExternalStore(
    (cb) => activityStore.subscribeKey(id, cb),
    () => activityStore.get(id)
  )
}

/** The whole activity map — for the header count / roster. Re-renders on any change. */
export function useActivitiesSnapshot(): Record<string, TerminalActivity> {
  return useSyncExternalStore(
    (cb) => activityStore.subscribeGlobal(cb),
    () => activityStore.getSnapshot()
  )
}

/** One browser's latest thumbnail data URL. Re-renders only when THIS id changes. */
export function useThumb(id: string): string | undefined {
  return useSyncExternalStore(
    (cb) => thumbStore.subscribeKey(id, cb),
    () => thumbStore.get(id)
  )
}

/** The whole thumbnail map — for the roster sidebar. Re-renders on any change. */
export function useThumbsSnapshot(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => thumbStore.subscribeGlobal(cb),
    () => thumbStore.getSnapshot()
  )
}
