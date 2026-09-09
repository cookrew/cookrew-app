/** Types for scripts/checkpoint-gate-lib.mjs (see that file for WHY). */

import type { SpillRecord } from '../src/shared/lineage-spill-format.d.mts'

/** The session a transcript path names, or null when it names none. */
export declare function sessionIdOfFile(file: unknown): string | null

/** Predecessors the given transcripts declare they compacted — claude's own
 *  join, read from the head of each file. */
export declare function compactionPredecessorsOf(files: Iterable<string>): Set<string>

/** What the app materialised for one card, or null when it has materialised
 *  nothing. Null is NO ANSWER, never "nothing was written". */
export interface StreamEvidence {
  /** Sessions whose transcripts the index says blocks were read OUT of. */
  files: Set<string>
  /** Those transcripts' absolute paths. */
  paths: Set<string>
  /** `previousSessionId` off the rotation boundaries — a compaction fact. */
  predecessors: Set<string>
  /** One identity per row: the join key a mark resolves against. */
  identities: Set<string>
}

export declare function streamEvidenceOf(
  streamDir: string,
  terminalId: string
): StreamEvidence | null

/** The durable lineage record, or an empty one when there is none. */
export declare function spillOf(spillsDir: string, terminalId: string): SpillRecord

/** The distinct identities a card's mark ledger holds, oldest first. */
export declare function markIdentities(marksDir: string, terminalId: string): string[]

export interface Rotations {
  /** Card id → the 8-char ids its rotations ever named (reach's witness). */
  witnesses: Map<string, Set<string>>
  /** Card id → rotation destinations, oldest first (flap). */
  destinations: Map<string, string[]>
  /** Card id → 8-char id → when the card FIRST rotated away from it. */
  departures: Map<string, Map<string, number>>
}

export declare function rotationsOf(cookrewDir: string, nodes: Set<string>): Rotations
