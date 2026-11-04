import { useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { advancedStage, type FirstRunStage } from '../../../shared/first-run'

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
}

export interface FirstRun {
  get: () => FirstRunStage | null
  subscribe: (listener: () => void) => () => void
  advance: (to: FirstRunStage) => Promise<void>
}

export function createFirstRun(api: () => FirstRunBridge): FirstRun {
  let stage: FirstRunStage | null = null
  let asked = false
  const listeners = new Set<() => void>()
  const show = (next: FirstRunStage): void => {
    if (next === stage) return
    stage = next
    for (const listener of listeners) listener()
  }
  const load = async (): Promise<void> => {
    try {
      show((await api().firstRunRead?.()) ?? 'closed')
    } catch {
      show('closed')
    }
  }
  return {
    get: () => stage,
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
      show(advancedStage(stage, to))
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
