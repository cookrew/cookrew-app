import type { IpcMain } from 'electron'
import { isFirstRunStage, type FirstRunStage } from '../shared/first-run'
import { preflightRows, type PreflightRow, type ToolFacts } from '../shared/preflight'
import type { FirstRunStore } from './first-run-store'

/**
 * The first run's three channels. Desktop only: the companion has no route to
 * them, and a phone is past the first run by the time it can reach this Mac.
 */

export interface FirstRunIpcDeps {
  store: FirstRunStore
  probe: () => Promise<ToolFacts>
}

export function firstRunHandlers({ store, probe }: FirstRunIpcDeps): {
  read: (oldCardClosed: unknown) => FirstRunStage
  advance: (to: unknown) => FirstRunStage
  preflight: () => Promise<PreflightRow[]>
} {
  return {
    read: (oldCardClosed) => store.read(oldCardClosed === true),
    // Both come over the bridge: an unknown stage is no move, and answers where the run stands.
    advance: (to) => (isFirstRunStage(to) ? store.advance(to) : store.read(false)),
    preflight: async () => preflightRows(await probe())
  }
}

export function registerFirstRunIpc(ipc: Pick<IpcMain, 'handle'>, deps: FirstRunIpcDeps): void {
  const handlers = firstRunHandlers(deps)
  ipc.handle('first-run:read', (_e, oldCardClosed: unknown) => handlers.read(oldCardClosed))
  ipc.handle('first-run:advance', (_e, to: unknown) => handlers.advance(to))
  ipc.handle('first-run:preflight', () => handlers.preflight())
}
