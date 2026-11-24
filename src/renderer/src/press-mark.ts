/**
 * A PRESS IS SEEN WHERE THE FINGER IS, AT ONCE (press-mark.ts).
 *
 * The page answers a tap from the Mac, a round trip away: on the relay that
 * was 0.6–1.9 s before anything moved (phone stats, 11-24), and a tap that
 * shows nothing for that long feels like it missed, so it gets tapped again.
 * The press is drawn here, under the finger, the moment it lands: a ring that
 * fades, on its own layer, gone before the page's own answer comes. It says
 * "your tap was taken", never what the page will do with it.
 */

/** How long the ring lives; the CSS animation (.cr-press in styles.css) runs exactly this. */
export const PRESS_MARK_MS = 420

/** A ring on screen, and the way to take it away early. */
export interface PressMark {
  readonly x: number
  readonly y: number
  /** The finger went on to scroll, or a second one came: it was no tap after all. */
  cancel(): void
}

/** Draw the ring at a viewport point inside `box`, and take it away when it is done. */
export function pressMark(box: HTMLElement, clientX: number, clientY: number): PressMark {
  const rect = box.getBoundingClientRect()
  const ring = box.ownerDocument.createElement('span')
  ring.className = 'cr-press'
  ring.setAttribute('aria-hidden', 'true')
  ring.style.left = `${clientX - rect.left}px`
  ring.style.top = `${clientY - rect.top}px`
  box.appendChild(ring)
  // Not left to animationend alone: a reduced-motion page never fires it.
  const timer = setTimeout(() => ring.remove(), PRESS_MARK_MS + 60)
  return {
    x: clientX,
    y: clientY,
    cancel: () => {
      clearTimeout(timer)
      ring.remove()
    }
  }
}

/** Has a finger that pressed at `mark` moved far enough to be a scroll, not a tap. */
export function pressMoved(mark: Pick<PressMark, 'x' | 'y'>, clientX: number, clientY: number, slop: number): boolean {
  return Math.hypot(clientX - mark.x, clientY - mark.y) > slop
}
