import { keepsBoxOpen, pressOnCanvas } from './enter-opens'

/**
 * A PRESS ELSEWHERE FOLDS THE OPEN BOX (owner, 2026-11-04). A primary press
 * anywhere but the box, its menus, its face or the picker folds it. On the
 * zoom's canvas the press only folds, as a press outside a menu closes it
 * (else it would also zoom out or open a card): it stops there and its own
 * click is swallowed, exactly that one. Anywhere else (the header, a page, a
 * dialog) the press goes on to do what it does.
 *
 * Listens on `win` in the capture phase while the box is open and can fold;
 * returns the unlisten.
 */

/** How long a released press's click may take to arrive (a finger's tap is the slow one). */
export const CLICK_GRACE_MS = 350

interface PressLike extends Event {
  readonly button?: number
  readonly isPrimary?: boolean
}

export function listenFoldPress(win: EventTarget, { onFold }: { onFold: () => void }): () => void {
  const onDown = (event: Event): void => {
    const e = event as PressLike
    if (e.button !== 0 || e.isPrimary === false) return
    const target = e.target instanceof Object && 'closest' in e.target ? (e.target as Element) : null
    if (keepsBoxOpen(target)) return
    onFold()
    if (!pressOnCanvas(target)) return
    e.stopPropagation()
    armSwallow(win)
  }
  win.addEventListener('pointerdown', onDown, { capture: true })
  return () => win.removeEventListener('pointerdown', onDown, { capture: true })
}

/**
 * Swallow this press's own click only. A cancelled press (a pan) never
 * clicks: it disarms at once. A lifted one gets a beat for its click, which a
 * finger's tap can deliver well after the release.
 */
function armSwallow(win: EventTarget): void {
  const swallow = (c: Event): void => {
    c.stopPropagation()
    c.preventDefault()
    unarm()
  }
  const unarm = (): void => win.removeEventListener('click', swallow, { capture: true })
  const stop = (): void => {
    win.removeEventListener('pointerup', lifted, { capture: true })
    win.removeEventListener('pointercancel', cancelled, { capture: true })
  }
  const lifted = (): void => {
    stop()
    setTimeout(unarm, CLICK_GRACE_MS)
  }
  const cancelled = (): void => {
    stop()
    unarm()
  }
  // `{ capture }`, not a bare boolean: Node's EventTarget removes a listener
  // only by the same options object shape (drop-zone.ts says the same).
  win.addEventListener('click', swallow, { capture: true })
  win.addEventListener('pointerup', lifted, { capture: true })
  win.addEventListener('pointercancel', cancelled, { capture: true })
}
