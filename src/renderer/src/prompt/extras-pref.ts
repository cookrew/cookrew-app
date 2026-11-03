/**
 * THE BOX'S TOOLS, SHOWN OR FOLDED (owner, 2026-11-03): attach, the
 * spoken-replies toggle and, with an agent in the box, its keys (arrows,
 * paste, Esc) sit behind one ^ that shows or hides them all. The pick sticks. Until one is made a
 * desktop shows them (they were always there) and a phone's width folds them:
 * there they take a row of their own, and the phone's height is the scarce thing.
 */

const KEY = 'cookrew.prompt-extras'

/** The width the phone's box is laid out under (global-prompt.css). */
const PHONE_WIDTH = '(max-width: 700px)'

/**
 * The phone's layout: its width alone (2026-11-04). A narrow window draws the
 * phone's box too (global-prompt.css), where shown tools stand as a tray over
 * the zoom bar's stops; the companion in a wide browser draws the wide box.
 */
function phoneLayout(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_WIDTH).matches
  } catch {
    return false
  }
}

export function extrasShown(): boolean {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    // private mode: no memory, the default stands
  }
  if (saved === '1') return true
  if (saved === '0') return false
  return !phoneLayout()
}

export function rememberExtras(shown: boolean): void {
  try {
    localStorage.setItem(KEY, shown ? '1' : '0')
  } catch {
    // private mode: not remembered
  }
}

/**
 * Whether the tools show: a tap on the ^ while the agent waits stands until
 * the waiting ends (pick); else the saved pick, or the agent waiting on you,
 * which opens them by itself (its keys are for answering it).
 */
export function toolsOpen(pick: boolean | null, saved: boolean, waitingOnYou: boolean): boolean {
  return pick ?? (saved || waitingOnYou)
}
