import { useSyncExternalStore } from 'react'
import type { ServedCallersRow } from '../../shared/seats'
import { cookrew } from './api'

/**
 * The callers at this desktop's served doors — ONE subscription for the
 * whole canvas.
 *
 * WHY THIS EXISTS. useServedCallers used to subscribe per hook instance:
 * every mounted card called api.onServingCallers (an ipcRenderer.on in the
 * preload) and invoked servingCallers() once. On the owner's 114-node
 * workspace that was ~114 IPC listeners on one channel — the startup log's
 * MaxListenersExceededWarning: 11 serving:callers listeners — ~114 invokes at
 * mount, and every push from main delivered and set-stated ~114 times.
 *
 * Same shape as activity-thumb-store.ts: module state behind
 * useSyncExternalStore. The IPC subscription is created lazily by the first
 * consumer and released by the last (refcounted), servingCallers() is invoked
 * once per subscription lifetime, and the snapshot is a stable reference that
 * only changes when the rows actually differ — so a push that repeats what the
 * canvas already shows re-renders no card at all.
 */

const EMPTY: readonly ServedCallersRow[] = Object.freeze([])
type Listener = () => void

let rows: readonly ServedCallersRow[] = EMPTY
const listeners = new Set<Listener>()
let consumers = 0
let release: (() => void) | null = null
/** Bumped on every open and close, so an invoke that resolves after its lifetime is ignored. */
let generation = 0

/** Structural equality for the plain JSON shapes main pushes (rows, callers, primitives). */
export function sameRows(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => sameRows(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && sameRows(left[key], right[key]))
}

/** Adopt a push. Identical rows keep the snapshot's identity and notify nobody. */
function publish(next: readonly ServedCallersRow[]): void {
  if (sameRows(rows, next)) return
  rows = next
  for (const cb of listeners) cb()
}

function open(): void {
  const api = cookrew()
  generation += 1
  const mine = generation
  if (api.servingCallers) {
    void api
      .servingCallers()
      .then((initial) => {
        if (mine === generation) publish(initial)
      })
      .catch(() => undefined)
  }
  release = api.onServingCallers?.(publish) ?? null
}

function close(): void {
  generation += 1
  release?.()
  release = null
}

/** useSyncExternalStore's subscribe: the first consumer opens the IPC door, the last closes it. */
export function subscribeServedCallers(cb: Listener): () => void {
  listeners.add(cb)
  consumers += 1
  if (consumers === 1) open()
  let live = true
  return () => {
    if (!live) return
    live = false
    listeners.delete(cb)
    consumers -= 1
    if (consumers === 0) close()
  }
}

/** The current rows — the same reference until a push actually changes them. */
export function getServedCallersSnapshot(): readonly ServedCallersRow[] {
  return rows
}

/** Live callers at this desktop's doors, pushed from main. One IPC subscription however many cards read it. */
export function useServedCallers(): readonly ServedCallersRow[] {
  return useSyncExternalStore(subscribeServedCallers, getServedCallersSnapshot, getServedCallersSnapshot)
}

export interface ServedCallersStoreStats {
  /** Hook instances (or other subscribers) currently mounted. */
  readonly consumers: number
  /** Whether the one IPC subscription is open right now. */
  readonly subscribed: boolean
}

/** Read-only, for the tests. */
export function servedCallersStoreStats(): ServedCallersStoreStats {
  return { consumers, subscribed: release !== null }
}

/** Test seam: the store is module state, so a suite must be able to reset it. */
export function resetServedCallersStore(): void {
  if (release !== null) close()
  listeners.clear()
  consumers = 0
  rows = EMPTY
}
