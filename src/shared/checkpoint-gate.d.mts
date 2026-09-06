/** Types for src/shared/checkpoint-gate.mjs (see that file for WHY). */

import type { PaneAgentResolution } from './pane-agent.d.mts'

export interface LiveVerdict {
  verdict: 'OK' | 'MISMATCH' | 'UNKNOWN'
  detail: string
}

export interface ReachVerdict {
  verdict: 'OK' | 'FAIL'
  /** binding ∪ lineage ∪ spill, oldest first — what can still be reached. */
  chain: string[]
  /** Previously-bound ids (8-char witnesses) the chain no longer contains. */
  missing: string[]
  /** Chain ids that were really used and whose transcript is gone — a FAIL. */
  gone: string[]
  /** Chain ids nothing ever wrote (a card that never booted) — reported only. */
  unwritten: string[]
}

export declare function liveVerdict(
  bound: string | null | undefined,
  resolution: PaneAgentResolution | null
): LiveVerdict

export interface FlapVerdict {
  verdict: 'OK' | 'FLAP'
  /** Destinations the card rotated onto more than once inside the window. */
  ids: string[]
  /** How many rotations were examined. */
  rotations: number
}

export declare const FLAP_WINDOW: number

export declare function flapVerdict(input: {
  /** Rotation destinations, oldest first (8-char prefixes from the event log). */
  rotations: readonly string[]
  window?: number
}): FlapVerdict

export declare function reachVerdict(input: {
  bound: string | null | undefined
  lineage: readonly string[]
  spillIds: readonly string[]
  everBound: readonly string[]
  hasTranscript: (id: string) => boolean
}): ReachVerdict
