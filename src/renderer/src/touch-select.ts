/**
 * PRESS AND HOLD TO SELECT, on a phone.
 *
 * A phone drives a browser card with touch, and a headless Chrome turns no
 * synthetic touch into a text selection — a long press, a long press and a
 * drag, both select nothing (measured 2026-11-04). A mouse drag does select,
 * in phone mode too. So a finger that stays still for LONG_PRESS_MS stops
 * being a touch: the touch is cancelled (no tap, no link opened) and the
 * same finger becomes a mouse that pressed twice — the word under it is
 * selected, the way a phone's own long press does — and dragging extends the
 * selection until the finger lifts. Then Copy has something to copy.
 *
 * Pure — unit-tested.
 */

/** A little under Chrome's own 500 ms long press, so the page never sees one. */
export const LONG_PRESS_MS = 450
/** A finger that moved more than this (view px) is scrolling, not holding. */
export const HOLD_SLOP_PX = 8

export interface HoldStart {
  pointerId: number
  clientX: number
  clientY: number
}

/** Still holding: the same finger, hardly moved. */
export function stillHolding(start: HoldStart | null, pointerId: number, clientX: number, clientY: number): boolean {
  return (
    start !== null &&
    start.pointerId === pointerId &&
    Math.hypot(clientX - start.clientX, clientY - start.clientY) <= HOLD_SLOP_PX
  )
}
