import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tipPlace } from './face-tip'
import './prompt-motion.css'

/**
 * THE FOLDED FACE'S HOVER TIP (owner design 2026-11-04): "New Claude Code
 * agent · click, or press ⏎", a real tooltip (role, id, the face described
 * by it), not the title attribute, whose native tip lands under the cursor.
 * A mouse resting on the face, or the keyboard's focus ring, shows it; a
 * press, leaving, blur or Esc hides it. Touch never sees it (no hover).
 */

/** The tip is placed before it paints; on the server (and in its tests) there is nothing to place. */
const useBeforePaint = typeof document === 'undefined' ? useEffect : useLayoutEffect

/** About a platform tooltip's wait: a pointer passing over the bar shows nothing. */
const TIP_DELAY_MS = 450

export function TipBody({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span id={id} role="tooltip" className="pf-tip">
      {children}
    </span>
  )
}

export function FaceTip({ anchor, id, children }: { anchor: HTMLElement | null; id: string; children: React.ReactNode }): React.JSX.Element | null {
  const [shown, setShown] = useState(false)
  const tipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!anchor) return
    let timer: number | null = null
    const clear = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }
    const hide = (): void => {
      clear()
      setShown(false)
    }
    const onEnter = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return
      clear()
      timer = window.setTimeout(() => {
        timer = null
        setShown(true)
      }, TIP_DELAY_MS)
    }
    const onFocus = (): void => {
      if (anchor.matches(':focus-visible')) setShown(true)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    anchor.addEventListener('pointerenter', onEnter)
    anchor.addEventListener('pointerleave', hide)
    anchor.addEventListener('pointerdown', hide)
    anchor.addEventListener('focus', onFocus)
    anchor.addEventListener('blur', hide)
    window.addEventListener('keydown', onKey, true)
    // Placed once when shown: anything that moves the page takes it away.
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      clear()
      anchor.removeEventListener('pointerenter', onEnter)
      anchor.removeEventListener('pointerleave', hide)
      anchor.removeEventListener('pointerdown', hide)
      anchor.removeEventListener('focus', onFocus)
      anchor.removeEventListener('blur', hide)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [anchor])

  // Placed once drawn: its own size decides where it fits.
  useBeforePaint(() => {
    const tip = tipRef.current?.firstElementChild
    if (!shown || !anchor || !(tip instanceof HTMLElement)) return
    const at = tipPlace(anchor.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight })
    tip.style.left = `${at.left}px`
    tip.style.top = `${at.top}px`
    tip.dataset.side = at.side
  }, [shown, anchor])

  // A portal needs the page: the server's render (and its tests) draws none.
  if (typeof document === 'undefined') return null
  // Always in the page from the first pass, hidden until shown: the face's description is there for every reader.
  return createPortal(
    <span ref={tipRef} className="pf-tip-layer" data-shown={shown ? 'true' : undefined}>
      <TipBody id={id}>{children}</TipBody>
    </span>,
    document.body
  )
}
