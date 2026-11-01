import { createContext } from 'react'

/**
 * THE FULL VIEW'S TOOLS, ABOVE ITS SHEET (owner, 2026-11-01): the transcript's
 * CHAT/LOG/LIVE toggle and the sheet's NOTE+ and BROWSER+ stand in one row in
 * the agent's head, right over the sheet's top-right corner, instead of inside
 * the transcript's corner and the "browsers & notes" head.
 *
 * The head (stage/StageView.tsx) owns the place; the terminal, deep under it
 * (StageTerminal → TerminalOverlay), puts its toggle there with a portal. Null
 * where there is no such head: the toggle stays in the transcript's corner.
 */
export const HeadToolsContext = createContext<HTMLElement | null>(null)
