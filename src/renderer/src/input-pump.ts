import { pinchMsg, wheelMsg, type CastInputMsg } from './browser-stream'

/**
 * ONE OF EACH PER FRAME.
 *
 * A trackpad fires wheel events at 120 Hz and a mouse fires moves faster than
 * the screen repaints; forwarded one by one they queue behind each other on
 * the way to Chrome (over the relay, behind each other's round trips), and the
 * page scrolls late and in stutters. So the continuous inputs are pumped:
 *
 *   move  — the newest wins (where the pointer IS is all that matters);
 *   wheel — deltas add up (no scroll distance is lost), the newest point wins;
 *   pinch — zoom factors multiply, the newest anchor wins.
 *
 * At most one of each leaves per animation frame. A press or a release
 * FLUSHES first, so a click never lands before the move that led to it.
 * Pure apart from the injected scheduler — unit-tested.
 */

export interface InputPump {
  move: (msg: CastInputMsg) => void
  wheel: (p: { x: number; y: number }, dx: number, dy: number, mods: number) => void
  pinch: (p: { x: number; y: number }, scale: number) => void
  /** Send whatever is pending now, in order: move, wheel, pinch. */
  flush: () => void
  /** Drop whatever is pending (input just turned off). */
  cancel: () => void
  /** The sender changes identity across renders; the pump keeps its queue. */
  retarget: (send: (msg: CastInputMsg) => void) => void
}

interface PendingWheel {
  x: number
  y: number
  dx: number
  dy: number
  mods: number
}

interface PendingPinch {
  x: number
  y: number
  scale: number
}

export function createInputPump(
  initialSend: (msg: CastInputMsg) => void,
  schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  unschedule: (handle: number) => void = (handle) => cancelAnimationFrame(handle)
): InputPump {
  let send = initialSend
  let move: CastInputMsg | null = null
  let wheel: PendingWheel | null = null
  let pinch: PendingPinch | null = null
  let handle: number | null = null

  const flush = (): void => {
    if (handle !== null) {
      unschedule(handle)
      handle = null
    }
    const pendingMove = move
    const pendingWheel = wheel
    const pendingPinch = pinch
    move = null
    wheel = null
    pinch = null
    if (pendingMove) send(pendingMove)
    if (pendingWheel && (pendingWheel.dx !== 0 || pendingWheel.dy !== 0)) {
      send(wheelMsg(pendingWheel, pendingWheel.dy, pendingWheel.dx, pendingWheel.mods))
    }
    if (pendingPinch && pendingPinch.scale !== 1) send(pinchMsg(pendingPinch, pendingPinch.scale))
  }

  const arm = (): void => {
    if (handle !== null) return
    handle = schedule(() => {
      handle = null
      flush()
    })
  }

  return {
    move: (msg) => {
      move = msg
      arm()
    },
    wheel: (p, dx, dy, mods) => {
      // A modifier change starts a new wheel: ⇧-scroll is not the plain one.
      if (wheel && wheel.mods !== mods) flush()
      wheel = wheel
        ? { x: p.x, y: p.y, dx: wheel.dx + dx, dy: wheel.dy + dy, mods }
        : { x: p.x, y: p.y, dx, dy, mods }
      arm()
    },
    pinch: (p, scale) => {
      if (!Number.isFinite(scale) || scale <= 0) return
      pinch = { x: p.x, y: p.y, scale: (pinch?.scale ?? 1) * scale }
      arm()
    },
    flush,
    cancel: () => {
      if (handle !== null) unschedule(handle)
      handle = null
      move = null
      wheel = null
      pinch = null
    },
    retarget: (next) => {
      send = next
    }
  }
}
