// THE SHARED, PERSISTED CURSOR (one-stream T2.5, panel C ①).
//
//   ~/.cookrew/stream/<terminalId>.json      0600 in a 0700 dir
//   {
//     "version": 1,
//     "cursor":     { "file": "…/s3.jsonl", "byteOffset": 91234567, "ordinal": 1232 },
//     "anomalies":  { "UnknownLine": 3 },
//     "rolledBack": [ { "fromOrdinal": 1187, "at": 1757222400000 } ],
//     "index":      [ { identity, ordinal, startedAt, endedAt, promptHead,
//                       compacted, file, firstAt, latestAt, rolledBack? }, … ]
//   }
//
// WHY IT IS PERSISTED AT ALL, when T1/T2's index is derived on every read.
// Three facts cannot be derived from the transcripts, and all three are
// exactly the ones a /rewind or a bad line destroys:
//
//   · which ordinals a rewind took beyond the file (the bytes are gone, so no
//     later read can see they were ever there);
//   · that ordinals never regress ACROSS such a rewind (the walker recounts
//     from 1 and would happily reuse a rolled-back number);
//   · how many records the reader has skipped, and of which class.
//
// So the state is not a cache of the transcripts — the transcripts stay
// authoritative — it is the small set of facts about the DERIVATION that only
// the deriver was present for. Everything else in it can be, and on any
// disagreement is, rebuilt from the files (stream-authority.ts).
//
// ONE ATOMIC WRITE, AND FALLING BEHIND IS THE SAFE FAILURE. Codex advances the
// projection cursor and writes the rows it projected in ONE transaction, and
// says why in thread_history.rs:112-114 — a failure leaves the materialisation
// "behind the rollout, rather than claiming to have materialised rows it did
// not." The same rule here, with atomic-file.ts's tmp+rename standing in for
// the transaction: a crash between the temp file and the rename leaves the
// PREVIOUS state whole and readable, and the next pass replays the suffix it
// never got to. That replay is a no-op by construction (stream-projection.ts).
//
// WHY THE WHOLE FILE IS REWRITTEN, when marks.ts refuses to. A mark is written
// on every acknowledge-on-view — keystroke cadence — and rewriting the ledger
// each time is the O(n²) that turn-store's tail overlay exists to escape. This
// state changes when a TURN lands, which is a minute-scale event, and the
// cursor and the rows it covers must agree or the whole point is lost. One
// rewrite per turn is the price of "the cursor never lies", and it is paid in
// the same breath as a turn that already cost seconds of model time.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic, type AtomicWriteDeps } from './atomic-file'
import {
  EMPTY_CURSOR,
  PROJECTION_ANOMALIES,
  type AnomalyCounts,
  type ProjectedCheckpoint,
  type ProjectionAnomaly,
  type StreamCursor
} from '../shared/stream-projection'

export const STREAM_STATE_DIR_NAME = 'stream'
export const STREAM_STATE_VERSION = 1

/** One rewind, as an APPENDED fact. `fromOrdinal` is the first checkpoint the
 *  truncation took beyond the file; `at` is when this process noticed. */
export interface RollbackMark {
  fromOrdinal: number
  at: number
}

export interface StreamState {
  version: typeof STREAM_STATE_VERSION
  cursor: StreamCursor
  anomalies: AnomalyCounts
  rolledBack: RollbackMark[]
  /** The derived index snapshot the cursor covers. Written in the SAME atomic
   *  write as the cursor — see the header. */
  index: ProjectedCheckpoint[]
}

export interface StreamStateOptions {
  dir?: string
  now?: () => number
  /** Injected rename — the crash-between-temp-and-rename gate. */
  rename?: AtomicWriteDeps['rename']
}

/** An I/O outcome. Losing this state costs a replay, never a checkpoint. */
export interface StreamStateResult {
  ok: boolean
  error?: string
}

export function defaultStreamStateDir(): string {
  return path.join(homedir(), '.cookrew', STREAM_STATE_DIR_NAME)
}

/**
 * The state file for a terminal, or null when the id cannot safely name one.
 * The SAME refusal as marks.ts's markFileFor and lineage-spill's
 * spillFileName: an id that is not a plain token becomes a path segment
 * nobody vetted.
 */
export function streamStateFileFor(terminalId: string, options: StreamStateOptions = {}): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(terminalId)) return null
  return path.join(options.dir ?? defaultStreamStateDir(), `${terminalId}.json`)
}

export function emptyStreamState(): StreamState {
  return {
    version: STREAM_STATE_VERSION,
    cursor: { ...EMPTY_CURSOR },
    anomalies: {},
    rolledBack: [],
    index: []
  }
}

function finite(value: unknown, floor = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor
    ? Math.floor(value)
    : null
}

function cursorOf(raw: unknown): StreamCursor {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_CURSOR }
  const record = raw as Record<string, unknown>
  const byteOffset = finite(record.byteOffset)
  const ordinal = finite(record.ordinal)
  return {
    file: typeof record.file === 'string' ? record.file : '',
    byteOffset: byteOffset ?? 0,
    ordinal: ordinal ?? 0
  }
}

function anomaliesOf(raw: unknown): AnomalyCounts {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const counts: AnomalyCounts = {}
  for (const kind of PROJECTION_ANOMALIES) {
    const count = finite(record[kind], 1)
    if (count !== null) counts[kind as ProjectionAnomaly] = count
  }
  return counts
}

function rollbacksOf(raw: unknown): RollbackMark[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const fromOrdinal = finite(record.fromOrdinal, 1)
    const at = finite(record.at)
    return fromOrdinal === null ? [] : [{ fromOrdinal, at: at ?? 0 }]
  })
}

/** One persisted row, or nothing. A row that will not parse is DROPPED rather
 *  than repaired into a guess: the transcript still holds it, and the next
 *  replay re-materialises it from the file that is authoritative for it. */
function checkpointOf(raw: unknown): ProjectedCheckpoint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const ordinal = finite(record.ordinal, 1)
  const startedAt = finite(record.startedAt)
  const endedAt = finite(record.endedAt)
  if (typeof record.identity !== 'string' || record.identity.length === 0) return null
  if (ordinal === null || startedAt === null || endedAt === null) return null
  return {
    identity: record.identity,
    ordinal,
    startedAt,
    endedAt,
    promptHead: typeof record.promptHead === 'string' ? record.promptHead : '',
    compacted: record.compacted === true,
    file: typeof record.file === 'string' ? record.file : '',
    firstAt: finite(record.firstAt) ?? startedAt,
    latestAt: finite(record.latestAt) ?? endedAt,
    ...(typeof record.previousSessionId === 'string'
      ? { previousSessionId: record.previousSessionId }
      : {}),
    ...(typeof record.compaction === 'object' && record.compaction !== null
      ? { compaction: record.compaction as ProjectedCheckpoint['compaction'] }
      : {}),
    ...(record.rolledBack === true ? { rolledBack: true as const } : {})
  }
}

/**
 * Parse a state document. Pure and exported so the shape can be tested
 * without a disk, and so a version this build does not know reads as EMPTY —
 * a full replay — rather than as a half-understood cursor. Codex takes the
 * same line with migrations `ignore_missing: true`: an older binary must be
 * able to open a newer store without inventing what it cannot read.
 */
export function parseStreamState(text: string): StreamState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyStreamState()
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyStreamState()
  const record = raw as Record<string, unknown>
  if (record.version !== STREAM_STATE_VERSION) return emptyStreamState()
  return {
    version: STREAM_STATE_VERSION,
    cursor: cursorOf(record.cursor),
    anomalies: anomaliesOf(record.anomalies),
    rolledBack: rollbacksOf(record.rolledBack),
    index: Array.isArray(record.index)
      ? record.index.flatMap((row) => {
          const parsed = checkpointOf(row)
          return parsed === null ? [] : [parsed]
        })
      : []
  }
}

/** Read the state. NEVER throws: an absent or unreadable file is an empty
 *  cursor, which replays the whole chain — slower, never wrong. */
export function readStreamState(terminalId: string, options: StreamStateOptions = {}): StreamState {
  const file = streamStateFileFor(terminalId, options)
  if (file === null) return emptyStreamState()
  try {
    return parseStreamState(readFileSync(file, 'utf8'))
  } catch {
    return emptyStreamState()
  }
}

/**
 * Persist the cursor AND the rows it covers, in one atomic write.
 *
 * Returns a result rather than throwing, for the reason PR #65 already taught
 * this codebase once: a derived record that fails to save must cost the
 * derivation, never the turn that produced it.
 */
export function writeStreamState(
  terminalId: string,
  state: StreamState,
  options: StreamStateOptions = {}
): StreamStateResult {
  const file = streamStateFileFor(terminalId, options)
  if (file === null) return { ok: false, error: `refusing unusable terminal id: ${terminalId}` }
  try {
    writeFileAtomic(file, `${JSON.stringify(state)}\n`, {
      ...(options.rename ? { rename: options.rename } : {}),
      ...(options.now ? { now: options.now } : {})
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `stream state write for ${terminalId} failed: ${(error as Error).message}`
    }
  }
}
