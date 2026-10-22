// THE WINDOW'S LEVELS FEED: this desktop as the levels view's machine.
//
// One feed per window, started by its first reader and stopped a moment after
// its last (StrictMode's mount-unmount-mount must not redial). Events fold
// into the snapshot exactly as the cookrew.dev shell folds its streams
// (strata/fleet/levels-fold.ts); a gap reopens the feed, which starts on a
// fresh snapshot. The rows are the same array until something changes.
//
// A window out of sight (hidden, minimized) closes the feed: an open stream
// holds the board's sampler on main. In sight again, it reopens on a snapshot.
import { useSyncExternalStore } from 'react'
import type { LevelsEvent, LevelsSnapshot, MachineLink, StrataMachine } from '../../../shared/strata'
import { foldLevels } from '../../../strata/fleet/levels-fold'
import { cookrew } from '../api'

/** The one machine's id in level paths. Paths stay in this window, so it only has to be stable. */
export const LOCAL_MACHINE_ID = 'this-desktop'

/** An empty answer is "no levels", not "not yet", once this has passed. */
export const LOCAL_LOAD_GRACE_MS = 2_500
const STOP_GRACE_MS = 1_000

interface FeedState {
  levels: LevelsSnapshot | null
  link: MachineLink
  loaded: boolean
}

export const localMachine = (levels: LevelsSnapshot | null, link: MachineLink): StrataMachine => ({
  id: LOCAL_MACHINE_ID,
  name: levels?.machine.name ?? 'This desktop',
  online: link === 'live',
  lastSeenAt: levels?.at ?? null,
  appVersion: levels?.machine.appVersion ?? null,
  profile: levels?.machine.profile ?? null,
  base: '',
  link,
  levels,
  stale: false
})

export interface LocalFleet {
  subscribe: (listener: () => void) => () => void
  fleet: () => StrataMachine[]
  loaded: () => boolean
}

type Subscribe = (cb: (event: LevelsEvent) => void) => () => void

/** Whether the window is out of sight, and word when that changes. */
export interface Sight {
  hidden: () => boolean
  watch: (changed: () => void) => () => void
}

const documentSight: Sight = {
  hidden: () => document.visibilityState === 'hidden',
  watch: (changed) => {
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }
}

export function createLocalFleet(feed: () => Subscribe | undefined, graceMs = LOCAL_LOAD_GRACE_MS, sight: Sight | null = null): LocalFleet {
  let state: FeedState = { levels: null, link: 'connecting', loaded: false }
  let rows: StrataMachine[] = [localMachine(null, 'connecting')]
  const listeners = new Set<() => void>()
  let release: (() => void) | null = null
  let grace: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let unwatch: (() => void) | null = null

  const publish = (next: FeedState): void => {
    if (next.levels !== state.levels || next.link !== state.link) rows = [localMachine(next.levels, next.link)]
    state = next
    for (const listener of listeners) listener()
  }

  const onEvent = (event: LevelsEvent): void => {
    const folded = foldLevels(state.levels, event)
    if (folded.ok) return publish({ levels: folded.levels, link: 'live', loaded: true })
    // A missed delta cannot be rebuilt from the ones after it: reopen, which starts on a snapshot.
    close()
    open()
  }

  const open = (): void => {
    const subscribe = feed()
    if (!subscribe) return publish({ ...state, link: 'outdated', loaded: true })
    release = subscribe(onEvent)
  }
  const close = (): void => {
    release?.()
    release = null
  }

  const onSight = (): void => {
    if (sight?.hidden()) return close()
    if (listeners.size > 0) start()
  }

  const start = (): void => {
    if (stopTimer !== null) clearTimeout(stopTimer)
    stopTimer = null
    if (sight && unwatch === null) unwatch = sight.watch(onSight)
    if (release || sight?.hidden()) return
    open()
    grace ??= setTimeout(() => {
      if (!state.loaded) publish({ ...state, loaded: true })
    }, graceMs)
  }
  const stop = (): void => {
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (listeners.size > 0) return
      close()
      if (grace !== null) clearTimeout(grace)
      grace = null
      unwatch?.()
      unwatch = null
    }, STOP_GRACE_MS)
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    fleet: () => rows,
    loaded: () => state.loaded
  }
}

let shared: LocalFleet | null = null
const localFleet = (): LocalFleet => {
  shared ??= createLocalFleet(() => cookrew().subscribeLevels, LOCAL_LOAD_GRACE_MS, documentSight)
  return shared
}

const subscribe = (listener: () => void): (() => void) => localFleet().subscribe(listener)

export const useLocalFleet = (): StrataMachine[] => useSyncExternalStore(subscribe, () => localFleet().fleet())

export const useLocalFleetLoaded = (): boolean => useSyncExternalStore(subscribe, () => localFleet().loaded())
