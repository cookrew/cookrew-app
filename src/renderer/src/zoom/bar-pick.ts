import { registerScopeState } from '../machine-scope'
import { useSyncExternalStore } from 'react'

/**
 * THE CARD A BAR GROUP OPENED (BarGroups.tsx), one at a time: an agent's or
 * an artifact's, standing above the bar. An agent's card SELECTS the agent:
 * the prompt box carries it (GlobalPrompt.tsx · viewed), so the box opens in
 * the bar's place and the agent's face flies to its chip FROM THE GROUP'S
 * FACE (face-flip.ts · flyFace), not from the folded ＋ face at the bar's end.
 * The tapped face's place is handed to that flight once, while fresh.
 */

export interface BarCard {
  readonly kind: 'agent' | 'item'
  readonly id: string
}

export interface FaceBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The flight takes the tapped face's place only this soon after the tap: a stale one would fly from nowhere. */
export const FROM_FRESH_MS = 1200

let card: BarCard | null = null
let from: { box: FaceBox; at: number } | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

// The open card is an agent or an item of ONE machine.
registerScopeState('bar card', () => barCard.close())

export const barCard = {
  get: (): BarCard | null => card,
  /** The agent the bar's card selected, if it is an agent's. */
  agent: (): string | null => (card?.kind === 'agent' ? card.id : null),
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  open(next: BarCard, face?: FaceBox, now = Date.now()): void {
    from = face ? { box: face, at: now } : null
    if (card?.kind === next.kind && card.id === next.id) return
    card = next
    emit()
  },
  close(): void {
    from = null
    if (card === null) return
    card = null
    emit()
  },
  /** The tapped face's place, once: the chip's face flies from it. */
  takeFrom(now = Date.now()): FaceBox | null {
    const taken = from && now - from.at <= FROM_FRESH_MS ? from.box : null
    from = null
    return taken
  }
}

export function useBarCard(): BarCard | null {
  return useSyncExternalStore(barCard.subscribe, barCard.get, () => null)
}

/** The agent a bar group's card selected: one id, so the box re-renders only when it changes. */
export function useBarAgent(): string | null {
  return useSyncExternalStore(barCard.subscribe, barCard.agent, () => null)
}
