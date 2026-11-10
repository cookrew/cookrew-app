/**
 * ONE CALM MESSAGE AFTER A WORKSPACE IS MADE (box user test 2).
 *
 * Making a workspace set off three toasts (created, switched, Conductor created)
 * and none of them said what to do next. The device that asked for the workspace
 * holds that burst and says one thing instead. Only that device: another screen
 * hears the plain events, because it did not ask and is not standing there.
 */

import { registerScopeState } from './machine-scope'

/** Long enough to cover the burst of a slow create, short enough to forget it. */
const HOLD_MS = 4000

/** Everything a create sets off on its own. */
const BURST = new Set(['workspace.created', 'workspace.switched', 'terminal.created', 'terminal.recruited'])

export interface Announcement {
  title: string
  detail?: string
}

let holdingUntil = 0
const listeners = new Set<(said: Announcement) => void>()

// The burst being held is one machine's: entered within it, the next
// machine's own events would be swallowed. The listeners are the page's.
registerScopeState('workspace arrival', () => {
  holdingUntil = 0
})

/** This device is about to make a workspace. */
export function beginArrival(now = Date.now()): void {
  holdingUntil = now + HOLD_MS
}

/** The create was refused: nothing to hold. */
export function endArrival(): void {
  holdingUntil = 0
}

/** Is this event part of the burst this device is replacing with one message? */
export function heldForArrival(event: { type: string }, now = Date.now()): boolean {
  return now < holdingUntil && BURST.has(event.type)
}

/** The toast layer's side; returns its unsubscribe. */
export function onAnnounce(listener: (said: Announcement) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function announce(said: Announcement): void {
  for (const listener of [...listeners]) listener(said)
}
