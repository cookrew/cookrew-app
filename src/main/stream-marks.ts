// THE ONLY JOIN IN THE SYSTEM (design: docs/site/one-stream-2026-09-07.html).
//
// A checkpoint is a block's ordinal plus its marks — a VIEW, not a record.
// Today that view is assembled in the RENDERER, from two fetches (listTurns +
// listTraceIndex), paired by an identity that can drift, with
// mergeCheckpointRows "clamping around" any row that found no partner. Every
// clamp is a row the UI could not explain.
//
// From here the join happens ONCE, on the side that owns both halves, keyed
// by the identity the stream itself assigns. Two consequences worth stating:
//
//   · a mark whose identity resolves to no block is REPORTED, never dropped
//     (the reachability gate's new line: an orphan is evidence a transcript
//     moved, and swallowing it is how 400 checkpoints looked destroyed);
//   · a block with no marks is a perfectly ordinary checkpoint — it just has
//     nothing attached yet. There is no such thing as a phantom row here,
//     because rows come from the stream and only from the stream.

import type { Mark, MarkOptions } from './marks'
import { readMarks } from './marks'
import type { StreamIndexResult } from './stream'
import type { MissingStreamFile } from './stream-chain'
import type { RollbackMark } from './stream-state'
import type { AnomalyCounts } from '../shared/stream-projection'
import type { StreamIndexEntry } from '../shared/stream-index'

/** A rail row: where the block is, plus everything attached to it. */
export interface StreamCheckpoint extends StreamIndexEntry {
  title?: string
  seenAt?: number
  pin?: number
  anchor?: number
  fork?: string
}

export interface CheckpointsResult {
  checkpoints: StreamCheckpoint[]
  /** Chain members with no readable transcript (from the stream). */
  missing: MissingStreamFile[]
  /**
   * Identities the ledger holds that this stream cannot place. Almost always
   * a predecessor whose transcript is in `missing` — so the two read
   * together, and neither is ever silently discarded.
   */
  orphanMarks: string[]
  /**
   * What the projection skipped, by class, and every rewind this card has
   * taken (T2.5). Optional because the raw reader has no persisted state to
   * count into — a service composed without one still answers the rail.
   */
  anomalies?: AnomalyCounts
  rolledBack?: RollbackMark[]
}

export interface StreamMarksDeps {
  index: (terminalId: string) => Promise<StreamIndexResult>
  /** Injected so a test — or a migration rehearsal — can supply a ledger
   *  without writing into the owner's ~/.cookrew. */
  marksOf?: (terminalId: string) => Map<string, Mark>
  markOptions?: MarkOptions
}

export interface CheckpointReader {
  checkpoints(terminalId: string): Promise<CheckpointsResult>
}

/** Fields a mark contributes to a row — spread explicitly so `identity` and
 *  `at` (the ledger's own bookkeeping) can never shadow the stream's. */
function attach(entry: StreamIndexEntry, mark: Mark | undefined): StreamCheckpoint {
  if (mark === undefined) return entry
  return {
    ...entry,
    ...(mark.title !== undefined ? { title: mark.title } : {}),
    ...(mark.seenAt !== undefined ? { seenAt: mark.seenAt } : {}),
    ...(mark.pin !== undefined ? { pin: mark.pin } : {}),
    ...(mark.anchor !== undefined ? { anchor: mark.anchor } : {}),
    ...(mark.fork !== undefined ? { fork: mark.fork } : {})
  }
}

export function createCheckpointReader(deps: StreamMarksDeps): CheckpointReader {
  const marksOf =
    deps.marksOf ?? ((terminalId: string) => readMarks(terminalId, deps.markOptions ?? {}))
  return {
    async checkpoints(terminalId) {
      const { entries, missing, anomalies, rolledBack } = await deps.index(terminalId)
      let marks: Map<string, Mark>
      try {
        marks = marksOf(terminalId)
      } catch (error) {
        // A ledger that cannot be read costs the titles, never the history:
        // the rail still renders every checkpoint the stream can reach.
        console.error('marks read failed:', error)
        marks = new Map()
      }
      const placed = new Set<string>()
      const checkpoints = entries.map((entry) => {
        const mark = marks.get(entry.identity)
        if (mark !== undefined) placed.add(entry.identity)
        return attach(entry, mark)
      })
      const orphanMarks = [...marks.keys()].filter((identity) => !placed.has(identity))
      return {
        checkpoints,
        missing,
        orphanMarks,
        ...(anomalies !== undefined ? { anomalies } : {}),
        ...(rolledBack !== undefined ? { rolledBack } : {})
      }
    }
  }
}
