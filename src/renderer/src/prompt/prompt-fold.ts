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

/**
 * AN AGENT SELECTED OPENS THE BOX (owner, 2026-11-04: "in any view, an agent
 * selected puts the prompt box on the bar at once"). With an agent in the box
 * (a card open, its full view, a pick, an item's latest user) the box is open
 * and takes the bar's place; folding is for nobody (a new agent's ＋ face).
 */
export function boxFold({ place, slot, pinned, open }: { place: FacePlace; slot: boolean; pinned: boolean; open: boolean }): {
  /** The box may fold here and now. */
  canFold: boolean
  folded: boolean
  /** The open box stands where the zoom's bar is: the bar steps aside. */
  overBar: boolean
} {
  const placed = place === 'corner' || (place === 'bar' && slot)
  const canFold = placed && !pinned
  const folded = canFold && !open
  return { canFold, folded, overBar: place === 'bar' && slot && !folded }
}

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
  /** The who-picker is open over the box (WhoPicker.tsx). */
  readonly picker: boolean
}

let state: FoldState = { open: false, foldable: false, picker: false }
const listeners = new Set<() => void>()

function emit(next: FoldState): void {
  if (next.open === state.open && next.foldable === state.foldable && next.picker === state.picker) return
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
  /** Folded, the picker goes with the box. */
  fold: (): void => emit({ ...state, open: false, picker: false }),
  /**
   * Where the box cannot fold (an agent in it, an agent's full view) it is
   * not left open behind: once it can fold again it starts folded, the bar
   * in view (an agent deselected folds the box).
   */
  setFoldable: (foldable: boolean): void => emit({ ...state, foldable, open: foldable && state.open }),
  setPicker: (picker: boolean): void => emit({ ...state, picker }),
  /**
   * The zoom's Esc asks here first: an open box that can
   * fold folds, and the view stays where it is.
   */
  foldFirst(): boolean {
    if (!state.open || !state.foldable) return false
    emit({ ...state, open: false, picker: false })
    return true
  },
  /** Esc and back ask here first (takeBack): the picker closes, else a box that can fold folds. */
  backFirst(): boolean {
    if (state.picker) {
      emit({ ...state, picker: false })
      return true
    }
    return promptFold.foldFirst()
  },
  /** The box would take the next Esc or back. */
  wantsBack: (): boolean => state.picker || (state.open && state.foldable)
}

/**
 * ONE ORDER FOR ESC AND BACK (design, "Esc · Android back"): the picker, then
 * the box, then the zoom one stop out. True when a step was taken; false at
 * the outermost stop with nothing open, where back leaves the page.
 */
export function takeBack(zoomOut: () => boolean): boolean {
  return promptFold.backFirst() || zoomOut()
}

export function usePromptOpen(): boolean {
  return useSyncExternalStore(promptFold.subscribe, () => state.open, () => false)
}

export function usePromptWho(): boolean {
  return useSyncExternalStore(promptFold.subscribe, () => state.picker, () => false)
}
