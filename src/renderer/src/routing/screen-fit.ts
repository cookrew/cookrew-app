/**
 * THE TYPE SIZE THAT SHOWS A WHOLE SCREEN. A viewer of the Setup pane follows the
 * PTY's size and never pushes its own back (SetupScreen.tsx), so a screen larger
 * than its box was cut: Claude's bypass warning, unreadable at the very moment a
 * person agrees to it (box round 3, N7). The screen's grid cannot change, so the
 * type does, as far as it can be read; past that the box scrolls.
 */

const SMALLEST = 6
/** xterm lays type out in whole cells, so half points are as fine as it is worth asking for. */
const STEP = 0.5

export interface FitInput {
  /** The drawn screen at `current`. */
  screen: { width: number; height: number }
  /** The room it has. */
  box: { width: number; height: number }
  current: number
  base: number
  /** Fit the height as well: a question must show all at once, and a shell only its last line. */
  whole: boolean
}

export function fitFontSize({ screen, box, current, base, whole }: FitInput): number {
  if (screen.width <= 0 || screen.height <= 0 || box.width <= 0 || box.height <= 0) return current
  const scale = Math.min(box.width / screen.width, whole ? box.height / screen.height : Number.POSITIVE_INFINITY)
  const size = Math.floor((current * scale) / STEP) * STEP
  return Math.min(base, Math.max(SMALLEST, size))
}

/**
 * The size to draw at next, between changes of grid or box: it only ever comes down.
 * Rows are whole pixels, so size and height do not scale together, and a fit free to
 * grow again can flip between two sizes, each repaint asking for the other.
 */
export function shrunkFontSize(input: FitInput): number {
  return Math.min(input.current, fitFontSize(input))
}
