import { cookrew } from '../api'
import { deviceSeat } from '../device-seat'
import type { ZoomSyncDeps } from './zoom-sync'

/**
 * Which of the machine in scope's workspaces the view is on, as the machine
 * says it: this device's seat there, else the one it has in front. The
 * console's machine view and the desktop's guest (guest/GuestMachine.tsx) both
 * keep their place by it (zoom-sync.ts).
 */
export function workspaceWatch(): ZoomSyncDeps['workspace'] & { start(): () => void } {
  let current: string | null = deviceSeat()
  const listeners = new Set<() => void>()
  const take = (list: { activeId?: string; seat?: string } | null | undefined): void => {
    const next = deviceSeat() ?? list?.seat ?? list?.activeId ?? null
    if (next === current || next === null || next === '') return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start: () => {
      const api = cookrew()
      const off = api.onWorkspaceList(take)
      void api.listWorkspaces().then(take, () => undefined)
      return off
    }
  }
}
