import { createContext, useContext } from 'react'
import type { TerminalActivity } from '../../shared/turn'

/**
 * There is no dedicated MOVE tool: the resting hand pans, drags cards and
 * clicks to zoom, and the placement tools (terminal / note / browser /
 * connect) fall back to it after one use. The clipboard is not a tool
 * either — it is a TOGGLE over the resting hand (the board view's model):
 * while `clipping` is on, cards grow checkboxes, clicking a card picks it
 * and clicking it again cancels, and the selection bar offers
 * copy/cut/save/paste (Figma-style clipboard across workspaces).
 */
export type ToolId = 'move' | 'terminal' | 'note' | 'browser' | 'connect'

/**
 * Canvas-wide UI state shared with node components: the active tool (so
 * cards don't hijack clicks while connecting), the clipboard toggle, the
 * latest per-terminal activity snapshots, and the semantic-zoom navigation.
 * Clicking a card zooms the viewport until the card fills the stage; its
 * full view then fades in (see zoom-lod.ts). zoomBack restores the previous
 * viewport.
 */
export interface CanvasUi {
  tool: ToolId
  /** Clipboard selection mode — the board view's toggle, on the canvas. */
  clipping: boolean
  activities: Record<string, TerminalActivity>
  /** Latest browser thumbnails as data URLs, keyed by node id. */
  thumbs: Record<string, string>
  /** Fixed-at-launch browser ownership; null while capability is unresolved. */
  interactiveBrowser: boolean | null
  zoomToNode: (id: string) => void
  zoomBack: () => void
  /**
   * Ask to close a card. Every ✕ goes through here rather than calling
   * removeNode itself, so the confirmation cannot be skipped by whichever
   * close button someone adds next — and there is one dialog, at App level,
   * instead of one per card.
   */
  requestClose: (nodeId: string) => void
  /** The clipboard's picked card ids — the unit of copy/cut/save/paste. */
  picked: ReadonlySet<string>
  togglePick: (nodeId: string) => void
}

export const CanvasUiContext = createContext<CanvasUi>({
  tool: 'move',
  clipping: false,
  activities: {},
  thumbs: {},
  interactiveBrowser: null,
  zoomToNode: () => undefined,
  zoomBack: () => undefined,
  requestClose: () => undefined,
  picked: new Set<string>(),
  togglePick: () => undefined
})

export function useCanvasUi(): CanvasUi {
  return useContext(CanvasUiContext)
}
