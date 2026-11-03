// THE FACE'S PLACE ON THE ZOOM'S BAR (owner, 2026-11-04).
//
// The zoom view draws its bar (zoom/ZoomView.tsx · .zv-controls) and keeps a
// slot at its right end; the global prompt, which knows who the next words go
// to, draws its folded face into it with a portal (prompt-fold.ts), as the
// full view draws its name into the route's slot (route-slot.ts).

import { useSyncExternalStore } from 'react'

let slot: HTMLElement | null = null
const listeners = new Set<() => void>()

/** Ref callback for the bar's slot. */
export function setFaceSlot(el: HTMLElement | null): void {
  if (el === slot) return
  slot = el
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFaceSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null)
}
