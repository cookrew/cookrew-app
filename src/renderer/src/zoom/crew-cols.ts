/**
 * HOW MANY TO A ROW, AS PICKED (owner, 2026-11-01): the crew's agents and the
 * device's workspaces, each its own pick. A pick is the owner's, remembered
 * on this device and per form factor: a desk's 5 is no phone's. Unpicked, or
 * a stored value that is not one of the choices, is null, and the view keeps
 * its form factor's default (zoom-layout.ts · defaultCrewCols, defaultDeviceCols).
 */
import { useCallback, useSyncExternalStore } from 'react'
import { CREW_COLS } from './zoom-layout'

/** The views that lay their things in rows the owner can pick. */
export type PerRowView = 'crew' | 'device'

export const perRowKey = (view: PerRowView, narrow: boolean): string => `cookrew.zoom.${view}Cols.${narrow ? 'phone' : 'desk'}`
export const crewColsKey = (narrow: boolean): string => perRowKey('crew', narrow)

/** A stored value as a pick: one of the form factor's choices (the same for every view), or null. */
export function crewColsOf(stored: string | null, narrow: boolean): number | null {
  const n = Number(stored)
  const choices: readonly number[] = narrow ? CREW_COLS.narrow : CREW_COLS.wide
  return stored !== null && choices.includes(n) ? n : null
}

const listeners = new Set<() => void>()

function read(view: PerRowView, narrow: boolean): number | null {
  try {
    return crewColsOf(window.localStorage.getItem(perRowKey(view, narrow)), narrow)
  } catch {
    return null
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** A view's pick for this form factor and its setter. */
export function usePerRow(view: PerRowView, narrow: boolean): [number | null, (cols: number) => void] {
  const cols = useSyncExternalStore(subscribe, () => read(view, narrow), () => null)
  const set = useCallback(
    (next: number) => {
      try {
        window.localStorage.setItem(perRowKey(view, narrow), String(next))
      } catch {
        // Storage refused (private mode): the pick lasts as long as nothing re-reads it.
      }
      for (const fn of listeners) fn()
    },
    [view, narrow]
  )
  return [cols, set]
}

export const useCrewCols = (narrow: boolean): [number | null, (cols: number) => void] => usePerRow('crew', narrow)
