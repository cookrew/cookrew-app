// RENAME BY HAND: THE RULES (owner, 2026-11-04). A double-click on a name
// turns it into a field (one tap on the phone's bar); Enter or blur saves, Esc
// cancels; an IME composing takes Enter and Esc for itself. Pure, so the
// rules are tested without a DOM; NameEdit.tsx wires them to the field.
import { cleanAgentName } from '../../../shared/agent-name'
import { EMPTY_NAME_ERROR } from '../../../shared/rename-plan'

/** Two clicks this close are a double-click: the first one's press waits this long. */
export const DOUBLE_MS = 300
/** How long a refusal said on a closed field stays, and how long a saved name waits for the card to wear it. */
export const SAY_MS = 4000
export const SHOW_MS = 8000

export interface KeyLike {
  key: string
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
}

/**
 * What a key in the field does. Never anything while an IME composes: its
 * Enter picks a character. Safari ends the composition before the keydown,
 * which then reads keyCode 229, so that counts as composing too.
 */
export function nameEditKey(e: KeyLike, composing: boolean): 'commit' | 'cancel' | null {
  if (composing || e.nativeEvent?.isComposing === true || e.keyCode === 229) return null
  if (e.key === 'Enter') return 'commit'
  if (e.key === 'Escape') return 'cancel'
  return null
}

export type CommitPlan = { kind: 'close' } | { kind: 'refuse'; error: string } | { kind: 'save'; name: string }

/**
 * What a save sends: the name cleaned as the main process cleans it
 * (shared/agent-name.ts), refused in its words when nothing is left, and no
 * save at all when it is the name the card already wears.
 */
export function planCommit(draft: string, current: string): CommitPlan {
  const name = cleanAgentName(draft)
  if (name === '') return { kind: 'refuse', error: EMPTY_NAME_ERROR }
  if (name === current) return { kind: 'close' }
  return { kind: 'save', name }
}

export interface NameEditState {
  editing: boolean
  draft: string
  saving: boolean
  /** The last refusal, said beside the name (open or closed). */
  error: string | null
  /** The saved name, shown until the card wears it. */
  shown: string | null
}

export const IDLE_EDIT: NameEditState = { editing: false, draft: '', saving: false, error: null, shown: null }

export type NameEditAction =
  | { type: 'start'; name: string }
  | { type: 'type'; draft: string }
  | { type: 'cancel' }
  | { type: 'saving' }
  | { type: 'saved'; name: string }
  | { type: 'refused'; error: string; keepOpen: boolean }
  | { type: 'settled' }
  /** The field now names another card: whatever it held was the last one's. */
  | { type: 'reset' }

export function nameEditReducer(state: NameEditState, action: NameEditAction): NameEditState {
  switch (action.type) {
    case 'start':
      return { ...IDLE_EDIT, editing: true, draft: action.name }
    case 'type':
      return { ...state, draft: action.draft, error: null }
    case 'cancel':
      // A save already sent cannot be called back: its answer closes the field.
      return state.saving ? state : IDLE_EDIT
    case 'reset':
      return IDLE_EDIT
    case 'saving':
      return { ...state, saving: true, error: null }
    case 'saved':
      return { ...IDLE_EDIT, shown: action.name }
    case 'refused':
      return action.keepOpen ? { ...state, saving: false, error: action.error } : { ...IDLE_EDIT, error: action.error }
    case 'settled':
      return state.editing ? state : IDLE_EDIT
  }
}

export interface ClickRoles {
  /** The name's own press (open the card, the full view); absent where it has none. */
  press?: () => void
  rename: () => void
  /** The phone's bar: one tap renames. */
  tap: boolean
}

/**
 * One click presses, a double-click renames. A click's `detail` counts the
 * clicks of a run (0 from the keyboard): the first one's press waits out the
 * double-click window, and a second click inside it renames instead. The OS's
 * own window can be longer than ours (macOS: about half a second): a second
 * click after the press still renames, and the press is not taken back.
 */
export function clickOrDouble(roles: () => ClickRoles, wait = DOUBLE_MS): { click: (detail: number) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const click = (detail: number): void => {
    const { press, rename, tap } = roles()
    if (tap) return rename()
    if (detail === 0) return press?.()
    if (detail === 1) {
      cancel()
      if (!press) return
      timer = setTimeout(() => {
        timer = null
        roles().press?.()
      }, wait)
      return
    }
    if (detail === 2) {
      cancel()
      rename()
    }
  }
  return { click, cancel }
}
