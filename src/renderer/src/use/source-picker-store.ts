import { useSyncExternalStore } from 'react'

/**
 * WHO ASKED FOR THE PICKER. The sheet is mounted once (App.tsx) and asked for
 * from anywhere: the ＋ menu, a device's card, a card whose window closed.
 * `card` is set when the pick should re-point that card instead of making one.
 */

export interface SourceAsk {
  readonly card: string | null
}

let ask: SourceAsk | null = null
const listeners = new Set<() => void>()

const set = (next: SourceAsk | null): void => {
  ask = next
  for (const listener of listeners) listener()
}

export const openSourcePicker = (options: { card?: string } = {}): void => set({ card: options.card ?? null })
export const closeSourcePicker = (): void => set(null)
export const currentSourceAsk = (): SourceAsk | null => ask

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSourceAsk = (): SourceAsk | null => useSyncExternalStore(subscribe, currentSourceAsk, currentSourceAsk)
