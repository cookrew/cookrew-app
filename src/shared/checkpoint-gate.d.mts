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

export interface MarksVerdict {
  /** OK = every mark reaches a row. UNKNOWN = no stream index written yet.
   *  ORPHANS = at least one mark's identity is on no row. Never a failure. */
  verdict: 'OK' | 'UNKNOWN' | 'ORPHANS'
  /** Distinct identities the card's mark ledger holds. */
  marks: number
  /** The identities that reached no row, in ledger order. */
  orphans: string[]
  /** The gate's own sentence, empty when there is nothing to say. */
  detail: string
}

export declare function marksVerdict(input: {
  /** Identities from ~/.cookrew/marks/<id>.jsonl, folded last-wins. */
  identities: readonly string[]
  /** Identities the stream materialised, or null when it has materialised
   *  none — "no answer" and "no rows" are different facts. */
  placed: ReadonlySet<string> | readonly string[] | null
}): MarksVerdict
