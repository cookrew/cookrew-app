/** Whether the set-up sheet is up (UnlockGrantSheet.tsx). A store, because what opens it comes and goes. */

import { registerScopeState } from '../machine-scope'

type Listener = () => void

let done: (() => void) | null = null
let open = false
const listeners = new Set<Listener>()
const tell = (): void => listeners.forEach((listener) => listener())

export function openUnlockGrantSheet(onDone?: () => void): void {
  done = onDone ?? null
  open = true
  tell()
}

export function closeUnlockGrantSheet(ready: boolean): void {
  const finish = done
  done = null
  open = false
  tell()
  if (ready) finish?.()
}

export const unlockGrantSheetOpen = (): boolean => open

// A set-up is with ONE machine: entering another ends it.
registerScopeState('unlock grant sheet', () => {
  if (open || done !== null) closeUnlockGrantSheet(false)
})

export function subscribeUnlockGrantSheet(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
