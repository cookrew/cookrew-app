/**
 * A TAP, not a touch — what it takes to send a key from the phone's bar.
 *
 * The control keys fired on pointerdown, so the instant a thumb met the row
 * the key was already gone: no slide-off, no take-back. That row is at the
 * bottom edge where a hand rests, it SCROLLS sideways (nine keys on a narrow
 * phone), and scrolling it necessarily starts by touching a key — so reaching
 * for → could send ESC on the way. An accidental Escape leaves the menu the
 * agent was waiting on; an accidental Enter answers a dialog nobody read.
 *
 * So a press is judged by how it ENDS:
 *
 *   tap        down, little movement, up      → the key fires on release
 *   slide      down, moved past the slop      → nothing fires, ever
 *   hold       down, still, past the delay    → fires and begins repeating
 *
 * The hold path is why this is a gesture and not an onClick: paging a long
 * scrollback one tap per row is unusable, and a key that waits for release
 * before its first repeat feels stuck. Non-repeating keys (Escape) simply
 * never get a hold event, so they can only ever fire as a tap.
 *
 * Pure and unit-tested; the component owns the timers and the sending.
 */

/** Finger slop that still counts as standing still (CSS px). */
export const TAP_SLOP_PX = 10

export type KeyGestureState =
  | { kind: 'idle' }
  | { kind: 'pressing'; pointerId: number; x: number; y: number; fired: boolean }
  | { kind: 'sliding'; pointerId: number }

export type KeyGestureEvent =
  | { type: 'down'; pointerId: number; x: number; y: number }
  | { type: 'move'; pointerId: number; x: number; y: number }
  /** The hold timer elapsed with the finger still down and still still. */
  | { type: 'hold'; pointerId: number }
  | { type: 'up'; pointerId: number }
  /** Pointer cancelled, left the key, or the window lost focus. */
  | { type: 'cancel'; pointerId: number }

export interface KeyGestureResult {
  state: KeyGestureState
  /** Send the key's sequence once, now. */
  fire: boolean
  /** Begin the held-key repeat. */
  startRepeat: boolean
  /** Stop any repeat and clear pending timers. */
  stopRepeat: boolean
}

const IDLE: KeyGestureState = { kind: 'idle' }

function moved(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

export function keyGesture(
  state: KeyGestureState,
  event: KeyGestureEvent,
  slopPx = TAP_SLOP_PX
): KeyGestureResult {
  const still = (next: KeyGestureState): KeyGestureResult => ({
    state: next,
    fire: false,
    startRepeat: false,
    stopRepeat: false
  })

  /**
   * ONE finger owns the row, and it is the first one down.
   *
   * Without this the state is shared across every key: a second finger's
   * `down` overwrites the origin, and the first finger's slop is then measured
   * against the SECOND finger's touch point — so a 30px slide still counted
   * as a tap and sent its key. That is the reported bug, in exactly the
   * reported posture (a hand resting on the row while the thumb drags), and
   * it is why "a second finger on another key is not a chord" has to be
   * enforced rather than merely intended.
   */
  const owner = state.kind === 'idle' ? null : state.pointerId
  if (owner !== null && event.pointerId !== owner) {
    // A stranger's press is ignored outright rather than stealing the
    // gesture — including its `down`, which must not kill the owner's repeat.
    return still(state)
  }

  switch (event.type) {
    case 'down':
      // A fresh press always clears whatever the last one left running.
      return {
        state: { kind: 'pressing', pointerId: event.pointerId, x: event.x, y: event.y, fired: false },
        fire: false,
        startRepeat: false,
        stopRepeat: true
      }
    case 'move':
      if (state.kind !== 'pressing') return still(state)
      if (moved(state, event) <= slopPx) return still(state)
      // Past the slop this is a scroll, or a finger on its way elsewhere.
      // Whatever it becomes, this key is not sending anything.
      return {
        state: { kind: 'sliding', pointerId: state.pointerId },
        fire: false,
        startRepeat: false,
        stopRepeat: true
      }
    case 'hold':
      if (state.kind !== 'pressing' || state.fired) return still(state)
      return {
        state: { ...state, fired: true },
        fire: true,
        startRepeat: true,
        stopRepeat: false
      }
    case 'up':
      // The tap's keystroke lands HERE, which is what makes it takeable-back.
      // A press that already fired on hold does not fire again on release.
      return {
        state: IDLE,
        fire: state.kind === 'pressing' && !state.fired,
        startRepeat: false,
        stopRepeat: true
      }
    case 'cancel':
      return { state: IDLE, fire: false, startRepeat: false, stopRepeat: true }
  }
}
