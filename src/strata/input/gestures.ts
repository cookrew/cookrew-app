// SWIPE RECOGNISERS, pure and clock-injected. D8: swipe left goes in, swipe
// right goes out. One commit per gesture: a trackpad's inertia tail can never
// move two levels.

export type Swipe = 'in' | 'out'

export interface WheelSample {
  deltaX: number
  deltaY: number
  /** ms, any monotonic clock (Event.timeStamp). */
  at: number
}

/** lockMs: after a commit nothing fires again for this long, gap or not (a slow level render must not split one gesture). */
export const WHEEL = { threshold: 80, quietMs: 180, ratio: 1.5, lockMs: 400 } as const

export interface WheelSwipe {
  /** Feed every wheel event; returns a swipe once per gesture, and whether the event belongs to a horizontal gesture. */
  feed(sample: WheelSample): { swipe: Swipe | null; horizontal: boolean }
}

/**
 * Two-finger horizontal trackpad swipe. With natural scrolling, fingers moving
 * left produce deltaX > 0: that is "swipe left", in.
 */
export const createWheelSwipe = (opts: Partial<typeof WHEEL> = {}): WheelSwipe => {
  const { threshold, quietMs, ratio, lockMs } = { ...WHEEL, ...opts }
  let accX = 0
  let accY = 0
  let lastAt = -Infinity
  let fired = false
  let firedAt = -Infinity
  return {
    feed({ deltaX, deltaY, at }) {
      if (at - lastAt > quietMs && at - firedAt > lockMs) {
        accX = 0
        accY = 0
        fired = false
      }
      lastAt = at
      accX += deltaX
      accY += deltaY
      const horizontal = Math.abs(accX) >= ratio * Math.abs(accY) && Math.abs(accX) > 0
      if (fired || !horizontal || Math.abs(accX) < threshold) return { swipe: null, horizontal }
      fired = true
      firedAt = at
      return { swipe: accX > 0 ? 'in' : 'out', horizontal }
    }
  }
}

export const TOUCH = { distance: 56, velocity: 0.35, minDistance: 20, ratio: 1.5, edge: 24 } as const

export interface TouchStroke {
  startX: number
  startY: number
  endX: number
  endY: number
  /** ms between down and up. */
  duration: number
  viewportWidth: number
}

/** A finished touch stroke → a swipe, or null. Edge strokes belong to the OS (its back/forward is history, so still out/in). */
export const classifyTouch = (stroke: TouchStroke, opts: Partial<typeof TOUCH> = {}): Swipe | null => {
  const { distance, velocity, minDistance, ratio, edge } = { ...TOUCH, ...opts }
  if (stroke.startX < edge || stroke.startX > stroke.viewportWidth - edge) return null
  const dx = stroke.endX - stroke.startX
  const dy = stroke.endY - stroke.startY
  if (Math.abs(dx) < ratio * Math.abs(dy)) return null
  const fast = Math.abs(dx) >= minDistance && Math.abs(dx) / Math.max(1, stroke.duration) >= velocity
  if (Math.abs(dx) < distance && !fast) return null
  return dx < 0 ? 'in' : 'out'
}

/** Movement that cancels a press-and-hold (it is a swipe or a scrub instead). */
export const HOLD = { ms: 400, slop: 10 } as const

/** Strokes a level already acted on (a loupe scrub or tap): the stage must not also read them as a swipe. */
const consumed = new WeakSet<Event>()
export const markConsumed = (e: Event) => void consumed.add(e)
export const isConsumed = (e: Event) => consumed.has(e)
