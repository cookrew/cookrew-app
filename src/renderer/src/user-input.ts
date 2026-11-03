// WHEN SOMEONE LAST TOUCHED THIS WINDOW: a click, a tap or a key, anywhere in
// it. A terminal that mounts right after one was opened by someone; one that
// mounts with nobody here was opened by the app (the stage following what
// needs you) and must not take a shared pane's size from the phone in a
// hand (pane-size.ts · openedAt).

let lastAt = Number.NEGATIVE_INFINITY
let installed = false

const note = (): void => {
  lastAt = Date.now()
}

/**
 * Start listening. Called at app start (main.tsx): installed only when the
 * first terminal asked, the click that opened that terminal was already
 * over, and the first terminal opened after a load never took the size.
 */
export function watchUserInput(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  for (const type of ['pointerdown', 'touchstart', 'keydown'] as const) {
    window.addEventListener(type, note, { capture: true, passive: true })
  }
}

/** The time of the last click, tap or key in this window; -Infinity before any. */
export function lastUserInputAt(): number {
  watchUserInput()
  return lastAt
}
