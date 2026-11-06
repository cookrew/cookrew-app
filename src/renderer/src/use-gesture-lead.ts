import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  LEAD_SLOP_PX,
  flingStep,
  flingVelocity,
  leadFrame,
  leadMoved,
  leadOffset,
  leadStalled,
  pinchLeadScale,
  startLead,
  viewPerCss,
  type FingerSample,
  type Lead
} from './scroll-lead'

/**
 * WHAT THE FINGERS DO TO THE PICTURE, ahead of the page (scroll-lead.ts).
 *
 * All of this writes one CSS transform on the canvas, outside React: a touch moves
 * sixty times a second and nothing here is state anyone renders. The touches still
 * go to the page exactly as before; this adds a preview, and, after a flick, the
 * momentum CDP's touch has none of, as wheels.
 */

export interface GestureLeadView {
  /** The drawn picture's width, in view pixels. */
  readonly fitWidth: number
  /** The page's own width, in frame pixels. */
  readonly deviceWidth: number
}

export interface GestureLead {
  down: (id: number, x: number, y: number) => void
  move: (id: number, x: number, y: number) => void
  up: (id: number) => void
  /** The touch became something else (a selection), or input turned off. */
  cancel: () => void
  painted: (scrollY: number | null, pageScale: number | null) => void
}

const SAMPLES = 8
const FADE = 0.7

export function useGestureLead(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
  view: () => GestureLeadView,
  /** The page, scrolled on by a flick: view pixels, down positive. */
  fling: (viewDelta: number) => void
): GestureLead {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const viewRef = useRef(view)
  viewRef.current = view
  const flingRef = useRef(fling)
  flingRef.current = fling
  const state = useRef({
    fingers: new Map<number, { x: number; y: number; startX: number; startY: number }>(),
    samples: [] as FingerSample[],
    lead: null as Lead | null,
    /** This gesture's lead gave up, or was never a vertical swipe. */
    off: false,
    pageScale: 1,
    scrollY: null as number | null,
    pinch: null as { startDistance: number; asked: number; startScale: number | null; originX: number; originY: number } | null,
    pinchAt: 0,
    velocity: 0,
    fade: 0,
    raf: 0,
    lastTick: 0
  })

  const write = useCallback((y: number, scale: number): void => {
    const el = canvas.current
    if (!el) return
    el.style.transform = y === 0 && scale === 1 ? '' : `translate3d(0, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`
  }, [canvas])

  const perCss = useCallback((): number => {
    const { fitWidth, deviceWidth } = viewRef.current()
    return viewPerCss(fitWidth, deviceWidth, state.current.pageScale)
  }, [])

  const apply = useCallback((): void => {
    const s = state.current
    const now = Date.now()
    const offset = s.lead ? leadOffset(s.lead, perCss(), now) : 0
    const scale = s.pinch ? pinchLeadScale(s.pinch.asked, s.pinch.startScale, s.pageScale) : 1
    write(offset + s.fade, scale)
  }, [perCss, write])

  const tick = useCallback((): void => {
    const s = state.current
    s.raf = 0
    const now = Date.now()
    const ms = Math.min(48, now - (s.lastTick || now - 16))
    s.lastTick = now
    if (s.velocity !== 0 && s.fingers.size === 0) {
      const step = flingStep(s.velocity, ms)
      if (step) {
        s.velocity = step.velocity
        if (s.lead) s.lead = leadMoved(s.lead, s.lead.asked + step.delta, s.lead.progressAt)
        flingRef.current(step.delta)
      } else s.velocity = 0
    }
    if (s.lead && leadStalled(s.lead, now)) {
      // The page is not following: the picture eases back rather than jumping.
      s.fade = leadOffsetBefore(s.lead, perCss())
      s.lead = null
      s.off = true
    }
    if (s.pinch && s.fingers.size === 0 && now - s.pinchAt > 1000) s.pinch = null
    s.fade = Math.abs(s.fade) < 0.5 ? 0 : s.fade * FADE
    apply()
    const settled = !s.lead || leadOffset(s.lead, perCss(), now) === 0
    if (s.fingers.size > 0 || s.velocity !== 0 || s.fade !== 0 || s.pinch || !settled) s.raf = requestAnimationFrame(tick)
    else {
      if (s.fingers.size === 0) s.lead = null
      s.lastTick = 0
    }
  }, [apply, perCss])

  const run = useCallback((): void => {
    if (state.current.raf === 0) state.current.raf = requestAnimationFrame(tick)
  }, [tick])

  const cancel = useCallback((): void => {
    const s = state.current
    s.fingers.clear()
    s.samples = []
    s.lead = null
    s.pinch = null
    s.velocity = 0
    s.fade = 0
    s.off = true
    write(0, 1)
  }, [write])

  useEffect(() => {
    if (!enabled) cancel()
  }, [enabled, cancel])
  useEffect(() => {
    const s = state.current
    return () => {
      if (s.raf !== 0) cancelAnimationFrame(s.raf)
      s.raf = 0
    }
  }, [])

  return useMemo(
    () => ({
      cancel,
      down: (id, x, y) => {
        const s = state.current
        if (!enabledRef.current) return
        s.velocity = 0
        if (s.fingers.size === 0) {
          s.lead = null
          s.off = false
          s.samples = [{ y, at: Date.now() }]
          s.fade = 0
          s.pinch = null
          write(0, 1)
        }
        s.fingers.set(id, { x, y, startX: x, startY: y })
        if (s.fingers.size !== 2) return
        s.lead = null
        s.off = true
        const [a, b] = [...s.fingers.values()]
        const el = canvas.current?.getBoundingClientRect()
        s.pinch = {
          startDistance: Math.hypot(a.x - b.x, a.y - b.y),
          asked: 1,
          startScale: s.pageScale,
          originX: (a.x + b.x) / 2 - (el?.left ?? 0),
          originY: (a.y + b.y) / 2 - (el?.top ?? 0)
        }
        if (canvas.current) canvas.current.style.transformOrigin = `${s.pinch.originX}px ${s.pinch.originY}px`
        run()
      },
      move: (id, x, y) => {
        const s = state.current
        const finger = s.fingers.get(id)
        if (!finger || !enabledRef.current) return
        s.fingers.set(id, { ...finger, x, y })
        const now = Date.now()
        if (s.pinch && s.fingers.size === 2) {
          const [a, b] = [...s.fingers.values()]
          if (s.pinch.startDistance > 0) s.pinch = { ...s.pinch, asked: Math.hypot(a.x - b.x, a.y - b.y) / s.pinch.startDistance }
          s.pinchAt = now
          apply()
          return
        }
        if (s.off || s.fingers.size !== 1) return
        s.samples = [...s.samples, { y, at: now }].slice(-SAMPLES)
        const dx = x - finger.startX
        const dy = y - finger.startY
        if (!s.lead) {
          if (Math.hypot(dx, dy) < LEAD_SLOP_PX) return
          // Sideways is a carousel far more often than a page.
          if (Math.abs(dx) > Math.abs(dy)) {
            s.off = true
            return
          }
          s.lead = startLead({ scrollY: s.scrollY, at: now })
          if (canvas.current) canvas.current.style.transformOrigin = ''
          run()
        }
        s.lead = leadMoved(s.lead, dy, now)
        apply()
      },
      up: (id) => {
        const s = state.current
        if (!s.fingers.delete(id) || s.fingers.size > 0) return
        if (s.lead && !s.off) {
          s.velocity = flingVelocity([...s.samples, { y: s.samples.at(-1)?.y ?? 0, at: Date.now() }].slice(-SAMPLES))
          s.lastTick = Date.now()
        }
        s.pinchAt = Date.now()
        run()
      },
      painted: (scrollY, pageScale) => {
        const s = state.current
        if (pageScale !== null) s.pageScale = pageScale
        s.scrollY = scrollY
        if (s.lead) s.lead = leadFrame(s.lead, scrollY, Date.now())
        // In the same task as the draw: the picture and its offset change together.
        if (s.lead || s.pinch) apply()
      }
    }),
    [apply, canvas, cancel, run, write]
  )
}

/** The offset this lead was holding when it stopped being believed. */
function leadOffsetBefore(lead: Lead, perCss: number): number {
  return leadOffset(lead, perCss, lead.progressAt)
}
