import type { IpcMain } from 'electron'
import { isFirstRunStage, type FirstRunStage } from '../shared/first-run'
import { preflightRows, type PreflightRow, type ToolFacts } from '../shared/preflight'
import type { FirstRunStore } from './first-run-store'

/**
 * The first run's three channels. Desktop only: the companion has no route to
 * them, and a phone is past the first run by the time it can reach this Mac.
 */

/** The channels, as a table so tests/ipc-channels.test.ts can read what is registered. */
export const FIRST_RUN_CHANNELS = ['first-run:read', 'first-run:advance', 'first-run:preflight'] as const

export interface FirstRunIpcDeps {
  store: FirstRunStore
  probe: () => Promise<ToolFacts>
}

export function firstRunHandlers({ store, probe }: FirstRunIpcDeps): {
  read: () => FirstRunStage
  advance: (to: unknown) => FirstRunStage
  preflight: () => Promise<PreflightRow[]>
} {
  return {
    read: () => store.read(),
    // It comes over the bridge: an unknown stage is no move, and answers where the run stands.
    advance: (to) => (isFirstRunStage(to) ? store.advance(to) : store.read()),
    preflight: async () => preflightRows(await probe())
  }
}

export function registerFirstRunIpc(ipc: Pick<IpcMain, 'handle'>, deps: FirstRunIpcDeps): void {
  const handlers = firstRunHandlers(deps)
  const [read, advance, preflight] = FIRST_RUN_CHANNELS
  ipc.handle(read, () => handlers.read())
  ipc.handle(advance, (_e, to: unknown) => handlers.advance(to))
  ipc.handle(preflight, () => handlers.preflight())
}
