import { cookrew } from './api'

/**
 * One IPC listener for the whole canvas, fanned out per terminal.
 *
 * Each card's useLatestCheckpoint wants to hear "your file changed", but wiring
 * one `ipcRenderer.on` per card means 40 listeners on a single channel — Node
 * warns past 10 and it reads as a leak. So this registers exactly ONE
 * `onLatestChanged` listener and dispatches to the callbacks registered for the
 * changed terminal. Cards subscribe/unsubscribe here; the underlying IPC
 * listener is created on first use and never multiplied.
 */
type Callback = () => void

const subscribers = new Map<string, Set<Callback>>()
let detach: (() => void) | null = null

function ensureListener(): void {
  if (detach) return
  const api = cookrew()
  detach =
    api.onLatestChanged?.((terminalId) => {
      const set = subscribers.get(terminalId)
      if (!set) return
      for (const cb of set) cb()
    }) ?? null
}

/** Is the host's file-watch push available at all (Electron, not phone)? */
export function hasLatestPush(): boolean {
  const api = cookrew()
  return !!(api.watchLatest && api.onLatestChanged)
}

/** Register `cb` for one terminal's change pushes; returns an unsubscribe. */
export function subscribeLatestChanged(terminalId: string, cb: Callback): () => void {
  ensureListener()
  let set = subscribers.get(terminalId)
  if (!set) {
    set = new Set()
    subscribers.set(terminalId, set)
  }
  set.add(cb)
  return () => {
    const live = subscribers.get(terminalId)
    if (!live) return
    live.delete(cb)
    if (live.size === 0) subscribers.delete(terminalId)
  }
}
