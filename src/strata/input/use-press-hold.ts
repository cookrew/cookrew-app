// Press-and-hold on touch: fires after HOLD.ms unless the finger moves more
// than HOLD.slop (then it is a swipe or a scrub). The click that follows a hold
// is swallowed, so a hold never also dives.
import { useRef, type PointerEvent } from 'react'
import { HOLD } from './gestures'

export interface PressHold {
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  /** True once if the click being handled ended a hold. */
  consumeHold: () => boolean
}

export const usePressHold = (onHold: () => void): PressHold => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)
  const latest = useRef(onHold)
  latest.current = onHold

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }

  return {
    onPointerDown(e) {
      if (e.pointerType !== 'touch') return
      held.current = false
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        held.current = true
        timer.current = null
        latest.current()
      }, HOLD.ms)
    },
    onPointerMove(e) {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > HOLD.slop) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    consumeHold() {
      const was = held.current
      held.current = false
      return was
    }
  }
}
