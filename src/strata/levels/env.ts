// What every level scene reads from the shell: one context instead of props
// through four levels. Changes only on discrete events (a hover settles, a key,
// a fleet event) — never per animation frame.
import { createContext, useContext, type ReactNode } from 'react'
import type { LevelsAgent, LevelsAgentDetail, LevelsWorkspace, Rect, StrataMachine, StrataPath } from '../../shared/strata'
import type { FigureKit, UseAnchor } from '../seams'
import type { HoverIntent } from '../summary/hover-intent'

export interface GoOptions {
  /** Dive with this note or browser focused in the side panels. */
  attachmentId?: string
  /** Dive with both side panels open on their full lists (the fan's +N). */
  allAttachments?: boolean
}

/** What a host's level-3 terminal is handed: the agent, and the stand-in's place to fill. */
export interface TerminalSlotProps {
  machine: StrataMachine
  workspace: LevelsWorkspace
  agent: LevelsAgent
  /** Null until the detail has been read (or when it could not be). */
  detail: LevelsAgentDetail | null
  /** The terminal's rect in stage pixels; the slot fills its box, which is a containing block. */
  size: { w: number; h: number }
  /** The shell is at this level: not the far end of a flight, not a warm pre-mount. */
  current: boolean
  /** One level out (the terminal's own Back and close). */
  out: () => void
}

/** A host that can draw the agent's real terminal (the desktop app). */
export type TerminalSlot = (props: TerminalSlotProps) => ReactNode

/** Reads one agent's detail for level 3. */
export type LoadDetail = (machine: StrataMachine, agentId: string, signal: AbortSignal) => Promise<LevelsAgentDetail>

export interface LevelsEnv {
  kit: FigureKit
  fleet: StrataMachine[]
  /** The machine list has answered (cache, live or error): before that, empty means "not yet". */
  loaded: boolean
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
  /** Where the shell is; a level drawn elsewhere (a flight's far end, a warm pre-mount) is not current. */
  path?: StrataPath
  /** One level out from where history is heading. */
  out?: () => void
  /** The host's real terminal for level 3; the stand-in shows without one. */
  terminal?: TerminalSlot
  /** The host's detail reader for level 3; the default fetches from the machine's base. */
  loadDetail?: LoadDetail
}

export const LevelsContext = createContext<LevelsEnv | null>(null)

export const useLevels = (): LevelsEnv => {
  const env = useContext(LevelsContext)
  if (!env) throw new Error('strata: a level rendered outside LevelsContext')
  return env
}
