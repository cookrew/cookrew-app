/** Whether the unlock sheet is up. A store, because the panels that open it come and go. */

import { registerScopeState } from '../machine-scope'

type Listener = () => void

let done: (() => void) | null = null
let open = false
const listeners = new Set<Listener>()
const tell = (): void => listeners.forEach((listener) => listener())

export function openUnlockSheet(onDone: () => void): void {
  done = onDone
  open = true
  tell()
}

export function closeUnlockSheet(unlocked: boolean): void {
  const finish = done
  done = null
  open = false
  tell()
  if (unlocked) finish?.()
}

export const unlockSheetOpen = (): boolean => open

// The sheet unlocks ONE machine, and what it does when done is that machine's.
registerScopeState('unlock sheet', () => {
  if (open || done !== null) closeUnlockSheet(false)
})

export function subscribeUnlockSheet(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
