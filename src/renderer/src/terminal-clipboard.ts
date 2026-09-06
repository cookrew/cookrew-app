/**
 * Copy and paste for a terminal that cannot be selected or long-pressed.
 *
 * On the phone the zoomed terminal has neither of the desktop's clipboard
 * doors. Selection: xterm selects with mouse events, and the touch bridge
 * (TerminalOverlay) owns the finger for scrolling, so there is no drag to
 * select with. Paste: iOS shows its Paste callout only on a long-pressed
 * editable, and xterm's editable is a zero-size hidden textarea nobody can
 * long-press. So the overlay grows two buttons, and this is the logic behind
 * them — pure, so a test can see it.
 */

export interface ScreenLine {
  translateToString(trimRight: boolean): string
}

/** The slice of xterm's IBuffer this reads. */
export interface ScreenBuffer {
  /** First buffer row visible on screen. */
  viewportY: number
  length: number
  getLine(index: number): ScreenLine | undefined
}

/**
 * The text on screen right now: the visible rows, each trimmed on the right,
 * with trailing empty rows dropped. What the eye sees is what gets copied —
 * not the 600-line scrollback, which the paged transcript above already
 * carries with structure.
 */
export function screenText(buffer: ScreenBuffer, rows: number): string {
  const lines: string[] = []
  const end = Math.min(buffer.length, buffer.viewportY + rows)
  for (let i = buffer.viewportY; i < end; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop()
  return lines.join('\n')
}

export type PasteOutcome = 'pasted' | 'empty' | 'unavailable'

/**
 * Paste the system clipboard into the terminal, if the page may read it.
 *
 *   pasted       text went to the PTY
 *   empty        the clipboard could be read and held no text
 *   unavailable  the clipboard cannot be read here (plain-http LAN, or the
 *                user declined iOS's paste prompt) — the caller opens the
 *                paste field, whose `paste` EVENT carries the text without
 *                any clipboard permission at all
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
