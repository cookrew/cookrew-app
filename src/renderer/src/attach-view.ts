// WHICH OF A ZOOMED TERMINAL'S ITEMS IS OPEN, and where.
//
// Shared by two layers that never render each other: the terminal overlay
// draws the slot under the transcripts and measures it; the browser layer
// keeps hosting the browser's one page and simply renders it at that slot. The
// page is never moved or reloaded — the same webview (or stream) the canvas
// card uses, so its session and login come along.
import { useSyncExternalStore } from 'react'
import type { ScreenRect } from './zoom-lod'

export interface AttachView {
  terminalId: string
  itemId: string
  kind: 'browser' | 'note'
  /** The browser covers the whole window. */
  full: boolean
  /** The slot under the transcripts, in window px; null until measured. */
  rect: ScreenRect | null
}

let view: AttachView | null = null
const listeners = new Set<() => void>()

function set(next: AttachView | null): void {
  if (next === view) return
  view = next
  listeners.forEach((fn) => fn())
}

const sameRect = (a: ScreenRect | null, b: ScreenRect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

export const attachView = {
  get: (): AttachView | null => view,
  /** Open an item of this terminal; opening the open one closes it. */
  toggle(terminalId: string, itemId: string, kind: AttachView['kind']): void {
    if (view !== null && view.terminalId === terminalId && view.itemId === itemId) set(null)
    else set({ terminalId, itemId, kind, full: false, rect: null })
  },
  /** Open an item of this host, whatever is open now. */
  open(terminalId: string, itemId: string, kind: AttachView['kind']): void {
    if (view !== null && view.terminalId === terminalId && view.itemId === itemId) return
    set({ terminalId, itemId, kind, full: false, rect: null })
  },
  /** Close; with an id, only if that terminal's item is the open one. */
  close(terminalId?: string): void {
    if (terminalId === undefined || view?.terminalId === terminalId) set(null)
  },
  place(rect: ScreenRect | null): void {
    if (view !== null && !sameRect(view.rect, rect)) set({ ...view, rect })
  },
  full(on?: boolean): void {
    if (view !== null && view.kind === 'browser') set({ ...view, full: on ?? !view.full })
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useAttachView(): AttachView | null {
  return useSyncExternalStore(subscribe, attachView.get, () => null)
}
