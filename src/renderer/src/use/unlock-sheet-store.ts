/** Whether the unlock sheet is up. A store, because the panels that open it come and go. */

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

export function subscribeUnlockSheet(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
