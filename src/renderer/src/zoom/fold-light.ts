import { useSyncExternalStore } from 'react'
import type { FoldLight } from './zoom-frame'

/**
 * HOW THE CREW IS LIT AT REST (⋯ → Agent light; zoom-frame.ts · FoldLight):
 * only the hovered agent's fold, every agent its own peak, or one terrain for
 * the crew. Kept on this device while the looks are compared (owner
 * 2026-11-12: "do both, so the real effect can be seen").
 */

const KEY = 'cookrew.fold-light'
export const FOLD_LIGHTS: readonly FoldLight[] = ['hover', 'every', 'terrain']
export const FOLD_LIGHT_NAMES: Readonly<Record<FoldLight, string>> = { hover: 'Hover only', every: 'Every agent', terrain: 'Terrain' }

const read = (): FoldLight => {
  try {
    const kept = globalThis.localStorage?.getItem(KEY)
    return (FOLD_LIGHTS as readonly string[]).includes(kept ?? '') ? (kept as FoldLight) : 'hover'
  } catch {
    return 'hover'
  }
}

let now: FoldLight = read()
const listeners = new Set<() => void>()

export const foldLight = (): FoldLight => now

export function setFoldLight(next: FoldLight): void {
  now = next
  try {
    globalThis.localStorage?.setItem(KEY, next)
  } catch {
    // Private mode: it holds for this page.
  }
  listeners.forEach((listener) => listener())
}

export const subscribeFoldLight = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useFoldLight = (): FoldLight => useSyncExternalStore(subscribeFoldLight, foldLight, foldLight)
