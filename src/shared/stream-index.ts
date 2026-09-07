// ONE STREAM — the pure half (design: docs/site/one-stream-2026-09-07.html, T1).
//
// THE TWO INCIDENTS THIS FILE ANSWERS.
//
//  1. THE 400+ CHECKPOINTS THAT WENT UNADDRESSABLE. A /compact ends one
//     session file and starts another, and every derivation restarted its
//     numbering at 1 in the new file. The owner's history before the compact
//     stopped being addressable — reported as destroyed, when in truth the
//     transcripts were on disk and merely unindexed (lineage-ledger.ts says
//     so at length). The ledger and its rebuild existed to renumber ACROSS
//     that boundary after the fact. The ordinal here replaces all of it: it
//     is the block's position in the WHOLE chain, assigned while walking,
//     and it never restarts. A compaction is an ATTRIBUTE of the first block
//     after it, not a new coordinate system.
//
//  2. THE CAP THAT DELETED HISTORY (2026-09-06). `sessionLineage` was capped
//     at 20 by a slice, so the next rebind of the owner's busiest card would
//     have dropped its oldest session id — one whole transcript nothing could
//     reach again. Everything here is DERIVED from files that already exist;
//     nothing is copied and nothing is capped, so there is no second copy to
//     lose and no cap to trip.
//
// Pure by construction: no I/O, no clock, no cache. Feeding the same
// documents twice yields the same ordinals, which is what lets the
// equivalence harness compare the stream against the old store at all.

import type { TraceBlock, TraceBoundaryMarker } from './trace-blocks'

/** How much prompt a light index entry carries (the rail's row label). */
export const PROMPT_HEAD_CHARS = 120

/**
 * What a compaction boundary said about itself.
 *
 * Carried on the entry (T2) because the rail's ◆ marker shows the token
 * counts, and /trace/markers is one of the five routes that become adapters
 * over this reader — an adapter that dropped `preTokens`/`postTokens` would
 * be a visibly poorer answer than the route it replaces, which is not the
 * trade this design is making.
 */
export interface CompactionFacts {
  preTokens?: number
  postTokens?: number
}

/**
 * One block's LIGHT projection inside a single file: everything the rail
 * needs and nothing of the conversation beyond a head. `index` is the block's
 * own in-file ordinal (TraceBlock.index — the shared CheckpointAssigner's
 * count), kept so a file's entries can be cached and reused wherever that
 * file lands in a chain; the stream-wide ordinal is applied on top.
 */
export interface FileEntry {
  identity: string
  index: number
  startedAt: number
  endedAt: number
  promptHead: string
  /** A compaction boundary declared IN THIS FILE sits immediately before it. */
  compacted: boolean
  /** The declared boundary's own metadata, when it carried any. */
  compaction?: CompactionFacts
}

/** A block's position in the whole stream — the rail's row. */
export interface StreamIndexEntry {
  /** TraceBlock.id: the prompt entry's message uuid, else the SAME derived
   *  digest checkpointIdentity() produces. The join key for marks. */
  identity: string
  /** 1-based position in the WHOLE chain. Never restarts at a compaction. */
  ordinal: number
  startedAt: number
  endedAt: number
  promptHead: string
  /** This block is the first after a compaction boundary — either one the
   *  transcript declares in-file, or the file rotation itself. */
  compacted: boolean
  /** The declared boundary's own metadata (absent for a bare rotation). */
  compaction?: CompactionFacts
  /**
   * The session this block's file ROTATED OUT OF — set only on the first
   * block of a file that is not the chain's oldest. It is the same fact the
   * old rail carried as TraceBoundaryMarker.previousSessionId, and it is the
   * one piece of a boundary that no single file can know about itself.
   */
  previousSessionId?: string
  /** The transcript this block was read from. */
  file: string
  /**
   * The transcript no longer holds this checkpoint's bytes — a /rewind
   * truncated the file past it (T2.5, panel C ②).
   *
   * It stays in the index, at its own ordinal, with its marks: a rewind is an
   * APPENDED fact about history, not a reason to renumber it. Blocks written
   * after the rewind take ordinals AFTER these, because ordinals never
   * regress (Codex ordinal.rs:16-100). Absent — not `false` — on every row
   * that was never rewound, so the flag reads as evidence rather than noise.
   */
  rolledBack?: true
  /**
   * Later transcripts that ALSO hold this exchange, oldest first.
   *
   * Claude replays a prefix of the conversation into the file it rotates or
   * resumes into — measured on the owner's busiest card: 181 of 1,046
   * identities, every repeat spanning more than one file, 193 of 193 with an
   * identical prompt. That is ONE exchange, so it is ONE row: at the ordinal
   * of when it happened, with its bytes resolved from the newest file listed
   * here, because that copy is what the next rotation carries forward. The
   * rule is stream-replay.ts and nothing else may restate it.
   */
  replayedIn?: string[]
}

/** Where an index entry lives, so a window can fetch the block without
 *  materialising every block in the chain (one measured chain is
 *  119 + 91 + 91 + 71 MB — it is never held whole). */
export interface StreamPosition {
  entry: StreamIndexEntry
  /** Position of the entry's file in the chain, oldest first. */
  fileAt: number
  /** Position of the block inside that file's block array. */
  localAt: number
}

/** A file's parsed contribution to the stream, as the reader loads it. */
export interface StreamFileEntries {
  file: string
  /** The session this file belongs to — the predecessor pointer a rotation
   *  boundary needs. Optional so a pure test can feed files without ids. */
  sessionId?: string
  entries: readonly FileEntry[]
}

/** First non-empty prompt line, head-capped — never the whole prompt. */
export function promptHeadOf(prompt: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  if (line.length === 0) return '(empty prompt)'
  return line.length > PROMPT_HEAD_CHARS ? `${line.slice(0, PROMPT_HEAD_CHARS - 1)}…` : line
}

/**
 * The in-file ordinals a compaction boundary lands in FRONT of.
 *
 * A marker's afterIndex is the assigner's count at the boundary record, so
 * the first block after it carries in-file index afterIndex + 1 — the same
 * arithmetic trace.ts's rail uses, kept in one place.
 */
function compactedIndexes(
  markers: readonly TraceBoundaryMarker[]
): Map<number, CompactionFacts> {
  const indexes = new Map<number, CompactionFacts>()
  for (const marker of markers) {
    if (marker.kind !== 'compact') continue
    indexes.set(marker.afterIndex + 1, {
      ...(marker.preTokens !== undefined ? { preTokens: marker.preTokens } : {}),
      ...(marker.postTokens !== undefined ? { postTokens: marker.postTokens } : {})
    })
  }
  return indexes
}

/**
 * Light entries for one file's blocks, optionally only from `from` onward.
 *
 * `from` is what makes the index EXTEND rather than rebuild: an append only
 * ever adds blocks past the previous tail (and may rewrite that tail), so a
 * reader re-derives from `count - 1` and splices. Recomputing the whole file
 * per append is the O(n²) this design exists to avoid — the same reason
 * trace.ts reads only the appended bytes.
 */
export function fileEntriesOf(
  blocks: readonly TraceBlock[],
  markers: readonly TraceBoundaryMarker[],
  from = 0
): FileEntry[] {
  const compacted = compactedIndexes(markers)
  const start = Math.max(0, Math.min(from, blocks.length))
  return blocks.slice(start).map((block) => {
    const facts = compacted.get(block.index)
    return {
      identity: block.id,
      index: block.index,
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      promptHead: promptHeadOf(block.prompt),
      compacted: facts !== undefined,
      ...(facts !== undefined && Object.keys(facts).length > 0 ? { compaction: facts } : {})
    }
  })
}

/**
 * The whole stream's positions, oldest file first.
 *
 * TWO WAYS A BLOCK IS "AFTER A COMPACTION", and both set the same attribute:
 *   - the transcript declares a compact_boundary in front of it (fileEntriesOf);
 *   - it opens a file that is not the first in the chain. An auto-compact
 *     rotation starts a NEW file, so the rotation itself IS the boundary. A
 *     rotation-born file usually also carries claude's own ◆ at afterIndex 0,
 *     in which case the two rules agree; a /clear-born file carries nothing
 *     in-file and only this rule sees it.
 *
 * The ordinal runs straight through both. That is the entire fix for the
 * unaddressable-history incident: there is one coordinate space per card, for
 * as far back as the card can still reach.
 */
export function streamPositionsOf(files: readonly StreamFileEntries[]): StreamPosition[] {
  const positions: StreamPosition[] = []
  let ordinal = 0
  files.forEach((file, fileAt) => {
    const rotatedFrom = fileAt > 0 ? files[fileAt - 1].sessionId : undefined
    file.entries.forEach((entry, localAt) => {
      ordinal += 1
      const rotation = fileAt > 0 && localAt === 0
      positions.push({
        entry: {
          identity: entry.identity,
          ordinal,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          promptHead: entry.promptHead,
          compacted: entry.compacted || rotation,
          ...(entry.compaction !== undefined ? { compaction: entry.compaction } : {}),
          ...(rotation && rotatedFrom !== undefined ? { previousSessionId: rotatedFrom } : {}),
          file: file.file
        },
        fileAt,
        localAt
      })
    })
  })
  return positions
}

/** The light list itself — streamPositionsOf without the coordinates. */
export function streamIndexOf(files: readonly StreamFileEntries[]): StreamIndexEntry[] {
  return streamPositionsOf(files).map((position) => position.entry)
}
