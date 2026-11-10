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
}

const OUTSIDE: RemotePlace = { machine: null, workspace: null, agent: null, item: null }

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
  item: depth >= 4 ? at.item : null
})

const depthOf = (at: RemotePlace): number => (at.item ? 4 : at.agent ? 3 : at.workspace ? 2 : at.machine ? 1 : 0)

export const remotePlace = {
  get: (): RemotePlace => place,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  enter: (machine: RemoteMachineRef): void => set({ ...OUTSIDE, machine }),
  workspace: (workspace: { id: string; name: string }): void => {
    if (place.machine) set({ ...cut(place, 1), workspace })
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
    if (place !== OUTSIDE) set(OUTSIDE)
  }
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

const inside = (): boolean => place.machine !== null

/** Is the zoom view inside another machine now. */
export const useInsideMachine = (): boolean => useSyncExternalStore(remotePlace.subscribe, inside, inside)
