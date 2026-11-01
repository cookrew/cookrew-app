// THE FULL VIEW'S PLACE ON THE BAR (owner, 2026-11-02, phone).
//
// In an agent's full view on a phone the bar names the agent — its face, its
// name, its state — and the head under it keeps only its tools. The bar does
// not know the agent's face or state; the full view (stage/StageView.tsx)
// does, so it draws them into this slot with a portal, as the card draws its
// tools into the head's (head-tools.ts). CSS decides where it shows: the slot
// at phone width, the head's own name above it.

import { useSyncExternalStore } from 'react'

let slot: HTMLElement | null = null
const listeners = new Set<() => void>()

/** Ref callback for the bar's slot. */
export function setFullRouteSlot(el: HTMLElement | null): void {
  if (el === slot) return
  slot = el
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFullRouteSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null)
}
