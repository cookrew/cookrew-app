import { useSyncExternalStore } from 'react'

/**
 * THE BOX FOLDS INTO A FACE (owner, 2026-11-04: "keep the nav bar; at its
 * right end a send key that is the selected agent's avatar; a tap opens the
 * full input box"). Folded, the global prompt is one face at the end of the
 * zoom's bar (face-slot.ts), or alone in the corner where the bar stands at
 * the top (a browser's or a note's full view). Open, the box takes the bar's
 * place. An agent's full view keeps the box open: talking to it is the view.
 *
 * Opening: a tap on the face, or Enter while no field has the keys
 * (enter-opens.ts). Folding: Esc, or a press anywhere else (GlobalPrompt.tsx).
 * A fold keeps the words: they stay the agent's draft and
 * show as a dot on its face.
 */

/** Where the folded face stands for a view; 'none' where the box never folds. */
export type FacePlace = 'bar' | 'corner' | 'none'

export function facePlace(full: 'agent' | 'item' | null): FacePlace {
  if (full === 'agent') return 'none'
  return full === 'item' ? 'corner' : 'bar'
}

interface FoldState {
  /** The box is open (only meaningful where it can fold). */
  readonly open: boolean
  /** The box can fold here: its face has a place to stand. */
  readonly foldable: boolean
}

let state: FoldState = { open: false, foldable: false }
const listeners = new Set<() => void>()

function emit(next: FoldState): void {
  if (next.open === state.open && next.foldable === state.foldable) return
  state = next
  for (const listener of listeners) listener()
}

export const promptFold = {
  get: (): FoldState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  open: (): void => emit({ ...state, open: true }),
  fold: (): void => emit({ ...state, open: false }),
  setFoldable: (foldable: boolean): void => emit({ ...state, foldable }),
  /**
   * The zoom's Esc asks here first: an open box that can
   * fold folds, and the view stays where it is.
   */
  foldFirst(): boolean {
    if (!state.open || !state.foldable) return false
    emit({ ...state, open: false })
    return true
  }
}

export function usePromptOpen(): boolean {
  return useSyncExternalStore(promptFold.subscribe, () => state.open, () => false)
}
