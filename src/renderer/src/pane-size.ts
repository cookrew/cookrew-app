// WHO SETS A SHARED PANE'S SIZE (owner, 2026-10-31: "the same LIVE terminal
// open on the phone and the desktop jumps between the two widths, rendering
// over and over").
//
// One agent pane, one size, several viewers. Every resize makes herdr replay
// the whole screen to EVERY viewer and Claude Code reprint, and every viewer
// is told the new size (`resized` hello) and adopts it. The bounce was: the
// adopted size changed the viewer's box, its ResizeObserver refitted it to its
// OWN width and sent that — the other viewer adopted, refitted, sent back.
//
// The rule now: the viewer someone USED last owns the size; the others adopt
// and stay quiet. Using is a touch, a click, a key or a window resize in that
// viewer. A size the pane takes that this viewer did not ask for means
// somebody else is using it: this viewer gives the size up until its own next
// use. Nothing takes the size back on its own — no timer, no focus, no layout
// change — so two viewers cannot argue.

export const OWN_MS = 30_000

/**
 * How long after a resize a viewer waits before deciding the size the pane
 * settled on was another viewer's. Longer than a dip (main/pty.ts DIP_MS,
 * the repaint kick): the pane passes through a size one column narrower on
 * the way, and that is nobody else's.
 */
export const SETTLE_CHECK_MS = 1000

export interface PaneSize {
  cols: number
  rows: number
}

export interface SizeOwner {
  /** Someone used this viewer just now. */
  use: (now: number) => void
  /** The pane took another viewer's size: give it up until the next use. */
  yieldTo: () => void
  /** May this viewer set the pane's size now? */
  owns: (now: number, visible: boolean) => boolean
}

export function createSizeOwner(openedAt: number): SizeOwner {
  // Opening a terminal is using it.
  let usedAt = openedAt
  return {
    use: (now) => {
      usedAt = now
    },
    yieldTo: () => {
      usedAt = Number.NEGATIVE_INFINITY
    },
    owns: (now, visible) => visible && now - usedAt < OWN_MS
  }
}

const same = (a: PaneSize | null, b: PaneSize | null): boolean => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows

/**
 * After the pane settles on a size, was it someone else's? The pane passes
 * through sizes of our own (a repaint kick and a widen's dip pass cols-1), so the check
 * is on where it ends, against the last size this viewer asked for.
 */
export function tookOthers(settled: PaneSize, mine: PaneSize | null): boolean {
  return !same(settled, mine)
}
