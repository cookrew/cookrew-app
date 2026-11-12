import type { ScreenBox } from './remote-entry'
import type { RemoteCard } from './remote-machine'
import { registerScopeState } from '../machine-scope'
import { useSyncExternalStore } from 'react'

/**
 * WHERE THE ZOOM VIEW STANDS INSIDE ANOTHER MACHINE (owner 2026-11-10, design
 * B): the machine, then one of its workspaces, one of its agents, one of that
 * agent's items. Esc, the bar's back and a phone's back step out of these
 * first (ZoomView · stepBack), one stop a press, before the zoom's own stops.
 *
 * Words typed for the other machine are kept here, by machine and agent, so a
 * machine that stops answering, or a step out and back in, loses none of them.
 */

export interface RemoteMachineRef {
  readonly id: string
  readonly name: string
  readonly os: string | null
  /** Where its frame stood on the devices stop when it was entered: its view opens from there (remote-entry.ts). */
  readonly from?: ScreenBox
}

export interface RemoteItemRef {
  readonly id: string
  readonly title: string
  readonly kind: 'browser' | 'note'
}

export interface RemotePlace {
  readonly machine: RemoteMachineRef | null
  readonly workspace: { readonly id: string; readonly name: string } | null
  readonly agent: { readonly id: string; readonly name: string } | null
  readonly item: RemoteItemRef | null
  /** In a workspace: its agents, or its artifacts (the bar's two sides, as on this machine). */
  readonly side: RemoteSide
}

export type RemoteSide = 'agents' | 'items'

const OUTSIDE: RemotePlace = { machine: null, workspace: null, agent: null, item: null, side: 'agents' }

/** The workspace in front on that machine, as it last said: where AGENTS and ARTIFACTS go from its workspaces. */
let front: { readonly id: string; readonly name: string } | null = null

let place: RemotePlace = OUTSIDE
const listeners = new Set<() => void>()

const set = (next: RemotePlace): void => {
  place = next
  for (const listener of listeners) listener()
}

/** The place at a depth: 0 outside, 1 the machine, 2 a workspace, 3 an agent, 4 an item. */
const cut = (at: RemotePlace, depth: number): RemotePlace => ({
  machine: depth >= 1 ? at.machine : null,
  workspace: depth >= 2 ? at.workspace : null,
  agent: depth >= 3 ? at.agent : null,
  item: depth >= 4 ? at.item : null,
  side: depth >= 2 ? at.side : 'agents'
})

const depthOf = (at: RemotePlace): number => (at.item ? 4 : at.agent ? 3 : at.workspace ? 2 : at.machine ? 1 : 0)

export const remotePlace = {
  get: (): RemotePlace => place,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  enter: (machine: RemoteMachineRef): void => {
    front = null
    // Another machine's cards are not this one's: the box waits for its own read.
    remoteSeen.forget()
    set({ ...OUTSIDE, machine })
  },
  workspace: (workspace: { id: string; name: string }): void => {
    if (place.machine) set({ ...cut(place, 1), workspace, side: 'agents' })
  },
  /** The bar's AGENTS or ARTIFACTS: of the workspace stood in, else of the one in front there. */
  side: (side: RemoteSide): void => {
    if (place.workspace) set({ ...cut(place, 2), side })
    else if (place.machine && front) set({ ...cut(place, 1), workspace: front, side })
  },
  /** Which workspace is in front on that machine: said by its own tiles (RemoteMachineView.tsx). */
  noteFront: (workspace: { id: string; name: string } | null): void => {
    front = workspace
  },
  agent: (agent: { id: string; name: string }): void => {
    if (place.workspace) set({ ...cut(place, 2), agent })
  },
  item: (item: RemoteItemRef): void => {
    if (place.agent) set({ ...cut(place, 3), item })
  },
  /** Back to a crumb's depth. */
  backTo: (depth: number): void => {
    if (depth < depthOf(place)) set(cut(place, Math.max(0, depth)))
  },
  /** One stop out; false outside every machine, where the zoom's own stops are. */
  stepOut(): boolean {
    const depth = depthOf(place)
    if (depth === 0) return false
    set(cut(place, depth - 1))
    return true
  },
  leave: (): void => {
    front = null
    remoteSeen.forget()
    if (place !== OUTSIDE) set(OUTSIDE)
  }
}

/** The bar's stop inside another machine; null outside every machine, where the zoom's own stops are. */
export function remoteStop(at: RemotePlace): 'workspaces' | RemoteSide | null {
  if (!at.machine) return null
  if (!at.workspace) return 'workspaces'
  // An agent's card is the agents' side; an artifact keeps the side it was opened from.
  return at.agent && !at.item ? 'agents' : at.side
}

// "Inside another machine" was said from the machine in scope: from the next
// one it may be the very machine it stands on. The words typed for a machine
// are kept by that machine's own id and stay.
registerScopeState('inside another machine', () => remotePlace.leave())

const drafts = new Map<string, string>()
const draftKeyOf = (machineId: string, box: string): string => `${machineId}\u0000${box}`

/** The words kept for a box on another machine: an agent's id, or `new:<workspace>` for a new agent. */
export const remoteDraft = (machineId: string, box: string): string => drafts.get(draftKeyOf(machineId, box)) ?? ''

export function setRemoteDraft(machineId: string, box: string, words: string): void {
  if (words === '') drafts.delete(draftKeyOf(machineId, box))
  else drafts.set(draftKeyOf(machineId, box), words)
}

/**
 * WHAT THE STAGE LAST READ THERE (RemoteMachineView.tsx · useRemoteCards), for
 * the bar's box (RemotePrompt.tsx): the cards on show, how to read them again
 * after a send, and the workspace in front. The box reads nothing of its own:
 * one read a stop, not two.
 */
export interface RemoteSeen {
  readonly cards: readonly RemoteCard[] | null
  readonly front: { readonly id: string; readonly name: string } | null
  readonly refresh: () => void
}

const NOTHING_SEEN: RemoteSeen = { cards: null, front: null, refresh: () => undefined }
let seen: RemoteSeen = NOTHING_SEEN
const seenListeners = new Set<() => void>()

export const remoteSeen = {
  get: (): RemoteSeen => seen,
  subscribe(listener: () => void): () => void {
    seenListeners.add(listener)
    return () => seenListeners.delete(listener)
  },
  note(next: RemoteSeen): void {
    if (next.cards === seen.cards && next.front?.id === seen.front?.id && next.front?.name === seen.front?.name && next.refresh === seen.refresh) return
    seen = next
    for (const listener of seenListeners) listener()
  },
  forget: (): void => remoteSeen.note(NOTHING_SEEN)
}

export const useRemoteSeen = (): RemoteSeen => useSyncExternalStore(remoteSeen.subscribe, remoteSeen.get, remoteSeen.get)

const inside = (): boolean => place.machine !== null

/** Is the zoom view inside another machine now. */
export const useInsideMachine = (): boolean => useSyncExternalStore(remotePlace.subscribe, inside, inside)
