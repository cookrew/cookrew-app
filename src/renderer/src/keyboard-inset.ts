import { useEffect, useState } from 'react'

/**
 * Keyboard inset (px): how far the on-screen keyboard covers the LAYOUT viewport
 * from the bottom. On mobile the layout viewport (window.innerHeight) stays full
 * height while the VISUAL viewport shrinks to the space above the keyboard, so
 * the overlap is innerHeight − visualViewport.height − visualViewport.offsetTop
 * (offsetTop covers a viewport pushed down, e.g. a pinch-zoom pan). Clamped at 0
 * (no keyboard / no overlap). Pure — unit-tested.
 */
export function keyboardInset(innerHeight: number, viewportHeight: number, offsetTop: number): number {
  return Math.max(0, innerHeight - viewportHeight - offsetTop)
}

/**
 * Track the keyboard inset via window.visualViewport and publish it as the
 * `--kb-inset` CSS variable (belt-and-suspenders to Forge's viewport-meta half),
 * so the dock/composer — and the mobile checkpoint sheet — ride above the
 * keyboard. No visualViewport (desktop / older engines) → NO-OP: the inset stays
 * 0 and the variable is never set.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    // scroll fires continuously during a keyboard drag; skip the DOM write
    // (which invalidates root style) when the inset hasn't actually moved.
    let last = -1
    const apply = (): void => {
      const next = keyboardInset(window.innerHeight, vv.height, vv.offsetTop)
      if (next === last) return
      last = next
      setInset(next)
      document.documentElement.style.setProperty('--kb-inset', `${next}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--kb-inset')
    }
  }, [])
  return inset
}
