/**
 * THE ZOOM'S STATE, shared: the view (ZoomView.tsx) draws it, the header's
 * route and the pets drive it, App reads whether a full view is showing. A
 * plain store, no React in it; `useZoom` subscribes.
 *
 *   dir, v       where the view is going (zoom-path.ts); the view chases v
 *   agent, item  who holds the focus: the open card / full view on each side
 *   full         set by the view once it has handed over to the real full view
 *   trail        where back from a full view goes: the page it was opened from (full-return.ts)
 */
import { registerScopeState, scopeNeedsMachine } from '../machine-scope'
import { useSyncExternalStore } from 'react'
import { clampTo, type ZoomDir } from './zoom-path'
import { backFrom, fullOf, placeKind, pruneTrail, pushReturn, sameFull, type KnownCard, type ZoomReturn, type ZoomSpot } from './full-return'
import { trackNav, type BackInput, type NavEvent } from '../nav-events'

export interface ZoomState {
  dir: ZoomDir
  v: number
  agent: string | null
  item: string | null
  /** The view stands at a full view and the stage below is showing it. */
  full: 'agent' | 'item' | null
  /** Bumped when a jump across is asked for: the view plays the crossfade, not the chase. */
  jump: number
  /** Where back from a full view goes, newest last (full-return.ts). */
  trail: readonly ZoomReturn[]
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

let state: ZoomState = { ...read(), agent: null, item: null, full: null, jump: 0, trail: [] }
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const cb of listeners) cb()
}
const spotOf = (s: Pick<ZoomState, 'dir' | 'v' | 'agent' | 'item'>): ZoomSpot => ({ dir: s.dir, v: s.v, agent: s.agent, item: s.item })

/**
 * The trail once the view's target moves from `before` to `after`: a full view
 * opened remembers where it was opened from; a full view left any way but back
 * (a stop, a crumb) leaves no way back into it.
 */
const trailOnMove = (before: ZoomState, after: ZoomSpot): { trail: readonly ZoomReturn[]; event: NavEvent | null } => {
  const from = spotOf(before)
  const was = fullOf(from)
  const to = fullOf(after)
  if (to !== null) {
    if (sameFull(was, to)) return { trail: before.trail, event: null }
    return { trail: pushReturn(before.trail, from, to), event: { name: 'full_open', kind: to.kind, from: placeKind(from) } }
  }
  const event: NavEvent | null = was !== null ? { name: 'full_leave', kind: was.kind, to: placeKind(after) } : null
  return { trail: before.trail.length === 0 ? before.trail : [], event }
}

/** The new state, told to its readers first and to the counts after (nav-events.ts): a listener sees where the view is. */
const commit = (next: ZoomState, event: NavEvent | null, remember: boolean): void => {
  state = next
  if (remember) persist()
  emit()
  if (event !== null) trackNav(event)
}

/** The full view the target stands on, read for the words on the way back: none once the target has left it. */
const fullHere = (): boolean => fullOf(spotOf(state)) !== null

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
    const moved = trailOnMove(state, { ...spotOf(state), dir, v: next })
    commit({ ...state, dir, v: next, trail: moved.trail }, moved.event, true)
  },
  // Another card in focus while its kind's full view is in view is another full
  // view opened from this one: back comes here (full-return.ts).
  focusAgent(id: string | null): void {
    if (state.agent === id) return
    const moved = trailOnMove(state, { ...spotOf(state), agent: id })
    commit({ ...state, agent: id, trail: moved.trail }, moved.event, false)
  },
  focusItem(id: string | null): void {
    if (state.item === id) return
    const moved = trailOnMove(state, { ...spotOf(state), item: id })
    commit({ ...state, item: id, trail: moved.trail }, moved.event, false)
  },
  /** Straight across to the other side's full view, or an agent's card (a crossfade, not a zoom). */
  jumpTo(kind: 'agent' | 'item' | 'card', id: string): void {
    const next: ZoomState = kind === 'agent'
      ? { ...state, dir: 'agents', v: 3, agent: id, full: 'agent', jump: state.jump + 1 }
      : kind === 'card'
        ? { ...state, dir: 'agents', v: 2, agent: id, full: null, jump: state.jump + 1 }
        : { ...state, dir: 'items', v: 1, item: id, full: 'item', jump: state.jump + 1 }
    const moved = trailOnMove(state, spotOf(next))
    commit({ ...next, trail: moved.trail }, moved.event, true)
  },
  /**
   * BACK (owner, 2026-11-17): from a full view, to the page it was opened from;
   * anywhere else, or with no such page, one stop out. False at the outermost
   * stop, where there is nowhere further. `by` is what asked, for the counts.
   */
  back(by: BackInput): boolean {
    const here = spotOf(state)
    const step = backFrom(state.trail, here)
    if (step === null) return false
    const full = fullOf(here)
    const event: NavEvent | null = full !== null ? { name: 'full_back', kind: full.kind, to: placeKind(step.to), by, previous: step.previous } : null
    const to = step.to
    // Out at the workspaces and the devices the two sides draw the same: the zoom walks out on its own.
    const dir = to.v <= -1 ? state.dir : to.dir
    // The focus comes back only where it is drawn: the crew's and the device's own are the one just left.
    const agent = dir === 'agents' && to.v >= 1.5 && to.agent !== null ? to.agent : state.agent
    const item = dir === 'items' && to.v >= 0.5 && to.item !== null ? to.item : state.item
    // Across to the other side, or to another card than the one in view: the crossfade, not the chase.
    const across = dir !== state.dir || agent !== state.agent || item !== state.item
    const landing = fullOf({ dir, v: to.v, agent, item })
    const next: ZoomState = across
      ? { ...state, dir, v: to.v, agent, item, full: landing?.kind ?? null, jump: state.jump + 1, trail: step.trail }
      : { ...state, dir, v: to.v, trail: step.trail }
    commit(next, event, true)
    return true
  },
  /** Would back do anything here (a phone's back is held for it: prompt/back-guard.ts)? */
  canBack: (): boolean => backFrom(state.trail, spotOf(state)) !== null,
  /**
   * Where back from the full view in view goes, for the words on its button;
   * null off a full view (on the way out of one too, so the words never name the stop beyond).
   */
  backTarget: (): ZoomSpot | null => (fullHere() ? (backFrom(state.trail, spotOf(state))?.to ?? null) : null),
  /** Take the cards that are gone out of the trail (full-return.ts · pruneTrail). */
  prune(known: KnownCard): void {
    const trail = pruneTrail(state.trail, known)
    if (trail === state.trail) return
    state = { ...state, trail }
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
  if (state.agent === null && state.item === null && state.full === null && state.trail.length === 0) return
  state = { ...state, agent: null, item: null, full: null, trail: [] }
  emit()
})

export function useZoom(): ZoomState {
  return useSyncExternalStore(zoomStore.subscribe, zoomStore.get)
}

export function useZoomFull(): ZoomState['full'] {
  return useSyncExternalStore(zoomStore.subscribe, () => zoomStore.get().full, () => null)
}
