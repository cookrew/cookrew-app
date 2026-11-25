import { hasNativeWebview } from '../api'
import type { GuestEntry } from '../../../shared/machine-guest'
import { remotePlace, type RemoteMachineRef } from './remote-machine-store'

/**
 * INTO ANOTHER MACHINE OF THE ACCOUNT, from wherever this view runs (owner
 * 2026-11-25: that machine drawn as the console draws it).
 *
 *   the desktop   its own app in a guest of this window (MachineGuestView.tsx)
 *   the console   the console's own address for it: the page IS that view, so
 *                 it goes there (console/ConsoleMachine.tsx says how)
 *   elsewhere     nowhere (a phone's page of one machine reaches no other)
 *
 * One way in for the devices stop, the pick card and the bar's faces.
 */

export interface MachineTarget {
  readonly machine: RemoteMachineRef
  readonly entry: Partial<GuestEntry>
}

let opener: ((target: MachineTarget) => void) | null = null

/** The console's way to another machine; null lets go of it. */
export function setMachineOpener(next: ((target: MachineTarget) => void) | null): void {
  opener = next
}

/** Go into that machine where `entry` asks. False when this view has no way there. */
export function openMachine(target: MachineTarget, nativeWebview = hasNativeWebview()): boolean {
  if (nativeWebview) {
    remotePlace.enter(target.machine, target.entry)
    return true
  }
  if (opener === null) return false
  opener(target)
  return true
}
