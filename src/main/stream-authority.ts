// WHO IS AUTHORITATIVE, NAMED OUT LOUD (one-stream T2.5, panel C ④).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSCRIPT FILES ARE AUTHORITATIVE FOR EVERYTHING THEY CONTAIN.
//
// Every prompt, every reply, every compaction boundary, every ordering, every
// timestamp: if a derived record and a session file disagree about any of it,
// THE FILE WINS. The derived record is repaired to match, one line is logged,
// and nothing is deleted. There is no case in this codebase where a stored
// checkpoint out-votes the transcript it was read from — that arrangement is
// precisely what produced the 400 unaddressable checkpoints, the phantom rail
// rows, and the cap that would have dropped a whole session id.
//
// THE ONE THING THE FILES CANNOT SAY IS WHICH FILES BELONG TO A CARD.
//
// A transcript knows its own session id and, at a rotation, the id it came
// from. It does not know that Conductor's card is bound to it, and it cannot:
// nothing inside ~/.claude/projects has ever heard of a Cookrew terminal. That
// single fact — this card reads THESE sessions, oldest first — is answered by
// the oracle (claude-session-oracle.ts: the pane's own process states which
// session it is writing) together with the durable lineage spill
// (lineage-spill.ts: every id this card has passed through, append-only). That
// is the ONLY place a derived record wins over the files, and it wins because
// there is no file to lose to.
//
// Codex draws the same line and writes it down in the same spirit
// (state_db.rs:560-562): its one reverse authority is WHICH rollout file a
// thread selected — after a revert a thread has several immutable files and
// only the database knows which one is live — plus product fields (section,
// pinned, name) that have no rollout representation at all. Ours are the
// binding and the marks ledger, for exactly the same reason.
//
// EVERYWHERE ELSE: read-repair, and a log line.
//
//   stream read-repair: <terminal> <what>
//
// Never a deletion, never an exception, never a silent clamp. Codex logs a
// "state db discrepancy" on every correction (state_db.rs:518-603) for the
// same reason this does: a derived record that quietly fixes itself is a
// derived record nobody can prove was ever wrong.
// ─────────────────────────────────────────────────────────────────────────────

import { EMPTY_CURSOR, type ProjectedCheckpoint } from '../shared/stream-projection'
import type { StreamState } from './stream-state'

/** The three ways the persisted cursor can disagree with the files, plus the
 *  one way the chain can grow behind it. Each is a repair, not a failure. */
export type RepairKind =
  | 'cursor-beyond-eof'
  | 'ordinal-regression'
  | 'missing-file'
  | 'chain-grew-behind'

export interface StreamRepair {
  kind: RepairKind
  /** What was believed and what the files say — never conversation text. */
  detail: string
}

/** What the reader observed about the files this pass. */
export interface AuthorityEvidence {
  /** Bytes of the cursor's own file the reader ingested, or null when the
   *  chain no longer holds that file at all. */
  cursorFileBytes: number | null
  /** The chain's newest transcript, or null for a chain with no files. */
  tailFile: string | null
  /** True when a chain member OLDER than the cursor's file contributed a
   *  checkpoint the snapshot has never held — the chain grew behind us. */
  chainGrewBehind?: boolean
}

export interface RepairResult {
  state: StreamState
  repairs: StreamRepair[]
}

/** The highest ordinal any persisted row claims. */
function maxOrdinal(index: readonly ProjectedCheckpoint[]): number {
  return index.reduce((high, row) => (row.ordinal > high ? row.ordinal : high), 0)
}

/**
 * Bring the persisted state back into agreement with the files. PURE — the
 * caller logs and writes, so the judgement can be tested without a disk.
 *
 * The repairs, in the order they are safe to apply:
 *
 *   missing-file        the cursor names a transcript the chain no longer
 *                       holds (a rebind, a deleted session). Replay from the
 *                       chain's tail, keeping the ordinal high-water mark so
 *                       nothing is renumbered on the way back.
 *   cursor-beyond-eof   the cursor addresses bytes past the end of its own
 *                       file. The file wins: clamp. This is also the /rewind
 *                       signature, and the caller records the rollback in the
 *                       same pass — the clamp is how the cursor stops lying,
 *                       the rollback mark is how the history stays reachable.
 *   ordinal-regression  a persisted row claims an ordinal ABOVE the cursor's
 *                       high-water mark, so the next block would be numbered
 *                       under one that already exists. Raise the mark.
 *   chain-grew-behind   a predecessor transcript appeared BEFORE the cursor's
 *                       file. Its checkpoints cannot be numbered in place
 *                       without regressing every ordinal after them, so the
 *                       derived index is rebuilt from the files — the whole
 *                       point of a derivation being rebuildable. Rolled-back
 *                       rows are carried across (their bytes are gone, so no
 *                       replay can find them) and keep the low end of the new
 *                       ordinal space, which is where they chronologically are.
 */
export function repairStreamState(
  state: StreamState,
  evidence: AuthorityEvidence
): RepairResult {
  const repairs: StreamRepair[] = []
  let next = state

  if (evidence.chainGrewBehind === true) {
    repairs.push({
      kind: 'chain-grew-behind',
      detail: 'a predecessor transcript appeared before the cursor — rebuilding the index'
    })
    const carried = next.index.filter((row) => row.rolledBack === true)
    return {
      state: {
        ...next,
        cursor: { ...EMPTY_CURSOR, ordinal: maxOrdinal(carried) },
        index: carried
      },
      repairs
    }
  }

  if (next.cursor.file.length > 0 && evidence.cursorFileBytes === null) {
    const tail = evidence.tailFile ?? ''
    repairs.push({
      kind: 'missing-file',
      detail: `cursor file is not in the chain (${base(next.cursor.file)} → ${base(tail)})`
    })
    next = { ...next, cursor: { ...next.cursor, file: tail, byteOffset: 0 } }
  } else if (
    evidence.cursorFileBytes !== null &&
    next.cursor.byteOffset > evidence.cursorFileBytes
  ) {
    repairs.push({
      kind: 'cursor-beyond-eof',
      detail:
        `cursor at ${next.cursor.byteOffset} of ${base(next.cursor.file)}, ` +
        `which now holds ${evidence.cursorFileBytes}`
    })
    next = { ...next, cursor: { ...next.cursor, byteOffset: evidence.cursorFileBytes } }
  }

  const high = maxOrdinal(next.index)
  if (high > next.cursor.ordinal) {
    repairs.push({
      kind: 'ordinal-regression',
      detail: `cursor ordinal ${next.cursor.ordinal} is behind the index's ${high}`
    })
    next = { ...next, cursor: { ...next.cursor, ordinal: high } }
  }

  return { state: next, repairs }
}

/** A path reduced to its file name — a state file is not a place to print
 *  the owner's project layout. */
function base(file: string): string {
  const at = file.lastIndexOf('/')
  return at < 0 ? file : file.slice(at + 1)
}

/**
 * ONE LINE PER REPAIR. The sentence is fixed on purpose so the whole class is
 * greppable in a log the owner did not know they would need:
 *
 *   stream read-repair: <terminal> <what>
 */
export function logStreamRepairs(
  terminalId: string,
  repairs: readonly StreamRepair[],
  log: (message: string) => void = (message) => console.error(message)
): void {
  for (const repair of repairs) {
    log(`stream read-repair: ${terminalId} ${repair.kind} — ${repair.detail}`)
  }
}
