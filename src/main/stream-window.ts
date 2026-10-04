// A BLOCK WINDOW IS ANSWERED FROM THE INDEX, NOT FROM A WALK (perf, 2026-10-04).
//
// THE DEFECT. `/stream?after=` — the route the transcript drawer fills every
// screen from — called reader.blocks(), and reader.blocks() walked the whole
// chain: every transcript in the lineage opened, read and parsed, to hand back
// twenty blocks that all live in one of them. D6 (T5 QA 2026-09-07) taught the
// rail and the tail to resume from the persisted cursor and never taught the
// window, so the one read a user is actually waiting on stayed the slow one.
// Measured on the owner's busiest card, 2026-10-04: eight transcripts of 19 to
// 47 MB, 220 MB in all, and the first window after a restart took 30.5 s —
// against a 177 KB answer. Every scroll fill and every rail jump paid a stat
// per file at best and the same walk at worst, because the document cache is
// byte-budgeted and eight files that size do not all stay in it.
//
// WHAT ANSWERS INSTEAD. The materialised index already knows, for every
// checkpoint, its ordinal, its identity and WHICH FILE holds it now
// (ProjectedCheckpoint.occurrences — "the last is where it is now read from").
// So a window is: pick the rows, group them by file, read THOSE files through
// the same cache, and look each row's block up by identity. A twenty-block
// window touches one transcript, occasionally two at a rotation.
//
// THREE THINGS THIS KEEPS FROM THE WALK, by construction rather than by luck:
//
//   · the numbering — stream-service already renumbered every walked block
//     from the index ("the materialised index answers the numbers"), and now
//     the numbers and the blocks come from the same rows;
//   · the paging rule — forward from `after`, backward from `before`, short at
//     the ends, an unknown cursor said out loud (stream.ts, windowByIdentity);
//   · the omission of rolled-back rows — a /rewind took their bytes, the walk
//     never had them, and they are not counted toward a page here either, so a
//     page is the same twenty blocks it was.
//
// AND ONE THING IT DOES BETTER. A transcript that rotated out of the lineage
// is still on disk, and the index still names it. The walk could not serve a
// block out of a file the chain no longer lists — on the owner's card that was
// 442 rail rows that could never fill. The index-driven window can, because
// the file is an address, not a lineage claim.

import type { ProjectedCheckpoint } from '../shared/stream-projection'
import type { StreamBlock, StreamBlocksRequest } from './stream'
import type { TraceDocument } from './trace'

/** The rows a window covers, and the two refusals a cursor can earn. */
export interface WindowRows {
  rows: ProjectedCheckpoint[]
  unknownAfter?: true
  unknownBefore?: true
}

/**
 * Which rows a request addresses. Pure: a test hands it a list.
 *
 * Rolled-back rows are excluded BEFORE the window is cut, not dropped from it
 * after, so `limit` means "this many blocks" exactly as it did when the walk
 * — which never saw those rows at all — was the one being sliced.
 */
export function windowRows(
  entries: readonly ProjectedCheckpoint[],
  request: StreamBlocksRequest,
  defaultLimit: number
): WindowRows {
  const servable = entries.filter((row) => row.rolledBack !== true)
  const limit = Math.max(1, request.limit ?? defaultLimit)
  if (request.after !== undefined) {
    const at = servable.findIndex((row) => row.identity === request.after)
    if (at < 0) return { rows: [], unknownAfter: true }
    return { rows: servable.slice(at + 1, at + 1 + limit) }
  }
  if (request.before !== undefined) {
    const at = servable.findIndex((row) => row.identity === request.before)
    if (at < 0) return { rows: [], unknownBefore: true }
    // SHORT at the start rather than shifted forward: a virtualizer that
    // asked for the page before block 3 must never be handed block 4.
    return { rows: servable.slice(Math.max(0, at - limit), at) }
  }
  return { rows: servable.slice(0, limit) }
}

/** The transcript a row is read from NOW: its newest occurrence, else the
 *  file it was first projected out of. */
export function fileOfRow(row: ProjectedCheckpoint): string {
  const newest = row.occurrences[row.occurrences.length - 1]
  return newest?.file ?? row.file
}

/** The distinct files a set of rows is served from, in first-use order. */
export function filesOfRows(rows: readonly ProjectedCheckpoint[]): string[] {
  return [...new Set(rows.map(fileOfRow))]
}

/**
 * The blocks for a window, assembled from the rows and the documents of the
 * files they name.
 *
 * A row whose identity is not in its file is OMITTED, never invented: the
 * file shrank under the index between two passes, or the row names a file
 * that is gone. The next materialise records that as a rollback; this read
 * reports what is on disk. Every field the walk stamped on a block
 * (stream.ts, blockAt) is stamped here from the row that already holds it.
 */
export function blocksOfRows(
  rows: readonly ProjectedCheckpoint[],
  documents: ReadonlyMap<string, TraceDocument>,
  sessionIdOf: (file: string) => string
): StreamBlock[] {
  const byFile = new Map<string, Map<string, TraceDocument['blocks'][number]>>()
  const lookup = (file: string): Map<string, TraceDocument['blocks'][number]> => {
    const held = byFile.get(file)
    if (held !== undefined) return held
    const built = new Map((documents.get(file)?.blocks ?? []).map((block) => [block.id, block]))
    byFile.set(file, built)
    return built
  }
  return rows.flatMap((row) => {
    const file = fileOfRow(row)
    const block = lookup(file).get(row.identity)
    if (block === undefined) return []
    // A NEW object every time: the cached block is shared state the parsers
    // extend in place, and nothing derived mutates what it read.
    const assembled: StreamBlock = {
      ...block,
      ordinal: row.ordinal,
      compacted: row.compacted,
      ...(row.compaction !== undefined ? { compaction: row.compaction } : {}),
      ...(row.previousSessionId !== undefined ? { previousSessionId: row.previousSessionId } : {}),
      file,
      sessionId: sessionIdOf(file)
    }
    return [assembled]
  })
}
