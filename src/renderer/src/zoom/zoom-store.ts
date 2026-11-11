/**
 * THE ZOOM'S STATE, shared: the view (ZoomView.tsx) draws it, the header's
 * route and the pets drive it, App reads whether a full view is showing. A
 * plain store, no React in it; `useZoom` subscribes.
 *
 *   dir, v       where the view is going (zoom-path.ts); the view chases v
 *   agent, item  who holds the focus: the open card / full view on each side
 *   full         set by the view once it has handed over to the real full view
 */
import { registerScopeState, scopeNeedsMachine } from '../machine-scope'
import { useSyncExternalStore } from 'react'
import { clampTo, type ZoomDir } from './zoom-path'

export interface ZoomState {
  dir: ZoomDir
  v: number
  agent: string | null
  item: string | null
  /** The view stands at a full view and the stage below is showing it. */
  full: 'agent' | 'item' | null
  /** Bumped when a jump across is asked for: the view plays the crossfade, not the chase. */
  jump: number
}

const KEY = 'cookrew.zoom'

/**
 * ON THE CONSOLE THE LEVEL IS THE ADDRESS (console/console-router.ts), so
 * nothing of it is kept here: a level in storage would fight the address on
 * every load and carry one machine's place into the next.
 */
const read = (): Pick<ZoomState, 'dir' | 'v'> => {
  if (scopeNeedsMachine()) return { dir: 'agents', v: -1 }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { dir?: unknown; v?: unknown } | null
    const dir: ZoomDir = raw?.dir === 'items' ? 'items' : 'agents'
    const v = typeof raw?.v === 'number' && Number.isFinite(raw.v) ? clampTo(dir, raw.v) : -1
    // A full view is not restored: the stage behind it may be gone. Come back one step out.
    return { dir, v: dir === 'agents' ? Math.min(v, 1) : Math.min(v, 0) }
  } catch {
    return { dir: 'agents', v: -1 }
  }
}

let state: ZoomState = { ...read(), agent: null, item: null, full: null, jump: 0 }
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const cb of listeners) cb()
}
const persist = (): void => {
  if (scopeNeedsMachine()) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ dir: state.dir, v: state.v }))
  } catch {
    // private mode: the zoom is just not remembered
  }
}

export const zoomStore = {
  get: (): ZoomState => state,
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
  /** Go to v on this side (or the current one). */
  go(v: number, dir: ZoomDir = state.dir): void {
    // `full` is the view's to set, from the value it has actually reached
    // (use-zoom-motion.ts): a target alone must not unmount a full view the
    // eye is still looking at.
    const next = clampTo(dir, v)
    if (next === state.v && dir === state.dir) return
    state = { ...state, dir, v: next }
    persist()
    emit()
  },
  focusAgent(id: string | null): void {
    if (state.agent === id) return
    state = { ...state, agent: id }
    emit()
  },
  focusItem(id: string | null): void {
    if (state.item === id) return
    state = { ...state, item: id }
    emit()
  },
  /** Straight across to the other side's full view, or an agent's card (a crossfade, not a zoom). */
  jumpTo(kind: 'agent' | 'item' | 'card', id: string): void {
    state = kind === 'agent'
      ? { ...state, dir: 'agents', v: 3, agent: id, full: 'agent', jump: state.jump + 1 }
      : kind === 'card'
        ? { ...state, dir: 'agents', v: 2, agent: id, full: null, jump: state.jump + 1 }
        : { ...state, dir: 'items', v: 1, item: id, full: 'item', jump: state.jump + 1 }
    persist()
    emit()
  },
  setFull(full: ZoomState['full']): void {
    if (state.full === full) return
    state = { ...state, full }
    emit()
  }
}

// WHO holds the focus is an agent or an item of ONE machine. Where the view
// stands (dir, v) is the person's place in the app and stays.
registerScopeState('zoom focus', () => {
  if (state.agent === null && state.item === null && state.full === null) return
  state = { ...state, agent: null, item: null, full: null }
  emit()
})

export function useZoom(): ZoomState {
  return useSyncExternalStore(zoomStore.subscribe, zoomStore.get)
}

export function useZoomFull(): ZoomState['full'] {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().full, () => null)
}
