// The stage's pinned card: what you opened or touched, held until Back.
// A store, not component state, so the app can pin from outside the stage —
// a card asked for by the command box or a toast lands here.
import { useSyncExternalStore } from 'react'
import type { StagePin } from './stage-pick'

let pin: StagePin | null = null
const listeners = new Set<() => void>()

export const stagePin = {
  get: (): StagePin | null => pin,
  set(next: StagePin | null): void {
    if (pin === next || (pin && next && pin.terminalId === next.terminalId && pin.item?.id === next.item?.id)) return
    pin = next
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

export const useStagePin = (): StagePin | null => useSyncExternalStore(stagePin.subscribe, stagePin.get, stagePin.get)
