import { createContext, useContext } from 'react'
import type { TerminalActivity } from '../../shared/turn'

export type ToolId = 'select' | 'terminal' | 'note' | 'browser' | 'connect'

/**
 * Canvas-wide UI state shared with node components: the active tool (so
 * cards don't hijack clicks while connecting), the latest per-terminal
 * activity snapshots, and the semantic-zoom navigation. Clicking a card
 * zooms the viewport until the card fills the stage; its full view then
 * fades in (see zoom-lod.ts). zoomBack restores the previous viewport.
 */
export interface CanvasUi {
  tool: ToolId
  activities: Record<string, TerminalActivity>
  /** Latest browser thumbnails as data URLs, keyed by node id. */
  thumbs: Record<string, string>
  zoomToNode: (id: string) => void
  zoomBack: () => void
}

export const CanvasUiContext = createContext<CanvasUi>({
  tool: 'select',
  activities: {},
  thumbs: {},
  zoomToNode: () => undefined,
  zoomBack: () => undefined
})

export function useCanvasUi(): CanvasUi {
  return useContext(CanvasUiContext)
}
