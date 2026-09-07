// THE STATELESS PROJECTION (one-stream T2.5 — panel C ① and ③ of
// docs/site/one-stream-v2-compare-2026-09-07.html; evidence in
// docs/site/codex-conversation-parsing-2026-09-07.html §5 and §7).
//
// WHAT CODEX PROVED. thread_history_projection.rs is 96 lines and its own
// first line is the whole idea: "Stateless projection from canonical paginated
// rollout records to thread-history changes."
//
//     pub fn project_rollout_line(line: &RolloutLine) -> ThreadHistoryChangeSet
//
// One line in, a change set out. No `&mut self`, no accumulator, no cache —
// which is exactly why "replay a JSONL suffix … once per line, in ordinal
// order" is idempotent BY CONSTRUCTION rather than because a memo happened to
// be right. Every variant it does not understand (Compacted, TurnContext,
// SessionMeta, ResponseItem) returns an EMPTY set: the projection never
// aborts, and a record it cannot use costs one row, never the view.
//
// WHY WE NEED IT. T1/T2's reader is an accumulator: it walks a whole chain and
// re-derives every ordinal from 1 on every read. That is correct and it is
// also why a /rewind can only be answered by throwing the derived index away,
// and why "is the cache right?" has no observable answer. Splitting the walk
// (stream-materialise.ts, which owns the files) from the per-line decision
// (here, which owns nothing) turns both questions into "where is the cursor".
//
// WHAT A "LINE" IS HERE. Codex reads raw JSONL records; we read a chain of
// transcripts through trace.ts's cache, so our canonical record is one parsed
// block already placed in the chain: a StreamLine. Its `byteOffset` is the
// prefix of its file that the reader has ingested — the offset the cursor
// advances to — for the same reason Codex's seekable_reader.rs states
// "Offsets always address the original JSONL bytes."
//
// THE SIX ANOMALY CLASSES, and the one place we deliberately differ.
// Codex classes projection failures as ProjectionAnomaly::{UnknownLine,
// MissingOrdinal, DuplicateOrRegressedOrdinal, ForwardOrdinalGap,
// InvalidTimestamp} and emits a SkippedOrdinalRange instead of interrupting
// (state/src/migrations.rs:13-18). We carry the same five plus MissingFile —
// a chain member with no readable transcript, which is OUR shape of the same
// honesty — and four of the six SKIP the record.
//
// The exception is RegressedOrdinal, which still upserts, at the CONTINUING
// ordinal. Codex can drop a regressed record because its ordinals are written
// into the rollout by the producer; ours are DERIVED by the walker, so a
// candidate that went backwards is our own arithmetic being stale, not a
// record that is absent. Dropping a real exchange because its number looked
// wrong is the 400-checkpoint incident with better logging, and this design
// exists to end that. The ordinal never regresses; the record never vanishes;
// the disagreement is counted.
//
// PURE BY CONSTRUCTION: no I/O, no clock (a line carries its own `at`), no
// mutation of anything it is handed.

import type { StreamIndexEntry } from './stream-index'

/** Every way a line can be un-projectable. Counted per terminal, surfaced on
 *  /stream/index — an anomaly is evidence, not an alarm. */
export type ProjectionAnomaly =
  | 'UnknownLine'
  | 'MissingOrdinal'
  | 'RegressedOrdinal'
  | 'ForwardGap'
  | 'InvalidTimestamp'
  | 'MissingFile'

export const PROJECTION_ANOMALIES: readonly ProjectionAnomaly[] = [
  'UnknownLine',
  'MissingOrdinal',
  'RegressedOrdinal',
  'ForwardGap',
  'InvalidTimestamp',
  'MissingFile'
]

/** Counts by class. A class with nothing to report is ABSENT, never zero —
 *  so an empty object reads as "nothing was skipped" at a glance. */
export type AnomalyCounts = Partial<Record<ProjectionAnomaly, number>>

/**
 * How far the derived index has been materialised.
 *
 * `byteOffset` is the prefix of `file` the reader had ingested when the
 * ordinal was assigned — the same pair Codex persists as
 * thread_history_projection_state(next_rollout_byte_offset,
 * next_rollout_ordinal). `ordinal` is a HIGH-WATER MARK and is never lowered,
 * not even by a rewind: a rolled-back checkpoint stays addressable at its own
 * number and the next block takes the number after it.
 */
export interface StreamCursor {
  file: string
  byteOffset: number
  ordinal: number
}

/** Nothing materialised yet — a fresh card, or a state file that would not
 *  parse. Both replay from the start of the chain, which is always safe. */
export const EMPTY_CURSOR: StreamCursor = Object.freeze({ file: '', byteOffset: 0, ordinal: 0 })

/** One canonical record, as the walker hands it over. */
export interface StreamLine {
  /** The transcript it was read from. Empty means the chain named a file that
   *  is not on disk — MissingFile. */
  file: string
  /** The byte prefix of `file` this record was derived from. */
  byteOffset: number
  /** The record's own clock reading, which becomes first/latest below. */
  at: number
  /** The whole-chain ordinal the walker proposes. Absent = MissingOrdinal. */
  ordinal?: number
  /** The parsed checkpoint. Absent = UnknownLine. */
  entry?: Omit<StreamIndexEntry, 'ordinal'>
}

/**
 * A materialised checkpoint: the light index row plus the two timestamps
 * Codex keeps apart in thread_history.rs:441-460 — "Completed items are
 * immutable… preserving the original creation ordinal and timestamp while
 * updating its snapshot." `firstAt` is written on INSERT and never again;
 * `latestAt` moves on every re-projection. That split is what makes replaying
 * a suffix a no-op instead of a rewrite.
 */
export interface ProjectedCheckpoint extends StreamIndexEntry {
  /** When this checkpoint was first materialised. Insert only. */
  firstAt: number
  /** When it was last re-snapshotted. Updated on every projection. */
  latestAt: number
}

/** What the projection knows about everything BEFORE this line: one number. */
export interface ProjectionState {
  /** The ordinal of the last record projected, 0 before any. */
  lastOrdinal: number
}

/** One line's whole effect. */
export interface ChangeSet {
  upserts: readonly ProjectedCheckpoint[]
  anomalies: readonly ProjectionAnomaly[]
  /** Where the cursor stands after this line — absent when the line was
   *  skipped, because a cursor past a record we did not materialise is
   *  exactly the lie Codex's single-transaction advance exists to prevent. */
  cursor?: StreamCursor
}

export const EMPTY_CHANGE_SET: ChangeSet = Object.freeze({ upserts: [], anomalies: [] })

/** A line that was understood well enough to be skipped by name. */
function skipped(anomaly: ProjectionAnomaly): ChangeSet {
  return { upserts: [], anomalies: [anomaly] }
}

/** A clock reading this codebase will accept: finite, and not before 1970. */
function usableTime(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** A byte offset that can address a file. A nonsense one reads as 0, which
 *  makes the cursor fall BEHIND rather than skip bytes nobody projected. */
function offsetOf(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * ONE LINE → ONE CHANGE SET. The whole of Codex's project_rollout_line, over
 * our record shape. See the header for why RegressedOrdinal is the only
 * anomaly that still produces an upsert.
 */
export function projectLine(line: StreamLine, state: ProjectionState): ChangeSet {
  if (typeof line?.file !== 'string' || line.file.length === 0) return skipped('MissingFile')
  const entry = line.entry
  if (entry === undefined || typeof entry.identity !== 'string' || entry.identity.length === 0) {
    return skipped('UnknownLine')
  }
  const candidate = line.ordinal
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 1) {
    return skipped('MissingOrdinal')
  }
  if (!usableTime(line.at) || !usableTime(entry.startedAt) || !usableTime(entry.endedAt)) {
    return skipped('InvalidTimestamp')
  }
  const expected = state.lastOrdinal + 1
  const regressed = candidate < expected
  const anomalies: ProjectionAnomaly[] = regressed
    ? ['RegressedOrdinal']
    : candidate > expected
      ? ['ForwardGap']
      : []
  // A gap KEEPS the candidate — the hole is real and is recorded as one. A
  // regression takes `expected`, because an ordinal that goes backwards is
  // the one thing this coordinate space promises never happens.
  const ordinal = regressed ? expected : candidate
  return {
    upserts: [{ ...entry, ordinal, firstAt: line.at, latestAt: line.at }],
    anomalies,
    cursor: { file: line.file, byteOffset: offsetOf(line.byteOffset), ordinal }
  }
}

/**
 * Fold a change set onto a snapshot — THE UPSERT GUARD.
 *
 * Codex pushes this into SQL: the item upsert writes rollout_ordinal and
 * created_at_ms only on INSERT and, on conflict, updates nothing but
 * updated_at_ordinal and the item snapshot. Same rule here, in a Map, so that
 * re-reading a file the reader has already seen cannot renumber a checkpoint
 * or move its creation time — which is the property "replay any suffix twice"
 * rests on.
 *
 * A rolled-back row STAYS rolled back: the rollback is an appended fact about
 * a checkpoint whose bytes are gone, and a later snapshot of the same identity
 * does not un-say it (Codex: ThreadRolledBack is consumed on replay, never
 * rewritten).
 */
export function applyChangeSet(
  snapshot: ReadonlyMap<string, ProjectedCheckpoint>,
  change: ChangeSet
): Map<string, ProjectedCheckpoint> {
  const next = new Map(snapshot)
  for (const incoming of change.upserts) {
    next.set(incoming.identity, upsert(next.get(incoming.identity), incoming))
  }
  return next
}

function upsert(
  existing: ProjectedCheckpoint | undefined,
  incoming: ProjectedCheckpoint
): ProjectedCheckpoint {
  if (existing === undefined) return incoming
  return {
    ...incoming,
    ordinal: existing.ordinal,
    firstAt: existing.firstAt,
    latestAt: Math.max(existing.latestAt, incoming.latestAt),
    ...(existing.rolledBack === true ? { rolledBack: true as const } : {})
  }
}

/**
 * Flag every checkpoint at or after `fromOrdinal` as rolled back.
 *
 * The /rewind answer, and the reason it is an APPENDED fact rather than a
 * cache rebuild: the rows stay in the index, keep their ordinals, and keep
 * their marks (titles are keyed by identity and were never in the transcript
 * to begin with). Codex does the same thing one layer down —
 * thread_rollout_truncation.rs does not truncate the file, it appends
 * EventMsg::ThreadRolledBack{num_turns} and consumes it on replay.
 */
export function markRolledBack(
  snapshot: ReadonlyMap<string, ProjectedCheckpoint>,
  fromOrdinal: number
): Map<string, ProjectedCheckpoint> {
  const next = new Map<string, ProjectedCheckpoint>()
  for (const [identity, row] of snapshot) {
    next.set(
      identity,
      row.ordinal >= fromOrdinal && row.rolledBack !== true ? { ...row, rolledBack: true } : row
    )
  }
  return next
}

/** Accumulate anomaly counts. Immutable, and a class with none stays absent. */
export function countAnomalies(
  counts: AnomalyCounts,
  anomalies: readonly ProjectionAnomaly[]
): AnomalyCounts {
  if (anomalies.length === 0) return counts
  const next: AnomalyCounts = { ...counts }
  for (const anomaly of anomalies) next[anomaly] = (next[anomaly] ?? 0) + 1
  return next
}

/** The index the routes serve: oldest first, rolled-back rows in place. */
export function checkpointsInOrder(
  snapshot: ReadonlyMap<string, ProjectedCheckpoint>
): ProjectedCheckpoint[] {
  return [...snapshot.values()].sort((a, b) => a.ordinal - b.ordinal)
}
