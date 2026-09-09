/**
 * How a phone reaches the terminal's clipboard.
 *
 * There is no native door. iOS shows its Paste callout only on a long-pressed
 * EDITABLE, and xterm's editable is a hidden zero-size textarea nobody can
 * long-press; the visible rows are painted cells. So the phone gets two
 * deliberate ways in, both of which end in the same request:
 *
 *   - a long press on the live pane, where the agent's prompt line sits;
 *   - a paste key in the dock's control row, beside the arrows.
 *
 * WHY A PRESS IS JUDGED ON RELEASE. iOS grants a clipboard read only inside a
 * real user gesture, and a `setTimeout` callback is not one — the transient
 * activation is already gone by the time a hold timer fires, so a read from
 * there is refused outright. The hold timer therefore only ARMS the gesture
 * (the pane says so); the read happens on release, which is a gesture the OS
 * honours.
 *
 * WHY POINTER EVENTS AND NOT TOUCH EVENTS. Measured on the phone companion
 * (scratchpad/paste-qa): over a live pane, `touchstart` arrives and
 * `touchend` NEVER DOES. A touch event keeps the target it started on even
 * after that node leaves the document, and xterm's DOM renderer replaces the
 * row elements on every repaint — so the release is dispatched to a detached
 * <span> and propagates to nothing. Pointer events retarget to the nearest
 * connected ancestor, which is why the same press delivers `pointerup`
 * faithfully. `pointerType` also keeps this a touch-only gesture: a mouse
 * held still on a desktop terminal must never paste.
 */

export type PasteOutcome = 'pasted' | 'empty' | 'unavailable'

/**
 * Paste the system clipboard into the terminal, if the page may read it.
 *
 *   pasted       text went to the terminal
 *   empty        the clipboard could be read and held no text
 *   unavailable  the clipboard cannot be read here (plain-http LAN, or the
 *                owner dismissed iOS's paste prompt) — the caller opens the
 *                paste field, whose `paste` EVENT carries the text without
 *                any clipboard permission at all
 *
 * `read` is called synchronously so the caller's user activation still stands
 * when navigator.clipboard.readText() runs. Do not await anything before it.
 */
export async function pasteFromClipboard(
  read: () => Promise<string | null>,
  paste: (text: string) => void
): Promise<PasteOutcome> {
  const text = await read()
  if (text === null) return 'unavailable'
  if (text.length === 0) return 'empty'
  paste(text)
  return 'pasted'
}

/** Finger travel that still counts as standing still (CSS px). */
export const PRESS_SLOP_PX = 10

/**
 * How long the finger must stay put. The same 550ms as the canvas card's
 * long-press (App.tsx), so one hold duration means "menu" everywhere.
 */
export const PRESS_HOLD_MS = 550

export type PastePressState =
  | { kind: 'idle' }
  | { kind: 'holding'; x: number; y: number; armed: boolean }
  /** This touch can no longer become a paste, whatever it does next. */
  | { kind: 'refused' }

export type PastePressEvent =
  /** `primary` is the pointer-events sense: false means a second finger. */
  | { type: 'down'; x: number; y: number; primary: boolean }
  | { type: 'move'; x: number; y: number }
  /** The hold timer elapsed with the finger still down. */
  | { type: 'hold' }
  | { type: 'up' }
  | { type: 'cancel' }

export interface PastePressResult {
  state: PastePressState
  /** Show that the press has matured — the pane outlines itself. */
  arm: boolean
  /** Ask for the clipboard NOW, inside this gesture. */
  paste: boolean
  /** Take the outline back off. */
  disarm: boolean
}

/**
 * One touch on the live pane, reduced to what the overlay must do about it.
 * Pure, so the rules are readable without a device:
 *
 *   still, past the delay, then release  → paste
 *   moved past the slop                  → nothing (it was a scroll)
 *   released before the delay            → nothing (it was a tap; xterm's)
 *   a second finger, ever                → nothing (a pinch or a two-finger
 *                                          scroll is not a paste)
 */
export function pastePress(
  state: PastePressState,
  event: PastePressEvent,
  slopPx = PRESS_SLOP_PX
): PastePressResult {
  const armed = state.kind === 'holding' && state.armed
  const settle = (next: PastePressState): PastePressResult => ({
    state: next,
    arm: false,
    paste: false,
    disarm: false
  })
  const refuse = (): PastePressResult => ({
    state: { kind: 'refused' },
    arm: false,
    paste: false,
    disarm: armed
  })

  switch (event.type) {
    case 'down':
      // A press that begins with company is a scroll or a pinch. Note this
      // also fires when a SECOND finger joins a matured hold, which is why
      // it refuses rather than starting a fresh one.
      if (!event.primary) return refuse()
      return settle({ kind: 'holding', x: event.x, y: event.y, armed: false })
    case 'move': {
      if (state.kind !== 'holding') return settle(state)
      const travelled = Math.hypot(event.x - state.x, event.y - state.y)
      if (travelled <= slopPx) return settle(state)
      return refuse()
    }
    case 'hold':
      if (state.kind !== 'holding' || state.armed) return settle(state)
      return { state: { ...state, armed: true }, arm: true, paste: false, disarm: false }
    case 'up':
      // The read lands HERE, in the gesture the OS honours.
      return { state: { kind: 'idle' }, arm: false, paste: armed, disarm: armed }
    case 'cancel':
      return { state: { kind: 'idle' }, arm: false, paste: false, disarm: armed }
  }
}
