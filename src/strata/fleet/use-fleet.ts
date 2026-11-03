// The React face of the fleet store (UseFleet in src/strata/seams.ts): one
// store per page, started by its first reader and stopped a moment after its
// last, so StrictMode's mount-unmount-mount does not drop and redial every
// desktop. The rows are the same array until something changes.
import { useSyncExternalStore } from 'react'
import type { StrataMachine } from '../../shared/strata'
import { browserFleetDeps, defaultFleetConfig } from './browser-deps'
import { createFleetStore, type FleetStore } from './fleet-store'

const STOP_GRACE_MS = 1_000

let shared: FleetStore | null = null
let readers = 0
let stopTimer: ReturnType<typeof setTimeout> | null = null

/** The page's one fleet store; the index and the embed pool read the same one. */
export const fleetStore = (): FleetStore => {
  shared ??= createFleetStore(browserFleetDeps(), defaultFleetConfig())
  return shared
}

const subscribe = (listener: () => void): (() => void) => {
  const store = fleetStore()
  const off = store.subscribe(listener)
  readers += 1
  if (stopTimer !== null) clearTimeout(stopTimer)
  stopTimer = null
  store.start()
  return () => {
    off()
    readers -= 1
    if (readers > 0) return
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (readers === 0) store.stop()
    }, STOP_GRACE_MS)
  }
}

const getSnapshot = (): StrataMachine[] => fleetStore().getSnapshot()

export const useFleet = (): StrataMachine[] => useSyncExternalStore(subscribe, getSnapshot)

const getLoaded = (): boolean => fleetStore().loaded()

/** UseFleetLoaded (seams.ts): the list has answered, from cache, live or with an error. */
export const useFleetLoaded = (): boolean => useSyncExternalStore(subscribe, getLoaded)
