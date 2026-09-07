/** Types for src/shared/checkpoint-gate.mjs (see that file for WHY). */

import type { PaneAgentResolution } from './pane-agent.d.mts'

export interface LiveVerdict {
  verdict: 'OK' | 'MISMATCH' | 'UNKNOWN'
  detail: string
}

/** What may prove a transcript once existed, strongest first. */
export type TranscriptEvidence = 'stream-index' | 'compaction' | 'turn-store' | 'held'

/** Facts the caller gathered about ONE absent session id. All optional: a
 *  fact nobody could gather is not a fact against the id. */
export interface TranscriptFacts {
  /** The persisted stream index lists blocks read out of that file. */
  inStreamIndex?: boolean
  /** A later transcript declares it as the predecessor it compacted. */
  namedByCompaction?: boolean
  /** The old turn store holds records attributable to it. */
  inTurnStore?: boolean
  /** Milliseconds from the binding to the rotation that replaced it, or null
   *  when the interval cannot be dated. Never an open-ended age. */
  heldMs?: number | null
  /** The event log saw a rotation naming it — never evidence on its own. */
  witnessed?: boolean
}

export interface TranscriptEvidenceVerdict {
  existed: boolean
  evidence: TranscriptEvidence | null
  /** The gate's sentence for this id, printed as-is. */
  reason: string
}

/** How long a binding must have lasted before its absence is a loss. */
export declare const MINT_GRACE_MS: number

export declare function transcriptEvidence(
  facts?: TranscriptFacts,
  graceMs?: number
): TranscriptEvidenceVerdict

/** An absent transcript, and what the gate concluded about it. */
export interface AbsentTranscript {
  id: string
  evidence: TranscriptEvidence | null
  reason: string
}

export interface ReachVerdict {
  verdict: 'OK' | 'FAIL'
  /** binding ∪ lineage ∪ spill, oldest first — what can still be reached. */
  chain: string[]
  /** Previously-bound ids (8-char witnesses) the chain no longer contains. */
  missing: string[]
  /** Chain ids something proves were written and whose transcript is gone. */
  gone: AbsentTranscript[]
  /** Chain ids nothing proves were ever written — reported, never a failure. */
  unwritten: AbsentTranscript[]
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
  /** What the caller could gather about an id whose transcript is absent.
   *  Omitted means nothing was gathered, which claims nothing. */
  factsFor?: (id: string) => TranscriptFacts
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
