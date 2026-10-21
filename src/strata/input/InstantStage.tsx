// STAND-IN STAGE (until Glide's lands): the same StageProps, instant swaps
// instead of flights, and the swipe input wired to it. Trackpad wheel and
// touch strokes become one in/out per gesture; a move with nowhere to go
// rubber-bands by a CSS class toggled on the element, not React state. The
// terminal level takes no swipes: its keys and wheel belong to the embed.
import { useEffect, useRef } from 'react'
import { levelOf, parentOf } from '../../shared/strata'
import type { StageProps } from '../seams'
import { classifyTouch, createWheelSwipe } from './gestures'

export function InstantStage({ path, scene, inTarget, onCommit, reducedMotion }: StageProps) {
  const el = useRef<HTMLDivElement>(null)
  const latest = useRef({ path, inTarget, onCommit, reducedMotion })
  latest.current = { path, inTarget, onCommit, reducedMotion }

  useEffect(() => {
    const stage = el.current
    if (!stage) return
    const bump = () => {
      if (latest.current.reducedMotion) return
      stage.classList.remove('rubber')
      void stage.offsetWidth
      stage.classList.add('rubber')
    }
    const commit = (swipe: 'in' | 'out') => {
      const { path: at, inTarget: target, onCommit: go } = latest.current
      if (swipe === 'in') {
        const next = target()
        return next ? go(next) : bump()
      }
      return levelOf(at) === 'machines' ? bump() : go(parentOf(at))
    }
    const wheel = createWheelSwipe()
    const onWheel = (e: WheelEvent) => {
      if (levelOf(latest.current.path) === 'terminal') return
      const { swipe, horizontal } = wheel.feed({ deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp })
      if (horizontal) e.preventDefault()
      if (swipe) commit(swipe)
    }
    let stroke: { x: number; y: number; at: number; id: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && e.isPrimary) stroke = { x: e.clientX, y: e.clientY, at: e.timeStamp, id: e.pointerId }
    }
    const onUp = (e: PointerEvent) => {
      if (!stroke || e.pointerId !== stroke.id) return
      const s = stroke
      stroke = null
      if (levelOf(latest.current.path) === 'terminal') return
      const swipe = classifyTouch({ startX: s.x, startY: s.y, endX: e.clientX, endY: e.clientY, duration: e.timeStamp - s.at, viewportWidth: innerWidth })
      if (swipe) commit(swipe)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('pointerdown', onDown)
    addEventListener('pointerup', onUp)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('pointerdown', onDown)
      removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div ref={el} className={`stage level-${levelOf(path)}`} onAnimationEnd={(e) => e.currentTarget.classList.remove('rubber')}>
      {scene(path)}
    </div>
  )
}
