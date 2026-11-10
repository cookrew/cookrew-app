/**
 * THE PATH EACH MACHINE IS REACHED OVER, for its tile on the Devices level.
 *
 * Every machine is reached through the relay first. Inside a machine the page
 * looks for a nearer path by itself and moves onto it when the registry has
 * confirmed it (path/companion.ts); what that settled on is noted here, by
 * machine, and its tile says it. A machine that was never entered is read
 * through the relay, and its tile says that: RELAY is the truth about how the
 * page reaches it now, not a default.
 *
 * A path is a fact about now. Nothing of it is kept past the page.
 */
import type { DataPlane } from '../data-plane'

export type PathWord = 'LAN' | 'TAILNET' | 'RELAY'

export const pathWordOf = (plane: Pick<DataPlane, 'kind'>): PathWord => (plane.kind === 'lan' ? 'LAN' : plane.kind === 'tailnet' ? 'TAILNET' : 'RELAY')

export interface MachinePaths {
  of(machineId: string): PathWord
  note(machineId: string, plane: Pick<DataPlane, 'kind'>): void
  forget(): void
  subscribe(listener: () => void): () => void
  /** Changes with every change: a view keyed on it redraws. */
  version(): number
}

export function createMachinePaths(): MachinePaths {
  let seen: ReadonlyMap<string, PathWord> = new Map()
  let version = 0
  const listeners = new Set<() => void>()
  const set = (next: ReadonlyMap<string, PathWord>): void => {
    seen = next
    version += 1
    for (const listener of listeners) listener()
  }
  return {
    of: (machineId) => seen.get(machineId) ?? 'RELAY',
    note: (machineId, plane) => {
      const word = pathWordOf(plane)
      if ((seen.get(machineId) ?? 'RELAY') === word) return
      set(new Map(seen).set(machineId, word))
    },
    forget: () => {
      if (seen.size > 0) set(new Map())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    version: () => version
  }
}
