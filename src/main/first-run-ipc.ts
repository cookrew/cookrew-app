import type { IpcMain } from 'electron'
import { isFirstRunStage, type FirstRunStage, type FirstTask } from '../shared/first-run'
import { preflightRows, type PreflightRow, type ToolFacts } from '../shared/preflight'
import type { FirstRunStore } from './first-run-store'
import type { FirstTasks } from './first-task'

/**
 * The first run's three channels. Desktop only: the companion has no route to
 * them, and a phone is past the first run by the time it can reach this Mac.
 */

/** The channels, as a table so tests/ipc-channels.test.ts can read what is registered. */
export const FIRST_RUN_CHANNELS = ['first-run:read', 'first-run:advance', 'first-run:preflight', 'first-run:task', 'first-run:discard', 'first-run:can-start'] as const

export interface FirstRunIpcDeps {
  store: FirstRunStore
  probe: () => Promise<ToolFacts>
  tasks: Pick<FirstTasks, 'resume' | 'discard'>
  /** Why this preset cannot start an agent now, or null when it can. */
  blocked: (preset: string) => string | null
}

export function firstRunHandlers({ store, probe, tasks, blocked }: FirstRunIpcDeps): {
  read: () => FirstRunStage
  advance: (to: unknown) => FirstRunStage
  preflight: () => Promise<PreflightRow[]>
  task: () => FirstTask | null
  discard: () => void
  canStart: (preset: unknown) => string | null
} {
  return {
    read: () => store.read(),
    // It comes over the bridge: an unknown stage is no move, and answers where the run stands.
    advance: (to) => (isFirstRunStage(to) ? store.advance(to) : store.read()),
    preflight: async () => preflightRows(await probe()),
    // Asked once the window is up, so a restart's sessions are back by now.
    task: () => {
      tasks.resume()
      return store.task()
    },
    discard: () => tasks.discard(),
    canStart: (preset) => (typeof preset === 'string' ? blocked(preset) : null)
  }
}

export function registerFirstRunIpc(ipc: Pick<IpcMain, 'handle'>, deps: FirstRunIpcDeps): void {
  const handlers = firstRunHandlers(deps)
  const [read, advance, preflight, task, discard, canStart] = FIRST_RUN_CHANNELS
  ipc.handle(read, () => handlers.read())
  ipc.handle(advance, (_e, to: unknown) => handlers.advance(to))
  ipc.handle(preflight, () => handlers.preflight())
  ipc.handle(task, () => handlers.task())
  ipc.handle(discard, () => handlers.discard())
  ipc.handle(canStart, (_e, preset: unknown) => handlers.canStart(preset))
}
