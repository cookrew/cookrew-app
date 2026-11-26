import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ViewportSize } from './browser-stream'
import { ASK_SETTLE_RECHECK_MS, EMPTY_STEADY, readBox, stepAsk, type AskMode, type SteadyState } from './viewport-steady'

const UNMEASURED: ViewportSize = { width: 0, height: 0 }

/**
 * The viewport this view ASKS the Mac for (viewport-steady.ts). In 'box' mode
 * it is the measured box, as it always was; in 'steady' mode (a phone) it is
 * the page's width and a height that moves only on a real change, never read
 * from a box that is mid-zoom. A held ask looks again on a short timer, since
 * a transform ending fires no resize.
 */
export function useSteadyAsk(
  boxRef: RefObject<HTMLElement | null>,
  view: { readonly w: number; readonly h: number },
  mode: AskMode
): ViewportSize {
  const [ask, setAsk] = useState<ViewportSize>(UNMEASURED)
  const stateRef = useRef<SteadyState>(EMPTY_STEADY)
  const { w, h } = view

  useEffect(() => {
    const el = boxRef.current
    if (mode !== 'steady') {
      // Coming back to 'steady' starts from no ask, so its first reading is sent.
      stateRef.current = EMPTY_STEADY
      return
    }
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      const step = stepAsk(stateRef.current, readBox(el, { w, h }, document, window), mode, Date.now())
      stateRef.current = step.state
      if (step.decision.kind === 'send') setAsk(step.decision.ask)
      else if (step.decision.kind === 'hold') timer = setTimeout(check, ASK_SETTLE_RECHECK_MS)
    }
    check()
    // A turn of the phone moves the page's width; the box usually follows, but not always.
    window.addEventListener('resize', check)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', check)
    }
  }, [boxRef, w, h, mode])

  return mode === 'steady' ? ask : { width: w, height: h }
}
