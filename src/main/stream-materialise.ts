// MATERIALISING THE INDEX FROM THE CURSOR (one-stream T2.5, panel C ① ② ③).
//
// The walk that stream-projection.ts deliberately does not do: read the
// chain's canonical lines, replay the suffix the cursor has not covered, and
// persist the advanced cursor AND the rows it covers in ONE atomic write.
//
// THE THREE RULES, and the Codex file that proves each.
//
//  1. THE CURSOR MAY FALL BEHIND; IT MAY NEVER LIE.
//     thread_history.rs:112-114 — the projection writes its rows and advances
//     its cursor in a single transaction, so a failure leaves the store
//     "behind the rollout, rather than claiming to have materialised rows it
//     did not." Here the transaction is atomic-file.ts's tmp+rename, and a
//     failed write simply leaves the previous cursor: the next pass replays
//     the same suffix, which is a no-op.
//
//  2. ORDINALS NEVER REGRESS.
//     ordinal.rs:16-100 — Paginated ordinals continue from
//     history_base.end_ordinal_exclusive and, when a file is reopened, from a
//     reverse scan of the last one written; they do not reset across files,
//     forks or compactions. Our cursor's `ordinal` is that high-water mark and
//     is NEVER lowered, not by a rewind and not by a rebuild. A NEW record
//     always takes the number after it.
//
//  3. A /REWIND IS AN APPENDED FACT, NOT A CACHE REBUILD.
//     thread_rollout_truncation.rs — Codex does not truncate; it appends
//     ThreadRolledBack{num_turns} and consumes it on replay. Claude's files
//     really do shrink, so this module detects the shrink by byte offset,
//     works out which persisted ordinals are now beyond the file, flags them
//     `rolledBack: true` (they stay in the index, at their own ordinals, with
//     their marks — titles are keyed by identity and were never in the
//     transcript), and appends {fromOrdinal, at} to the state. The blocks
//     written after the rewind take ordinals AFTER the rolled-back ones.
//
// WHAT THIS DOES NOT DO. It does not become the authority. The files are, for
// everything they contain (stream-authority.ts states the one exception);
// this is the derived record, and every disagreement with the files is
// repaired here with a log line before a single line is replayed.

import {
  applyChangeSet,
  checkpointsInOrder,
  countAnomalies,
  markRolledBack,
  projectLine,
  type AnomalyCounts,
  type ProjectedCheckpoint,
  type StreamCursor,
  type StreamLine
} from '../shared/stream-projection'
import {
  logStreamRepairs,
  repairStreamState,
  type AuthorityEvidence,
  type StreamRepair
} from './stream-authority'
import type { MissingStreamFile } from './stream-chain'
import type { StreamLinesResult } from './stream'
import type { RollbackMark, StreamState, StreamStateResult } from './stream-state'

export interface MaterialisedIndex {
  /** The rail, oldest first, rolled-back rows in place. */
  entries: ProjectedCheckpoint[]
  missing: MissingStreamFile[]
  anomalies: AnomalyCounts
  rolledBack: RollbackMark[]
  cursor: StreamCursor
  /** What disagreed with the files on this pass. Already logged. */
  repairs: StreamRepair[]
}

export interface StreamIndexStoreDeps {
  lines: (terminalId: string) => Promise<StreamLinesResult>
  readState: (terminalId: string) => StreamState
  writeState: (terminalId: string, state: StreamState) => StreamStateResult
  now?: () => number
  /** Injected so the read-repair line is assertable without a console. */
  log?: (message: string) => void
}

export interface StreamIndexStore {
  materialise(terminalId: string): Promise<MaterialisedIndex>
}

/** A row's observable content — everything except its identity key. Used to
 *  decide whether a replay actually changed anything, so an unchanged
 *  transcript costs no write at all. */
function sameCheckpoint(a: ProjectedCheckpoint | undefined, b: ProjectedCheckpoint): boolean {
  return (
    a !== undefined &&
    a.ordinal === b.ordinal &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.promptHead === b.promptHead &&
    a.compacted === b.compacted &&
    a.file === b.file &&
    a.firstAt === b.firstAt &&
    a.latestAt === b.latestAt &&
    a.rolledBack === b.rolledBack &&
    a.previousSessionId === b.previousSessionId
  )
}

function sameCounts(a: AnomalyCounts, b: AnomalyCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key as keyof AnomalyCounts] !== b[key as keyof AnomalyCounts]) return false
  }
  return true
}

function sameCursor(a: StreamCursor, b: StreamCursor): boolean {
  return a.file === b.file && a.byteOffset === b.byteOffset && a.ordinal === b.ordinal
}

/**
 * What the files say about the persisted cursor, for stream-authority.ts.
 *
 * `chainGrewBehind` is the one that needs saying: a predecessor transcript
 * appearing BEFORE the cursor's file (a spilled id that no walk had declared)
 * cannot be numbered in place without regressing every ordinal after it, so it
 * is answered with a rebuild rather than a splice.
 */
function evidenceOf(
  state: StreamState,
  read: StreamLinesResult,
  snapshot: ReadonlyMap<string, ProjectedCheckpoint>
): AuthorityEvidence {
  const positions = filePositions(read)
  const cursorAt = positions.get(state.cursor.file)
  const behind = read.lines.some(
    (line) =>
      cursorAt !== undefined &&
      (positions.get(line.file) ?? 0) < cursorAt &&
      line.entry !== undefined &&
      !snapshot.has(line.entry.identity)
  )
  return {
    cursorFileBytes: read.files.find((entry) => entry.file === state.cursor.file)?.bytesRead ?? null,
    tailFile: read.files[read.files.length - 1]?.file ?? null,
    ...(behind ? { chainGrewBehind: true as const } : {})
  }
}

function filePositions(read: StreamLinesResult): Map<string, number> {
  return new Map(read.files.map((entry, at) => [entry.file, at]))
}

/** The first ordinal a shrink took beyond its file, or null when the shrink
 *  cost no whole checkpoint (a torn last line, a rewritten open block). */
function rolledBackFrom(
  snapshot: ReadonlyMap<string, ProjectedCheckpoint>,
  lines: readonly StreamLine[],
  file: string
): number | null {
  const alive = new Set(
    lines.filter((line) => line.file === file).map((line) => line.entry?.identity)
  )
  let lowest: number | null = null
  for (const row of snapshot.values()) {
    if (row.file !== file || row.rolledBack === true || alive.has(row.identity)) continue
    if (lowest === null || row.ordinal < lowest) lowest = row.ordinal
  }
  return lowest
}

interface Replay {
  snapshot: Map<string, ProjectedCheckpoint>
  cursor: StreamCursor
  anomalies: AnomalyCounts
  dirty: boolean
}

/**
 * Replay the lines the cursor has not covered.
 *
 * Lines from files OLDER than the cursor's are not re-projected — that is what
 * a cursor is for — but their ordinals are carried forward so the projection's
 * `lastOrdinal` is the running position and not a guess. Lines from the cursor's
 * own file onward ARE re-projected every pass, and that is safe precisely
 * because the upsert guard keeps the creation ordinal and first timestamp.
 */
function replay(state: StreamState, read: StreamLinesResult, seed: Replay): Replay {
  const positions = filePositions(read)
  const cursorAt = positions.get(state.cursor.file) ?? -1
  let { snapshot, anomalies, dirty } = seed
  let cursor = seed.cursor
  let lastOrdinal = 0
  let highWater = state.cursor.ordinal
  for (const line of read.lines) {
    const seen = line.entry === undefined ? undefined : snapshot.get(line.entry.identity)
    if ((positions.get(line.file) ?? 0) < cursorAt && seen !== undefined) {
      lastOrdinal = Math.max(lastOrdinal, seen.ordinal)
      continue
    }
    const isNew = seen === undefined
    const candidate = isNew ? highWater + 1 : seen.ordinal
    const change = projectLine(
      { ...line, ordinal: candidate },
      { lastOrdinal: isNew ? Math.max(lastOrdinal, highWater) : lastOrdinal }
    )
    anomalies = countAnomalies(anomalies, change.anomalies)
    dirty = dirty || change.anomalies.length > 0
    for (const upsert of change.upserts) {
      const before = snapshot.get(upsert.identity)
      snapshot = applyChangeSet(snapshot, { upserts: [upsert], anomalies: [] })
      dirty = dirty || !sameCheckpoint(before, snapshot.get(upsert.identity) as ProjectedCheckpoint)
    }
    if (change.cursor === undefined) continue
    lastOrdinal = change.cursor.ordinal
    highWater = Math.max(highWater, change.cursor.ordinal)
    cursor = { file: change.cursor.file, byteOffset: change.cursor.byteOffset, ordinal: highWater }
  }
  return { snapshot, cursor: { ...cursor, ordinal: highWater }, anomalies, dirty }
}

/**
 * MissingFile is a STATE, not an event.
 *
 * A predecessor whose transcript is gone is gone once, not once per read, so
 * this class is SET from what the chain reports on this pass rather than
 * accumulated like the five line-level classes. Counting it per read would
 * turn one deleted session into an unbounded number that says nothing.
 */
function withMissingFiles(counts: AnomalyCounts, missing: readonly MissingStreamFile[]): AnomalyCounts {
  const next: AnomalyCounts = { ...counts }
  if (missing.length === 0) delete next.MissingFile
  else next.MissingFile = missing.length
  return next
}

export function createStreamIndexStore(deps: StreamIndexStoreDeps): StreamIndexStore {
  const now = deps.now ?? Date.now
  const log = deps.log

  return {
    async materialise(terminalId) {
      const read = await deps.lines(terminalId)
      const stored = deps.readState(terminalId)
      const before = new Map(stored.index.map((row) => [row.identity, row]))
      const { state: repaired, repairs } = repairStreamState(
        stored,
        evidenceOf(stored, read, before)
      )
      logStreamRepairs(terminalId, repairs, ...(log ? [log] : []))

      const rewound = rollbackOf(repaired, read, repairs, now())
      const result = replay(repaired, read, {
        snapshot: rewound.snapshot,
        cursor: repaired.cursor,
        anomalies: repaired.anomalies,
        dirty: repairs.length > 0 || rewound.appended !== null
      })
      const next: StreamState = {
        ...repaired,
        cursor: result.cursor,
        anomalies: withMissingFiles(result.anomalies, read.missing),
        rolledBack:
          rewound.appended === null ? repaired.rolledBack : [...repaired.rolledBack, rewound.appended],
        index: checkpointsInOrder(result.snapshot)
      }
      if (changed(stored, next, result.dirty)) persist(terminalId, next, deps, log)
      return {
        entries: next.index,
        missing: read.missing,
        anomalies: next.anomalies,
        rolledBack: next.rolledBack,
        cursor: next.cursor,
        repairs
      }
    }
  }
}

/** The rewind pass: a shrunk cursor file, turned into an appended fact. */
function rollbackOf(
  state: StreamState,
  read: StreamLinesResult,
  repairs: readonly StreamRepair[],
  at: number
): { snapshot: Map<string, ProjectedCheckpoint>; appended: RollbackMark | null } {
  const snapshot = new Map(state.index.map((row) => [row.identity, row]))
  if (!repairs.some((repair) => repair.kind === 'cursor-beyond-eof')) {
    return { snapshot, appended: null }
  }
  const fromOrdinal = rolledBackFrom(snapshot, read.lines, state.cursor.file)
  if (fromOrdinal === null) return { snapshot, appended: null }
  return { snapshot: markRolledBack(snapshot, fromOrdinal), appended: { fromOrdinal, at } }
}

function changed(stored: StreamState, next: StreamState, dirty: boolean): boolean {
  return (
    dirty ||
    !sameCursor(stored.cursor, next.cursor) ||
    !sameCounts(stored.anomalies, next.anomalies) ||
    stored.rolledBack.length !== next.rolledBack.length ||
    stored.index.length !== next.index.length
  )
}

/** A failed persist costs the cursor, never the rail: the index just read is
 *  still returned and the next pass replays the same suffix. */
function persist(
  terminalId: string,
  state: StreamState,
  deps: StreamIndexStoreDeps,
  log: ((message: string) => void) | undefined
): void {
  const result = deps.writeState(terminalId, state)
  if (result.ok) return
  const message = `stream state: ${terminalId} stayed behind the transcript — ${result.error ?? 'write failed'}`
  if (log) log(message)
  else console.error(message)
}
