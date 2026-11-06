import { useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { advancedStage, pastTask, type FirstRunStage, type FirstTask } from '../../../shared/first-run'

/**
 * WHERE THE FIRST RUN STANDS, for the screens. Main owns the stage; this is
 * the renderer's copy, read once when the first view subscribes.
 *
 * Null until main answers, so nothing is drawn on a guess. No bridge, or no
 * answer, reads as closed: the phone and the plain demo have no first run,
 * and a welcome shown to an existing person is the failure that must not
 * happen. A move shows at once and is told to main after; a disk that refuses
 * it costs this much: the screen comes back at the next launch.
 */

export interface FirstRunBridge {
  firstRunRead?: () => Promise<FirstRunStage>
  firstRunAdvance?: (to: FirstRunStage) => Promise<FirstRunStage>
  firstRunTask?: () => Promise<FirstTask | null>
  onFirstRun?: (cb: (view: { stage: FirstRunStage; task: FirstTask | null }) => void) => () => void
}

export interface FirstRun {
  get: () => FirstRunStage | null
  /** The first task while no agent has it. */
  task: () => FirstTask | null
  subscribe: (listener: () => void) => () => void
  advance: (to: FirstRunStage) => Promise<void>
}

export function createFirstRun(api: () => FirstRunBridge): FirstRun {
  let stage: FirstRunStage | null = null
  let task: FirstTask | null = null
  let asked = false
  const listeners = new Set<() => void>()
  const tell = (): void => {
    for (const listener of listeners) listener()
  }
  const show = (next: FirstRunStage): void => {
    if (next === stage) return
    stage = next
    tell()
  }
  const hold = (next: FirstTask | null): void => {
    task = next
    tell()
  }
  const load = async (): Promise<void> => {
    try {
      const bridge = api()
      bridge.onFirstRun?.((view) => {
        hold(view.task)
        show(view.stage)
      })
      const opening = (await bridge.firstRunRead?.()) ?? 'closed'
      if (opening !== 'closed') hold((await bridge.firstRunTask?.()) ?? null)
      show(opening)
    } catch {
      show('closed')
    }
  }
  return {
    get: () => stage,
    task: () => task,
    subscribe(listener) {
      listeners.add(listener)
      if (!asked) {
        asked = true
        void load()
      }
      return () => listeners.delete(listener)
    },
    async advance(to) {
      if (stage === null) return
      const next = advancedStage(stage, to)
      if (task?.state === 'sent' && pastTask(next)) task = null
      show(next)
      try {
        await api().firstRunAdvance?.(to)
      } catch {
        // Shown already; the next launch reads what the disk has.
      }
    }
  }
}

export const firstRun = createFirstRun(() => cookrew())

export function useFirstRunStage(): FirstRunStage | null {
  return useSyncExternalStore(firstRun.subscribe, firstRun.get, () => null)
}

export function useFirstTask(): FirstTask | null {
  return useSyncExternalStore(firstRun.subscribe, firstRun.task, () => null)
}
