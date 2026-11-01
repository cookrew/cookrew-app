/**
 * AGENTS PER ROW, AS PICKED (owner, 2026-11-01). The pick is the owner's,
 * remembered on this device and per form factor: a desk's 5 is no phone's.
 * Unpicked, or a stored value that is not one of the choices, is null, and
 * the crew keeps its form factor's default (zoom-layout.ts · defaultCrewCols).
 */
import { useCallback, useSyncExternalStore } from 'react'
import { CREW_COLS } from './zoom-layout'

export const crewColsKey = (narrow: boolean): string => `cookrew.zoom.crewCols.${narrow ? 'phone' : 'desk'}`

/** A stored value as a pick: one of the form factor's choices, or null. */
export function crewColsOf(stored: string | null, narrow: boolean): number | null {
  const n = Number(stored)
  const choices: readonly number[] = narrow ? CREW_COLS.narrow : CREW_COLS.wide
  return stored !== null && choices.includes(n) ? n : null
}

const listeners = new Set<() => void>()

function read(narrow: boolean): number | null {
  try {
    return crewColsOf(window.localStorage.getItem(crewColsKey(narrow)), narrow)
  } catch {
    return null
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The pick for this form factor and its setter. */
export function useCrewCols(narrow: boolean): [number | null, (cols: number) => void] {
  const cols = useSyncExternalStore(subscribe, () => read(narrow), () => null)
  const set = useCallback(
    (next: number) => {
      try {
        window.localStorage.setItem(crewColsKey(narrow), String(next))
      } catch {
        // Storage refused (private mode): the pick lasts as long as nothing re-reads it.
      }
      for (const fn of listeners) fn()
    },
    [narrow]
  )
  return [cols, set]
}
