// THE LOUPE: where avatars are drawn smaller than a hit target (L0 portals,
// crowded L1 containers), a round lens follows the pointer and magnifies them
// to ≥ 28 px; the seat nearest its centre is previewed. On touch it appears
// above the finger after a press-and-hold. A PEEK only: a click or tap goes into
// the container and never dives (dive targets are drawn ≥ MIN_TARGET), and a
// lift after a hold leaves the highlight and card, so Enter dives. The lens
// moves by transforms written in rAF straight to the DOM; React hears about it
// only when the lens rests on a seat (highlight + summary card, one commit).
import { useEffect, useRef, type PointerEvent } from 'react'
import type { FigureArt, Rect } from '../../shared/strata'
import { HOLD, markConsumed } from '../input/gestures'
import { HOVER_INTENT_MS } from '../summary/hover-intent'
import { center } from './geometry'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import type { SeatRef } from './model'

const LENS = { pointer: 168, touch: 132 } as const
/** On touch the lens floats this far above the finger, so the finger never hides it. */
const ABOVE_FINGER = 96

export const loupeZoom = (seatW: number) => Math.max(2, Math.min(6, 28 / Math.max(1, seatW)))

/** The seat under (x, y): within half a pitch of its centre, in stage px. */
export const nearestSeat = (seats: readonly SeatRef[], x: number, y: number): SeatRef | null => {
  let best: { seat: SeatRef; d: number } | null = null
  for (const seat of seats) {
    const c = center(seat.rect)
    const d = Math.hypot(c.x - x, c.y - y)
    if (d <= seat.rect.w * 0.75 && (!best || d < best.d)) best = { seat, d }
  }
  return best?.seat ?? null
}

export interface LoupeBox {
  id: string
  art: FigureArt
  rect: Rect
}

export function Loupe({ region, seats, boxes, onGoIn, label }: { region: Rect; seats: SeatRef[]; boxes: LoupeBox[]; onGoIn: () => void; label: string }) {
  const env = useLevels()
  const lens = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const point = useRef<{ x: number; y: number; touch: boolean } | null>(null)
  const picked = useRef<SeatRef | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const touchMoved = useRef(false)
  const touchActive = useRef(false)
  const zoom = loupeZoom(seats[0]?.rect.w ?? 4)
  const size = env.touch ? LENS.touch : LENS.pointer

  const paint = () => {
    frame.current = null
    const p = point.current
    const el = lens.current
    if (!p || !el || !content.current || !ring.current) return
    const r = size / 2
    const lx = p.x - r
    const ly = p.y - r - (p.touch ? ABOVE_FINGER : 0)
    el.style.transform = `translate(${lx}px, ${ly}px)`
    el.style.opacity = '1'
    content.current.style.transform = `translate(${r - p.x * zoom}px, ${r - p.y * zoom}px) scale(${zoom})`
    const seat = nearestSeat(seats, p.x, p.y)
    if (seat) {
      ring.current.style.display = 'block'
      ring.current.style.transform = `translate(${seat.rect.x}px, ${seat.rect.y}px)`
      ring.current.style.width = `${seat.rect.w}px`
      ring.current.style.height = `${seat.rect.h}px`
    } else ring.current.style.display = 'none'
    if (seat?.key !== picked.current?.key) {
      // Scrubbing commits nothing: the highlight and the card follow only once the lens rests on a seat.
      if (dwell.current) clearTimeout(dwell.current)
      dwell.current = null
      if (picked.current && !seat) env.hover.leave(picked.current.key)
      picked.current = seat
      if (seat)
        dwell.current = setTimeout(() => {
          dwell.current = null
          env.setHighlight(seat.path, 'pointer')
          env.hover.showNow(seat.key)
        }, HOVER_INTENT_MS)
    }
  }
  const schedule = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(paint)
  }
  const hide = () => {
    if (lens.current) lens.current.style.opacity = '0'
    if (dwell.current) clearTimeout(dwell.current)
    dwell.current = null
    if (picked.current) env.hover.leave(picked.current.key)
    picked.current = null
    point.current = null
    touchActive.current = false
  }
  const local = (e: PointerEvent) => {
    const host = (e.currentTarget as HTMLElement).offsetParent as HTMLElement | null
    const box = host?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }
  /** Lens away; the highlight and card the dwell committed stay (touch: until the next tap). */
  const putAway = () => {
    if (lens.current) lens.current.style.opacity = '0'
    if (dwell.current) clearTimeout(dwell.current)
    dwell.current = null
    picked.current = null
    point.current = null
    touchActive.current = false
  }

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (holdTimer.current) clearTimeout(holdTimer.current)
      if (dwell.current) clearTimeout(dwell.current)
    },
    []
  )

  return (
    <>
      <div
        className="loupe-region"
        style={rectStyle(region)}
        role="presentation"
        aria-label={label}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch' && !touchActive.current) {
            // Moving before the hold fires makes it a swipe: no lens, no tap.
            const start = touchStart.current
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > HOLD.slop) {
              touchMoved.current = true
              if (holdTimer.current) clearTimeout(holdTimer.current)
            }
            return
          }
          point.current = { ...local(e), touch: e.pointerType === 'touch' }
          schedule()
        }}
        onPointerLeave={(e) => e.pointerType !== 'touch' && hide()}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return
          const start = local(e)
          touchStart.current = { x: e.clientX, y: e.clientY }
          touchMoved.current = false
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          holdTimer.current = setTimeout(() => {
            touchActive.current = true
            point.current = { ...start, touch: true }
            schedule()
          }, HOLD.ms)
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== 'touch') return
          if (holdTimer.current) clearTimeout(holdTimer.current)
          touchStart.current = null
          if (!touchActive.current) {
            if (touchMoved.current) return
            markConsumed(e.nativeEvent)
            return onGoIn()
          }
          markConsumed(e.nativeEvent)
          putAway()
        }}
        onPointerCancel={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current)
          hide()
        }}
        onClick={(e) => {
          if ((e.nativeEvent as globalThis.PointerEvent).pointerType === 'touch') return
          hide()
          onGoIn()
        }}
      />
      <div className="loupe" ref={lens} style={{ width: size, height: size }} aria-hidden="true">
        <div className="loupe-content" ref={content}>
          {boxes.map((box) => (
            <Figure key={box.id} rect={box.rect} className="loupe-box" art={box.art} />
          ))}
          {seats.map((seat) => (
            <Figure
              key={seat.key}
              rect={seat.rect}
              className="loupe-seat"
              art={env.kit.avatar({ phase: seat.agent.phase, source: seat.agent.phaseSource, harness: seat.agent.harness, size: 'small' })}
            />
          ))}
          <div className="loupe-ring" ref={ring} />
        </div>
      </div>
    </>
  )
}
