// Gestures on the stage element (motion.html §5): trackpad two-finger
// horizontal wheel and one-finger touch pan, through the pure reducers in
// gesture.ts. The wheel listener is non-passive and on the element itself
// (window-level wheel listeners are passive and cannot cancel), so a
// horizontal swipe can never become the browser's history swipe. Vertical
// input is left alone. An element marked data-stage-gestures="off" (the
// terminal, a tab strip that scrolls sideways) keeps its own input.
import { useEffect, type RefObject } from 'react'
import {
  TOUCH_FLICK,
  TOUCH_SPAN,
  WHEEL_FLICK,
  WHEEL_IDLE,
  WHEEL_IDLE_MS,
  WHEEL_SPAN,
  panFlick,
  panMove,
  panProgress,
  panStart,
  panTravel,
  panVelocity,
  wheelIdle,
  wheelProgress,
  wheelStep,
  type Direction,
  type PanState,
  type WheelOut,
  type WheelState
} from './gesture'

export type GestureMode = 'scrub' | 'rubber' | 'busy'

export interface GestureSink {
  /** A horizontal gesture began: what does it drive? */
  begin(dir: Direction): GestureMode
  /** `travel` in px toward `dir` (negative = back past the start); `progress` 0..1. */
  move(travel: number, progress: number): void
  /**
   * `velocity` in px/ms toward the target; `flick` the commit speed and `span` the px of a whole flight
   * for this input; `flicked` = a touch flick (panFlick), which commits from any distance.
   */
  release(progress: number, velocity: number, flick: number, span: number, flicked: boolean): void
  /**
   * No touch pans at all (the terminal level): the embed's frame covers the stage, and on a phone the
   * platform edge swipe is browser Back, which is already one level out. A stage edge-pan would double it.
   */
  touchOff(): boolean
}

const LINE_PX = 16
/** An idle timer this late was itself stalled. */
const STALL_MS = 30
const optedOut = (target: EventTarget | null) => target instanceof Element && target.closest('[data-stage-gestures="off"]') !== null

export const useStageInput = (rootRef: RefObject<HTMLElement>, sinkRef: RefObject<GestureSink>): void => {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const sink = () => sinkRef.current
    const width = () => root.clientWidth

    // ── trackpad ──
    let wheel: WheelState = WHEEL_IDLE
    let wheelMode: GestureMode | null = null
    let idleTimer = 0
    let armedAt = 0
    // A main-thread stall (mounting the target level) delays the queued wheel events past the idle
    // timer. A timer that fires late was stalled too, so its silence proves nothing: it re-arms.
    const arm = (ms: number) => {
      window.clearTimeout(idleTimer)
      armedAt = performance.now() + ms
      idleTimer = window.setTimeout(checkIdle, ms)
    }
    const handleWheelOut = (out: WheelOut | null) => {
      const s = sink()
      if (!out || !s) return
      if (out.type === 'start') {
        wheelMode = s.begin(out.dir)
        if (wheelMode !== 'busy') s.move(out.travel, wheelProgress(out.travel))
      } else if (out.type === 'move' && wheelMode && wheelMode !== 'busy') {
        s.move(out.travel, wheelProgress(out.travel))
      } else if (out.type === 'release' && wheelMode) {
        if (wheelMode !== 'busy') s.release(wheelProgress(out.travel), out.velocity, WHEEL_FLICK, WHEEL_SPAN, false)
        wheelMode = null
      }
    }
    function checkIdle() {
      if (performance.now() - armedAt > STALL_MS) return arm(WHEEL_IDLE_MS)
      const [next, out] = wheelIdle(wheel, performance.now())
      wheel = next
      handleWheelOut(out)
      if (wheel.phase !== 'idle') arm(WHEEL_IDLE_MS)
    }
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || (wheel.phase === 'idle' && optedOut(e.target))) return
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? width() : 1
      const [next, out] = wheelStep(wheel, e.deltaX * unit, e.deltaY * unit, e.timeStamp)
      wheel = next
      if (out.type === 'pass') return
      e.preventDefault()
      handleWheelOut(out)
      arm(WHEEL_IDLE_MS)
    }

    // ── touch ──
    let pan: PanState | null = null
    let panMode: GestureMode | null = null
    let pointerId = -1
    const swallowClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !e.isPrimary || optedOut(e.target)) return
      if (sink()?.touchOff()) return
      pan = panStart(e.clientX, e.clientY, e.timeStamp)
      panMode = null
      pointerId = e.pointerId
    }
    const onMove = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pointerId) return
      const was = pan.phase
      pan = panMove(pan, e.clientX, e.clientY, e.timeStamp)
      if (pan.phase === 'rejected') {
        pan = null
        return
      }
      if (pan.phase !== 'locked' || !pan.dir) return
      const s = sink()
      if (!s) return
      if (was !== 'locked') {
        panMode = s.begin(pan.dir)
        root.setPointerCapture(e.pointerId)
      }
      if (panMode !== 'busy') s.move(panTravel(pan), panProgress(pan, width()))
    }
    const onUp = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pointerId) return
      const ended = pan
      pan = null
      if (ended.phase !== 'locked' || !panMode) return
      // A pan that ends on a button must not also click it.
      window.addEventListener('click', swallowClick, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 350)
      const s = sink()
      if (!s || panMode === 'busy') return
      // The OS took the touch (iOS edge swipe, a scroll): spring back.
      const cancelled = e.type === 'pointercancel'
      const velocity = cancelled ? -Infinity : panVelocity(ended)
      s.release(panProgress(ended, width()), velocity, TOUCH_FLICK, TOUCH_SPAN * width(), !cancelled && panFlick(ended))
    }

    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    return () => {
      window.clearTimeout(idleTimer)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
    }
  }, [rootRef, sinkRef])
}
