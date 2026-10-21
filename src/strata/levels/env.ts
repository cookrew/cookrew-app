// What every level scene reads from the shell: one context instead of props
// through four levels. Changes only on discrete events (a hover settles, a key,
// a fleet event) — never per animation frame.
import { createContext, useContext } from 'react'
import type { Rect, StrataMachine, StrataPath } from '../../shared/strata'
import type { FigureKit, UseAnchor } from '../seams'
import type { HoverIntent } from '../summary/hover-intent'

export interface GoOptions {
  /** Dive with this note or browser focused in the side panels. */
  attachmentId?: string
  /** Dive with both side panels open on their full lists (the fan's +N). */
  allAttachments?: boolean
}

export interface LevelsEnv {
  kit: FigureKit
  fleet: StrataMachine[]
  /** The stage, in its own coordinates (x = y = 0). */
  viewport: Rect
  touch: boolean
  now: () => number
  highlight: StrataPath | null
  /** 'pointer' moves the highlight only; 'key' also moves DOM focus. */
  setHighlight: (target: StrataPath | null, via: 'pointer' | 'key') => void
  go: (target: StrataPath, opts?: GoOptions) => void
  /** Agent keys the finder lights; null while the finder is closed. */
  glow: ReadonlySet<string> | null
  /** Jump codes by agent key, drawn on avatars while the finder is open; null otherwise. */
  codes: ReadonlyMap<string, string> | null
  hover: HoverIntent
  /** Agent key whose summary card is showing. */
  summaryKey: string | null
  useAnchor: UseAnchor
  reducedMotion: boolean
  /** Dive options of the current terminal level. */
  goOptions: GoOptions
}

export const LevelsContext = createContext<LevelsEnv | null>(null)

export const useLevels = (): LevelsEnv => {
  const env = useContext(LevelsContext)
  if (!env) throw new Error('strata: a level rendered outside LevelsContext')
  return env
}
