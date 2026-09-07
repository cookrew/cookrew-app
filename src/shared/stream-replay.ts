// ONE EXCHANGE, ONE ROW (one-stream T2.5 follow-up).
//
// THE MEASUREMENT THAT FORCED THIS. On the owner's busiest card, 2026-09-07:
//
//   1,239 blocks · 1,046 distinct identities · 181 identities repeated
//   every repeat spans MORE THAN ONE FILE · 193/193 with the same prompt
//   the old store, over the same card, holds 486 records and NO repeated uuid
//
// Claude replays a prefix of the conversation into the transcript it rotates
// or resumes into, so the same message uuid is genuinely on disk twice. T1/T2
// gave each copy its own ordinal, which means the rail drew one exchange
// twice, a mark written against it landed on both rows, and `/stream?after=`
// resolved to the FIRST copy — so a pager could never reach past it.
//
// THE RULE, DECIDED BY EVIDENCE AND NOT BY POSITION. The uuid alone is the
// identity; the prompt is the evidence. Seeing an identity again in a file
// that does not already hold it:
//
//   same prompt      → a REPLAY of one exchange. One row, the FIRST ordinal
//                      (that is when it happened), and the block resolved from
//                      the NEWEST file that holds it — because that copy is
//                      what the next rotation will continue from.
//   different prompt → an IDENTITY COLLISION. Two different exchanges cannot
//                      share one row, and guessing which is "the" exchange
//                      would be exactly the drift this design removes. The
//                      later record is skipped and counted.
//
// WHY THE PROMPT AND NOT A DEEPER DIGEST. `promptHead` is already carried on
// every entry (the first non-empty line, capped at 120 chars) and costs
// nothing to compare. It is a WEAK digest and is named as one: two exchanges
// that share a uuid AND the first 120 characters of their prompt would read as
// a replay here. Measured across the owner's six cards with repeats, 193 of
// 193 agreed and none disagreed, so the weak test has not yet been the
// binding one. A full prompt hash would mean hashing every block on every
// parse, and this reader's whole cost model is "read the appended bytes only".

import type { StreamIndexEntry, StreamPosition } from './stream-index'

export type ReplayVerdict = 'replay' | 'same-file' | 'collision'

/** What the rule needs to know about the row that is already there. */
export interface ReplaySubject {
  promptHead: string
  /** Every file already known to hold this exchange. */
  files: readonly string[]
}

/**
 * Is this record a replay of the row already held, another read of the same
 * file, or two different exchanges wearing one uuid?
 *
 * Pure, and shared BY BOTH readers on purpose: the walk (collapseByIdentity,
 * which answers /stream and its cursors) and the projection (which answers
 * the rail and persists it) must not be able to disagree about what a replay
 * is. One rule, one function, two callers.
 */
export function replayVerdictOf(
  existing: ReplaySubject,
  incoming: { file: string; promptHead: string }
): ReplayVerdict {
  if (existing.promptHead !== incoming.promptHead) return 'collision'
  return existing.files.includes(incoming.file) ? 'same-file' : 'replay'
}

/** A uuid a later file reused for a DIFFERENT exchange. Skipped, never merged. */
export interface IdentityCollision {
  identity: string
  file: string
}

export interface CollapsedWalk {
  positions: StreamPosition[]
  collisions: IdentityCollision[]
}

/** The files a collapsed entry has been seen in, oldest first. */
function filesOf(entry: StreamIndexEntry): string[] {
  return [entry.file, ...(entry.replayedIn ?? [])]
}

/**
 * Collapse a raw walk so each exchange appears ONCE.
 *
 * Ordinals are renumbered over the collapsed list, so they stay contiguous
 * 1..n and `total` counts exchanges rather than copies. An entry keeps the
 * ordinal of its FIRST occurrence and the COORDINATES of its newest one:
 * position in the conversation comes from when it happened, the bytes come
 * from the copy a rotation will carry forward.
 */
export function collapseByIdentity(positions: readonly StreamPosition[]): CollapsedWalk {
  const out: StreamPosition[] = []
  const at = new Map<string, number>()
  const collisions: IdentityCollision[] = []
  for (const position of positions) {
    const seen = at.get(position.entry.identity)
    if (seen === undefined) {
      at.set(position.entry.identity, out.length)
      out.push(position)
      continue
    }
    const held = out[seen]
    const verdict = replayVerdictOf(
      { promptHead: held.entry.promptHead, files: filesOf(held.entry) },
      { file: position.entry.file, promptHead: position.entry.promptHead }
    )
    if (verdict === 'collision') {
      collisions.push({ identity: position.entry.identity, file: position.entry.file })
      continue
    }
    out[seen] = merged(held, position, verdict)
  }
  return { positions: renumbered(out), collisions }
}

/** The held row, re-pointed at the newer copy. A same-file re-read moves the
 *  coordinates but adds no file — it is the same bytes read again. */
function merged(
  held: StreamPosition,
  incoming: StreamPosition,
  verdict: ReplayVerdict
): StreamPosition {
  const replayedIn =
    verdict === 'replay'
      ? [...(held.entry.replayedIn ?? []), incoming.entry.file]
      : held.entry.replayedIn
  return {
    entry: {
      ...held.entry,
      // The snapshot follows the newest copy: its reply is the one that was
      // carried forward, and its end is the later of the two.
      endedAt: Math.max(held.entry.endedAt, incoming.entry.endedAt),
      ...(replayedIn !== undefined && replayedIn.length > 0 ? { replayedIn } : {})
    },
    fileAt: incoming.fileAt,
    localAt: incoming.localAt
  }
}

/** Contiguous 1..n over the collapsed list — a gap here would be a gap in
 *  the rail, and the ordinal is the rail's only coordinate. */
function renumbered(positions: readonly StreamPosition[]): StreamPosition[] {
  return positions.map((position, index) => ({
    ...position,
    entry: { ...position.entry, ordinal: index + 1 }
  }))
}
