import { useEffect, useState } from 'react'

/**
 * Keyboard inset (px): how far the on-screen keyboard covers the LAYOUT viewport
 * from the bottom. On mobile the layout viewport (window.innerHeight) stays full
 * height while the VISUAL viewport shrinks to the space above the keyboard, so
 * the overlap is innerHeight − visualViewport.height − visualViewport.offsetTop
 * (offsetTop covers a viewport pushed down, e.g. a pinch-zoom pan). Clamped at 0
 * (no keyboard / no overlap). Pure — unit-tested.
 *
 * An engine that honours `interactive-widget=resizes-content` (Chrome/Android)
 * shrinks the LAYOUT viewport itself, so innerHeight === visualViewport.height
 * and this reads 0 — the shell is already the right size and must not give up
 * the band a second time.
 */
export function keyboardInset(innerHeight: number, viewportHeight: number, offsetTop: number): number {
  return Math.max(0, innerHeight - viewportHeight - offsetTop)
}

/**
 * Whether the engine's own scroll has to be undone. Safari/iOS does not resize
 * the layout viewport for the keyboard — it SCROLLS the page to reveal the
 * focused element, which drags the shell's top (header, card chrome) off screen:
 * the shell rises but the wrong part of it is showing. Correcting is only safe
 * because the companion pins `user-scalable=no`, so under a raised keyboard a
 * panned viewport is always the engine's doing and never a user pinch-pan.
 * Pure — unit-tested.
 */
export function shouldResetPan(inset: number, offsetTop: number): boolean {
  return inset > 0 && offsetTop > 0
}

/**
 * KEYBOARD AUTO-RISE. Track the keyboard via window.visualViewport and publish
 * the covered band as the `--kb-inset` CSS variable on the root, which the app
 * shell subtracts from its own height (`.cr-app` in styles.css). The shell is a
 * flex column — header / stage / dock — so giving up that band lifts the dock
 * above the keyboard AND shrinks the stage under it.
 *
 * The second half is the point. The stage is ReactFlow's pane; the zoomed
 * terminal overlay is sized from the pane rect (zoom-lod), and the overlay's
 * ResizeObserver refits xterm and resizes the PTY. So raising the keyboard
 * reflows the agent TUI to the rows that are actually visible and its prompt
 * line lands just above the keyboard instead of behind it. Dismissing the
 * keyboard runs the same path in reverse.
 *
 * No height transition: iOS fires the visualViewport resize once, AFTER its
 * keyboard animation has finished, so an animated shell would trail the
 * keyboard rather than ride it — and every animated frame would re-lay out the
 * pane for nothing.
 *
 * No visualViewport (desktop / older engines) → NO-OP: the inset stays 0 and
 * the variable is never set.
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
      // Unpan BEFORE the early-out: undoing the scroll is what lets the inset
      // grow to its full value, so gating it on a changed inset would leave
      // the shell parked in the half-risen state this exists to fix. Landing
      // at 0 emits no scroll event, so this cannot spin.
      if (shouldResetPan(next, vv.offsetTop)) window.scrollTo(0, 0)
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
