/**
 * WHETHER THE AGENT'S ARTIFACTS SHOW (owner, 2026-11-03: "browsers and notes
 * can be hidden"). One switch for every agent's sheet (AgentArtifacts.tsx),
 * remembered across restarts: hidden is stored, shown is the default and
 * stores nothing. A plain store, no React in it; `useArtifactsShown`
 * subscribes.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'cookrew.fv.artifacts'

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== 'hidden'
  } catch {
    return true
  }
}

let shown = read()
const listeners = new Set<() => void>()

const persist = (next: boolean): void => {
  try {
    if (next) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'hidden')
  } catch {
    // private mode: the choice is just not remembered
  }
}

export const artifactsShown = {
  get: (): boolean => shown,
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  },
  toggle(): void {
    shown = !shown
    persist(shown)
    for (const cb of listeners) cb()
  }
}

export function useArtifactsShown(): boolean {
  return useSyncExternalStore(artifactsShown.subscribe, artifactsShown.get, artifactsShown.get)
}
