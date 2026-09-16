/**
 * How a phone reaches the terminal's clipboard.
 *
 * There is no native door. iOS shows its Paste callout only on a long-pressed
 * EDITABLE, and xterm's editable is a hidden zero-size textarea nobody can
 * long-press; the visible rows are painted cells. So the phone gets one
 * deliberate way in: the PASTE key in the dock's control row, beside the
 * arrows (the owner's placement, 2026-09-09).
 *
 * A long press on the pane itself was tried and dropped by the owner. Two
 * findings from it are worth keeping, because the next gesture over that pane
 * will meet both:
 *
 *   - TOUCH events lose their release there. `touchstart` arrives and
 *     `touchend` never does: a touch event keeps the node it started on even
 *     after that node leaves the document, and xterm's DOM renderer replaces
 *     its rows on every repaint. Pointer events retarget to the nearest
 *     connected ancestor; use those.
 *   - A clipboard read must run in the handler of the gesture that asked for
 *     it. iOS grants `readText()` only inside a real user activation, and a
 *     hold timer's callback has already lost it.
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
