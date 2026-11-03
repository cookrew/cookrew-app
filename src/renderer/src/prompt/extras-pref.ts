/**
 * THE BOX'S EXTRA TOOLS, SHOWN OR FOLDED (owner, 2026-11-03): attach and the
 * spoken-replies toggle sit in the prompt box for an agent AND for a new one,
 * behind a ^ that shows or hides them. The pick sticks. Until one is made a
 * desktop shows them (they were always there) and a phone folds them: there
 * they take a row of their own, and the phone's height is the scarce thing.
 */

const KEY = 'cookrew.prompt-extras'

/** The width the phone's box is laid out under (global-prompt.css). */
const PHONE_WIDTH = '(max-width: 700px)'

/**
 * The phone's layout: its width AND the companion (a narrow desktop window is
 * no phone). The companion's boot script sets COOKREW_MOBILE at once; its body
 * class waits for DOMContentLoaded, which the first render may beat.
 */
function phoneLayout(): boolean {
  try {
    const flagged = typeof window !== 'undefined' && Boolean((window as { COOKREW_MOBILE?: unknown }).COOKREW_MOBILE)
    const mobile = flagged || (globalThis.document?.body?.classList?.contains('cookrew-mobile') ?? false)
    return mobile && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_WIDTH).matches
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
