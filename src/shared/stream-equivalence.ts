// THE EQUIVALENCE COMPARATOR (design: docs/site/one-stream-2026-09-07.html).
//
// The gate before anything is switched: "for every card, the checkpoint list
// from the stream equals the list from the old store — same count, same
// identities, same titles — on the owner's real 279 files. Any difference is
// listed by card and identity."
//
// Pure on purpose. The harness that runs it against the real machine reads
// files and prints; the JUDGEMENT lives here, where it can be unit-tested,
// and where the allow-list is a data structure rather than a paragraph in a
// report nobody can re-run.
//
// WHAT AN ALLOWED DIFFERENCE IS. Not "small". A difference is allowed only
// when the stream and the old store disagree for a reason that is written
// down here and is a PROPERTY OF THE OLD STORE, never of the new reader:
//
//   old-noise-prompt      the old ledger holds a record whose prompt is noise
//                         by the current rule (isNoisePrompt — slash-command
//                         wrappers, interruptions, caveats). Those records
//                         predate the rule; the stream cannot mint them and
//                         should not.
//   stream-reaches-back   the stream holds blocks BEFORE the old list starts.
//                         This is the fix itself: the old ledger addressed the
//                         current file's T1..Tn, and the pre-compaction history
//                         was the 400+ checkpoints that went unaddressable.
//   stream-ahead          the stream holds blocks AFTER the old list ends —
//                         turns the transcript has and the ledger never
//                         persisted (the app was not running, the write was
//                         debounced away at quit, a cap trimmed the tail).
//   title-unmigrated      the old record has a Sous title and the mark ledger
//                         does not. EXPECTED IN T1 BY CONSTRUCTION: migration
//                         is dry-run only, so no mark has been written yet.
//                         This class MUST go to zero once T4 migrates.
//   legacy-no-uuid        an old record carrying no session uuid at all
//                         (scrape-era). The renderer pairs those by index
//                         today; the stream has no identity to pair with.
//   no-transcript         the card has no readable transcript at all (a
//                         scrape-only harness, or a deleted session file), so
//                         the stream is empty and the old ledger is all there
//                         is. Reported per card, never silently skipped.
//
// Everything else — a missing identity, an extra one, a reordering, two
// different titles for the same identity — is a REAL difference and fails
// the gate.

import { isNoisePrompt } from './session-turns'

/** One row of the old store, reduced to what equivalence is about. */
export interface OldCheckpoint {
  /** TurnRecord.index — the old ledger's own ordinal (per file, renumbered). */
  index: number
  /** TurnRecord.uuid, which IS checkpointIdentity's output for file-derived
   *  records — the exact key the renderer joins on today. */
  identity: string
  title?: string
  /** True when the record carries no session uuid (scrape-era, index-paired). */
  legacy?: boolean
  /** True when the record's prompt is noise by the CURRENT rule. */
  noise?: boolean
}

/** One row of the stream, reduced the same way. */
export interface StreamCheckpointRef {
  ordinal: number
  identity: string
  title?: string
}

export type DiffClass =
  | 'count'
  | 'identity-order'
  | 'identity-missing'
  | 'identity-extra'
  | 'title-differs'
  | 'title-only-in-stream'
  | 'old-noise-prompt'
  | 'stream-reaches-back'
  | 'stream-ahead'
  | 'title-unmigrated'
  | 'legacy-no-uuid'
  | 'no-transcript'

/** Classes a difference may fall into and still pass the gate — each one
 *  explained in the header, each one a property of the OLD store. */
export const ALLOWED_CLASSES: readonly DiffClass[] = [
  'old-noise-prompt',
  'stream-reaches-back',
  'stream-ahead',
  'title-unmigrated',
  'legacy-no-uuid',
  'no-transcript'
]

export interface Difference {
  class: DiffClass
  identity: string
  /** The stream ordinal when the identity is placed, else the old index. */
  ordinal: number | null
  field: string
  detail: string
}

export interface Comparison {
  ok: boolean
  /** Every difference is in an allow-listed class. */
  allowed: boolean
  counts: { old: number; stream: number; compared: number }
  differences: Difference[]
  classCounts: Record<string, number>
}

export interface CompareOptions {
  /** False when the card has no readable transcript at all. */
  streamAvailable?: boolean
}

/** Where `needle` sits inside `haystack` as a contiguous run, else -1. An
 *  empty needle aligns at 0 — an empty old ledger is not a disagreement. */
export function alignAt(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let hit = true
    for (let at = 0; at < needle.length && hit; at += 1) {
      hit = haystack[start + at] === needle[at]
    }
    if (hit) return start
  }
  return -1
}

/** Old-store title vs the stream's (which comes from marks). */
function titleDifference(
  older: OldCheckpoint,
  newer: StreamCheckpointRef
): Difference | null {
  if (older.title === newer.title) return null
  if (older.title !== undefined && newer.title === undefined) {
    return {
      class: 'title-unmigrated',
      identity: newer.identity,
      ordinal: newer.ordinal,
      field: 'title',
      detail: 'the old record has a Sous title and no mark carries it yet'
    }
  }
  if (older.title === undefined) {
    return {
      class: 'title-only-in-stream',
      identity: newer.identity,
      ordinal: newer.ordinal,
      field: 'title',
      detail: 'a mark titles a checkpoint the old store never titled'
    }
  }
  return {
    class: 'title-differs',
    identity: newer.identity,
    ordinal: newer.ordinal,
    field: 'title',
    detail: 'the mark and the old record disagree about the title'
  }
}

function tally(differences: readonly Difference[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const difference of differences) {
    counts[difference.class] = (counts[difference.class] ?? 0) + 1
  }
  return counts
}

/**
 * Compare one card's old-store checkpoint list against the stream's.
 *
 * The comparison is by IDENTITY IN ORDER, never by ordinal: the old ledger
 * numbers the current file's T1..Tn and the stream numbers the whole chain,
 * so equal ordinals would be the wrong claim entirely — the disagreement
 * between those two numberings is precisely the bug this design removes.
 */
export function compareCheckpoints(
  older: readonly OldCheckpoint[],
  stream: readonly StreamCheckpointRef[],
  options: CompareOptions = {}
): Comparison {
  const differences: Difference[] = []
  const counts = { old: older.length, stream: stream.length, compared: 0 }

  if (options.streamAvailable === false) {
    if (older.length > 0) {
      differences.push({
        class: 'no-transcript',
        identity: '',
        ordinal: null,
        field: 'stream',
        detail: `no readable transcript; the old store holds ${older.length} record(s)`
      })
    }
    return finish(differences, counts)
  }

  const kept: OldCheckpoint[] = []
  for (const record of older) {
    if (record.noise === true) {
      differences.push({
        class: 'old-noise-prompt',
        identity: record.identity,
        ordinal: record.index,
        field: 'prompt',
        detail: 'the old record prompt is noise by the current rule'
      })
      continue
    }
    if (record.legacy === true) {
      differences.push({
        class: 'legacy-no-uuid',
        identity: record.identity,
        ordinal: record.index,
        field: 'identity',
        detail: 'scrape-era record with no session uuid; paired by index today'
      })
      continue
    }
    kept.push(record)
  }

  const oldIds = kept.map((record) => record.identity)
  const streamIds = stream.map((row) => row.identity)
  const start = alignAt(streamIds, oldIds)

  if (start >= 0) {
    if (start > 0) {
      differences.push({
        class: 'stream-reaches-back',
        identity: streamIds[0],
        ordinal: stream[0].ordinal,
        field: 'count',
        detail: `${start} block(s) before the old ledger's first record`
      })
    }
    const after = streamIds.length - (start + oldIds.length)
    if (after > 0) {
      differences.push({
        class: 'stream-ahead',
        identity: streamIds[streamIds.length - 1],
        ordinal: stream[stream.length - 1].ordinal,
        field: 'count',
        detail: `${after} block(s) past the old ledger's last record`
      })
    }
    kept.forEach((record, at) => {
      counts.compared += 1
      const difference = titleDifference(record, stream[start + at])
      if (difference !== null) differences.push(difference)
    })
    return finish(differences, counts)
  }

  // Unaligned: name what is actually wrong rather than a bare count.
  const byIdentity = new Map(stream.map((row) => [row.identity, row]))
  const oldSet = new Set(oldIds)
  for (const record of kept) {
    const row = byIdentity.get(record.identity)
    if (row === undefined) {
      differences.push({
        class: 'identity-missing',
        identity: record.identity,
        ordinal: record.index,
        field: 'identity',
        detail: 'the old store holds a checkpoint the stream does not'
      })
      continue
    }
    counts.compared += 1
    const difference = titleDifference(record, row)
    if (difference !== null) differences.push(difference)
  }
  for (const row of stream) {
    if (oldSet.has(row.identity)) continue
    differences.push({
      class: 'identity-extra',
      identity: row.identity,
      ordinal: row.ordinal,
      field: 'identity',
      detail: 'the stream holds a checkpoint the old store does not'
    })
  }
  if (!differences.some((d) => d.class === 'identity-missing' || d.class === 'identity-extra')) {
    // Same members, different order — the one failure a set comparison hides.
    const at = oldIds.findIndex((identity, position) => identity !== streamIds[position])
    differences.push({
      class: 'identity-order',
      identity: at >= 0 ? oldIds[at] : oldIds[0],
      ordinal: at >= 0 && stream[at] ? stream[at].ordinal : null,
      field: 'order',
      detail: `identities agree as a set but diverge at position ${at + 1}`
    })
  }
  if (counts.old !== counts.stream && !differences.some((d) => d.class === 'count')) {
    differences.push({
      class: 'count',
      identity: '',
      ordinal: null,
      field: 'count',
      detail: `old ${counts.old} vs stream ${counts.stream}`
    })
  }
  return finish(differences, counts)
}

function finish(differences: Difference[], counts: Comparison['counts']): Comparison {
  return {
    ok: differences.length === 0,
    allowed: differences.every((difference) => ALLOWED_CLASSES.includes(difference.class)),
    counts,
    differences,
    classCounts: tally(differences)
  }
}

/** A TurnRecord as the comparator sees it — the identity rule and the noise
 *  rule both come from session-turns.ts, so neither side can drift. */
export function oldCheckpointOf(record: {
  index: number
  prompt: string
  uuid?: string
  title?: string
}): OldCheckpoint {
  return {
    index: record.index,
    identity: record.uuid ?? `no-uuid-${record.index}`,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.uuid === undefined ? { legacy: true } : {}),
    ...(isNoisePrompt(record.prompt) ? { noise: true } : {})
  }
}
