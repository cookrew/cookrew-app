import type { ScreenBox } from './remote-entry'
import { registerScopeState } from '../machine-scope'
import { useSyncExternalStore } from 'react'
import { GUEST_AT_WORKSPACES, guestEntry, type GuestCommand, type GuestEntry, type GuestLeave, type GuestReport } from '../../../shared/machine-guest'

/**
 * WHICH OF THE ACCOUNT'S OTHER MACHINES THIS WINDOW IS INSIDE (owner
 * 2026-11-25: drawn as the console draws it, its agents worked as this
 * machine's are). The machine is the guest's (MachineGuestView.tsx: that
 * machine's whole app in a <webview>); this holds only what the window itself
 * needs of it:
 *
 *   the machine and where it was opened (`entry`), which pick the guest's page
 *   the guest's own names for where it stands, for this window's title line
 *   the title line's steps, sent on to the guest
 *
 * Inside the guest the guest moves itself, and says when it is left.
 */

export interface RemoteMachineRef {
  readonly id: string
  readonly name: string
  readonly os: string | null
  /** Where its frame stood on the devices stop when it was entered: its view opens from there (remote-entry.ts). */
  readonly from?: ScreenBox
}

/** Where the guest stands, as its own title line names it. */
export interface GuestCrumbs {
  readonly workspace: string | null
  readonly agent: string | null
}

export interface RemotePlace {
  readonly machine: RemoteMachineRef | null
  readonly entry: GuestEntry
  /** Null until the guest has said. */
  readonly crumbs: GuestCrumbs | null
  /** Each entry is a visit of its own: the same machine entered again opens afresh where it was asked. */
  readonly visit: number
  /** Why the last visit ended, when the guest ended it for a reason the window says aloud; null otherwise. */
  readonly left: { readonly machine: string; readonly name: string; readonly why: Exclude<GuestLeave, 'devices'> } | null
}

const OUTSIDE: RemotePlace = { machine: null, entry: GUEST_AT_WORKSPACES, crumbs: null, visit: 0, left: null }

let place: RemotePlace = OUTSIDE
let visits = 0
const listeners = new Set<() => void>()
const commandListeners = new Set<(command: GuestCommand) => void>()

const set = (next: RemotePlace): void => {
  place = next
  for (const listener of listeners) listener()
}

export const remotePlace = {
  get: (): RemotePlace => place,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Into a machine, at its workspaces or wherever `entry` asks. */
  enter: (machine: RemoteMachineRef, entry: Partial<GuestEntry> = GUEST_AT_WORKSPACES): void => {
    visits += 1
    set({ machine, entry: guestEntry(entry), crumbs: null, visit: visits, left: null })
  },
  /** What the guest said (MachineGuestView.tsx hears it from its <webview>). */
  heard(report: GuestReport): void {
    if (!place.machine) return
    if (report.kind === 'route') {
      if (place.crumbs?.workspace === report.workspace && place.crumbs?.agent === report.agent) return
      set({ ...place, crumbs: { workspace: report.workspace, agent: report.agent } })
      return
    }
    const { id, name } = place.machine
    set({ ...OUTSIDE, left: report.why === 'devices' ? null : { machine: id, name, why: report.why } })
  },
  /** One of the title line's steps, or Esc from outside the guest: on to the guest, which moves itself. */
  command(command: GuestCommand): void {
    if (!place.machine) return
    for (const listener of commandListeners) listener(command)
  },
  onCommand(listener: (command: GuestCommand) => void): () => void {
    commandListeners.add(listener)
    return () => commandListeners.delete(listener)
  },
  /** Out of the machine, back to this window's own stops. */
  leave: (): void => {
    if (place.machine !== null || place.left !== null) set(OUTSIDE)
  },
  /** The sentence about the last visit has been seen. */
  dismiss: (): void => {
    if (place.left !== null) set({ ...place, left: null })
  }
}

// "Inside another machine" was said from the machine in scope: from the next
// one it may be the very machine it stands on. The words typed for a machine
// are kept by that machine's own id and stay.
registerScopeState('inside another machine', () => remotePlace.leave())

const drafts = new Map<string, string>()
const draftKeyOf = (machineId: string, box: string): string => `${machineId}\u0000${box}`

/** The words kept for an agent's quick-reply box on another machine (RemotePickCard.tsx). */
export const remoteDraft = (machineId: string, box: string): string => drafts.get(draftKeyOf(machineId, box)) ?? ''

export function setRemoteDraft(machineId: string, box: string, words: string): void {
  if (words === '') drafts.delete(draftKeyOf(machineId, box))
  else drafts.set(draftKeyOf(machineId, box), words)
}

const inside = (): boolean => place.machine !== null

/** Is this window inside another machine now. */
export const useInsideMachine = (): boolean => useSyncExternalStore(remotePlace.subscribe, inside, inside)
