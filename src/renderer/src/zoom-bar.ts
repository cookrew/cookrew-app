// THE ZOOMED TERMINAL'S PLACE ON THE ONE BAR.
//
// The zoomed card no longer draws a head of its own (owner 2026-10-31: the
// head, the "YOU ❯" line and the MDL/EFF/RTE rail were three rows of a phone
// screen spent on chrome). Its model switch and its CHAT/LIVE toggle sit on
// the top bar, left of ⋯, and the rest of what the head held — translate,
// titles, back, close — sits inside ⋯.
//
// The bar does not know the card and should not: the card's state (its look,
// its dials, its translation) stays where it lives, in TerminalOverlay. The
// bar only offers two places, and the card renders into them with a portal.
// This module is the meeting point: the bar registers the elements, the card
// reads them, and ⋯ registers how to close itself — because a click inside a
// portal bubbles through the CARD's React tree, never through the menu's, so
// the menu's own close-on-click cannot see it.

import { useSyncExternalStore } from 'react'

export interface ZoomSlots {
  /** Left of ⋯ on the bar. */
  bar: HTMLElement | null
  /** Inside the open ⋯ menu; null while it is closed. */
  menu: HTMLElement | null
}

let slots: ZoomSlots = { bar: null, menu: null }
let closeMenu: (() => void) | null = null
const listeners = new Set<() => void>()

function set(next: Partial<ZoomSlots>): void {
  const merged = { ...slots, ...next }
  if (merged.bar === slots.bar && merged.menu === slots.menu) return
  slots = merged
  for (const listener of listeners) listener()
}

/** Ref callback for the bar's slot. */
export function setZoomBarSlot(el: HTMLElement | null): void {
  set({ bar: el })
}

/** Ref callback for the slot inside ⋯ (mounted only while the menu is open). */
export function setZoomMenuSlot(el: HTMLElement | null): void {
  set({ menu: el })
}

/** ⋯ says how it closes; null when it unmounts. */
export function registerZoomMenuClose(close: (() => void) | null): void {
  closeMenu = close
}

/** Close ⋯ after a row the card put there has acted. */
export function closeZoomMenu(): void {
  closeMenu?.()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): ZoomSlots => slots
const serverSnapshot = (): ZoomSlots => ({ bar: null, menu: null })

export function useZoomSlots(): ZoomSlots {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/**
 * Which one switch the bar shows for the model. A routed card's model is its
 * ROUTE — the harness's own record then reads a gateway id or `<synthetic>`,
 * which is what the owner's phone showed under MDL — so a routed card offers
 * the route dial and a direct card offers the model dial. Never both: the bar
 * has room for one switch, and two words for one fact read as two facts.
 */
export function modelSwitchKind(input: { routeDial: boolean; route: string | null | undefined }): 'route' | 'model' {
  return input.routeDial && typeof input.route === 'string' && input.route !== 'direct' ? 'route' : 'model'
}
