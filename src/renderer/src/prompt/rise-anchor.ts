import type { CSSProperties } from 'react'

/**
 * WHERE A MENU RISING OVER THE DOCK SITS. The box's menus (the harness menu,
 * the new agent's tune menu, the agent's own tune panel) are fixed over their
 * chip: the dock clips anything that hangs out of it. On a phone the dock rides
 * the keyboard by `--kb-inset` (keyboard-inset.ts), and a pick puts the caret in
 * the box (owner 2026-11-01), so the keyboard may come up, or go down, while a
 * menu is open. The anchor is measured without the keyboard's cover and the
 * style adds the live cover back, so the menu moves with the dock.
 * On a desktop the cover stays 0 (unset, or published as 0px).
 */

export interface RiseAnchor {
  left: number
  /** Px from the window's foot, as if no keyboard were up. */
  bottom: number
}

/** The keyboard's cover right now, as keyboard-inset.ts published it (0 when unset). */
export function keyboardCover(published: string): number {
  const px = Number.parseFloat(published)
  return Number.isFinite(px) && px > 0 ? px : 0
}

/** The cover read off the document, for a menu opening now. */
export function keyboardCoverNow(): number {
  return keyboardCover(document.documentElement.style.getPropertyValue('--kb-inset'))
}

/** A menu over a chip whose box is `rect`, `gap` px above it, the keyboard's cover taken out. */
export function riseOver(rect: { left: number; top: number }, innerHeight: number, cover: number, gap = 6): RiseAnchor {
  return { left: rect.left, bottom: Math.max(0, innerHeight - rect.top + gap - cover) }
}

/**
 * A key typed into the prompt box: the words are next, so a tune menu still
 * open over the box closes (Esc is the menu's own; arrows and modifiers type nothing).
 */
export function typesIntoBox(e: { key: string; target: unknown }): boolean {
  const target = e.target as { matches?: (selector: string) => boolean } | null
  if (typeof target?.matches !== 'function' || !target.matches('.cr-prompt input[type=text]')) return false
  return e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete'
}

/** The menu's fixed position, with the live cover added back (and taken off the room above). */
export function riseStyle(at: RiseAnchor, edge: number): CSSProperties {
  return {
    left: at.left,
    bottom: `calc(${at.bottom}px + var(--kb-inset, 0px))`,
    maxHeight: `calc(100vh - ${at.bottom + edge}px - var(--kb-inset, 0px))`
  }
}
