// THE STREAM'S PROJECTIONS (design: docs/site/one-stream-2026-09-07.html, T2).
//
// One reader, one API — and, for one release, the five old routes answering
// off that same reader so a regression is a flag flip rather than a restore.
// Everything in this file is the ADAPTER ARITHMETIC that makes that possible,
// kept PURE and in one place for two reasons:
//
//   · byte-compatibility is T2's gate. A projection that lives in a route
//     handler is a projection nobody can diff against the old store; here it
//     is a function a fixture drives from both sides.
//   · nothing derived may mutate what it read. Stream blocks come out of
//     trace.ts's shared cache, and the parsers extend those objects in place,
//     so every projection below builds a NEW object and never touches its
//     input.
//
// WHAT THE OLD ROUTES SAID, AND HOW IT IS REBUILT HERE:
//
//   /turns        TurnRecord[]        index←ordinal, uuid←identity,
//                                     title/seenAt←marks, the rest←the block
//   /latest       {prompt,reply,title?}  the tail block + its mark
//   /trace/index  {index,id,title}[]  index←ordinal, title←promptHead, capped
//   /trace        TraceBlock[]        the block, stream extras stripped
//
// The one coordinate change is deliberate and is the whole design: `index` was
// the block's position IN ITS OWN FILE and is now its position in the WHOLE
// chain. For a card that has never compacted the two are the same number, and
// for a card that has, the old number was the one that made 400+ checkpoints
// unaddressable.

import type { TraceBlock, TraceIndexEntry } from './trace-blocks'
import { promptHeadOf, type StreamIndexEntry } from './stream-index'
import { checkpointIdentity } from './session-turns'
import type { TurnRecord } from './turn'

/** Longest reply text carried into a TurnRecord — parity with the two
 *  parsers this replaces (session-turns MAX_REPLY_CHARS, trace-blocks
 *  MAX_TURN_REPLY_CHARS). A different cap here would be a visible diff on
 *  every long reply. */
export const STREAM_TURN_REPLY_CHARS = 4000

/**
 * Snippet length for /trace/index titles. trace-blocks.ts's INDEX_TITLE_CHARS,
 * restated because the adapter must reproduce it EXACTLY (see traceTitleOf).
 */
export const TRACE_INDEX_TITLE_CHARS = 80

/** What a mark contributes, grouped. */
export interface StreamMarkFields {
  title?: string
  seenAt?: number
  pin?: number
  anchor?: number
  fork?: string
}

/** A checkpoint as /stream/index serves it: the stream's own facts, plus
 *  whatever is attached, in its OWN object. Grouping the marks is not
 *  cosmetic — it is what makes it impossible for a mark field to shadow
 *  `ordinal` or `file`, which is the shadowing stream-marks.ts's attach()
 *  spreads field-by-field to avoid. */
export interface StreamIndexRow extends StreamIndexEntry {
  marks?: StreamMarkFields
}

/** The five mark fields of a folded mark, or nothing when it carries none.
 *  `identity` and `at` are the ledger's own bookkeeping and never travel. */
export function markFieldsOf(mark: StreamMarkFields | undefined): StreamMarkFields | undefined {
  if (mark === undefined) return undefined
  const fields: StreamMarkFields = {
    ...(mark.title !== undefined ? { title: mark.title } : {}),
    ...(mark.seenAt !== undefined ? { seenAt: mark.seenAt } : {}),
    ...(mark.pin !== undefined ? { pin: mark.pin } : {}),
    ...(mark.anchor !== undefined ? { anchor: mark.anchor } : {}),
    ...(mark.fork !== undefined ? { fork: mark.fork } : {})
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

/**
 * One /stream/index row: the stream entry with its marks grouped under it.
 *
 * FIELDS ARE PICKED, NOT SPREAD. The materialised rows carry the projection's
 * own bookkeeping — `firstAt`, `latestAt`, `occurrences` — which is how the
 * derived index knows what it has done and is nobody else's business. A
 * spread would ship all of it to every client on every rail read and make it
 * contract by accident. `replayedIn` DOES travel, because a client that shows
 * one exchange has a right to know which transcripts hold it.
 */
export function streamIndexRowOf(
  entry: StreamIndexEntry,
  mark: StreamMarkFields | undefined
): StreamIndexRow {
  const marks = markFieldsOf(mark)
  return {
    identity: entry.identity,
    ordinal: entry.ordinal,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    promptHead: entry.promptHead,
    compacted: entry.compacted,
    file: entry.file,
    ...(entry.compaction !== undefined ? { compaction: entry.compaction } : {}),
    ...(entry.previousSessionId !== undefined
      ? { previousSessionId: entry.previousSessionId }
      : {}),
    ...(entry.rolledBack === true ? { rolledBack: true as const } : {}),
    ...(entry.replayedIn !== undefined && entry.replayedIn.length > 0
      ? { replayedIn: entry.replayedIn }
      : {}),
    ...(marks !== undefined ? { marks } : {})
  }
}

/**
 * Head-cap, character-for-character trace-blocks.ts's private `head`.
 * Restated rather than exported from there so the adapter's arithmetic is
 * readable next to the proof below.
 */
function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The /trace/index title, from the light index's promptHead.
 *
 * WHY THIS IS EXACT and not an approximation. traceIndexOf caps the prompt's
 * first non-empty line at 80; promptHeadOf caps the SAME line at 120. For any
 * line L:
 *   |L| ≤ 80   → head=L,                    head(head,80)=L                 ✓
 *   80<|L|≤120 → head=L,                    head(head,80)=L[0..79]+'…'      ✓
 *   |L| > 120  → head=L[0..119]+'…',        head(head,80)=L[0..79]+'…'      ✓
 * and an empty prompt yields '(empty prompt)' on both sides, which is under
 * 80 and passes through. So re-capping the 120-head at 80 is the same string
 * as capping the line at 80 — the adapter never has to re-read the prompt.
 */
export function traceTitleOf(promptHead: string): string {
  return head(promptHead, TRACE_INDEX_TITLE_CHARS)
}

/** A /trace/index entry from a stream index entry. */
export function traceIndexEntryOf(entry: StreamIndexEntry): TraceIndexEntry {
  return { index: entry.ordinal, id: entry.identity, title: traceTitleOf(entry.promptHead) }
}

/** The same entry from a full block — the adapter's path, where the prompt
 *  is already in hand and the head is derived rather than carried. */
export function traceIndexEntryOfBlock(block: TraceBlock & StreamBlockExtras): TraceIndexEntry {
  return {
    index: block.ordinal,
    id: block.id,
    title: traceTitleOf(promptHeadOf(block.prompt))
  }
}

/** The stream's extras on top of a TraceBlock — what a /trace answer must
 *  NOT carry, because today's does not. */
export interface StreamBlockExtras {
  ordinal: number
  compacted: boolean
  file: string
  sessionId: string
}

/**
 * A stream block projected back to exactly today's TraceBlock, with `index`
 * moved into the stream's coordinate space.
 *
 * `final` and `outcome` are passed through UNTOUCHED — the parser's own
 * evidence, not the settled tail rule. /trace has always reported what the
 * harness wrote in its file, and a Claude block has never carried `final`
 * there; inventing one here would be a diff on every card's newest block.
 */
export function traceBlockOf(block: TraceBlock & StreamBlockExtras): TraceBlock {
  return {
    id: block.id,
    index: block.ordinal,
    prompt: block.prompt,
    reply: block.reply,
    activity: block.activity,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    ...(block.final !== undefined ? { final: block.final } : {}),
    ...(block.outcome !== undefined ? { outcome: block.outcome } : {})
  }
}

/**
 * One block + its marks as a TurnRecord.
 *
 * `final` is the caller's, not the block's: positional for everything that is
 * not the tail (a later prompt in an append-only file is positive evidence
 * the earlier exchange ended — the same next-user rule both old parsers use),
 * and for the tail it is the settled rule in stream-finality.ts.
 *
 * `scrollLine` comes from the mark's `anchor`: they are the same fact (the
 * pane line a checkpoint began at), stored under the name the design gives
 * it. Omitting it would silently drop the rail's scroll sync on every card.
 */
export function turnRecordOfStreamBlock(
  block: TraceBlock & StreamBlockExtras,
  mark: StreamMarkFields | undefined,
  final: boolean
): TurnRecord {
  return {
    index: block.ordinal,
    prompt: block.prompt,
    reply: block.reply.slice(0, STREAM_TURN_REPLY_CHARS),
    uuid: block.id,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    ...(mark?.title !== undefined ? { title: mark.title } : {}),
    ...(mark?.seenAt !== undefined ? { seenAt: mark.seenAt } : {}),
    ...(mark?.anchor !== undefined ? { scrollLine: mark.anchor } : {}),
    ...(final ? { final: true } : {}),
    ...(final && block.outcome !== undefined ? { outcome: block.outcome } : {})
  }
}

/**
 * THE OTHER DIRECTION: a TurnRecord back into the stream's block shape.
 *
 * This is how a 'door' or 'scrape' card answers the stream routes. Neither
 * has a transcript this process can walk — a door's record lives at the
 * author's app, a scrape card's record is the PTY — but both already hand out
 * one continuous, un-rotated history, so `ordinal` is the record's own index
 * and there is no compaction to attribute. The identity is the record's uuid,
 * or the SAME derived digest the renderer computes today, so a mark written
 * against a scrape card keeps pointing at the same exchange.
 */
export function blockOfRecord(record: TurnRecord): TraceBlock & StreamBlockExtras {
  return {
    id: record.uuid ?? checkpointIdentity({ index: record.index, prompt: record.prompt }),
    index: record.index,
    ordinal: record.index,
    prompt: record.prompt,
    reply: record.reply,
    activity: [],
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    compacted: false,
    file: '',
    sessionId: '',
    ...(record.final !== undefined ? { final: record.final } : {}),
    ...(record.outcome === 'failed' || record.outcome === 'interrupted'
      ? { outcome: record.outcome }
      : {})
  }
}

/** The light index row of a block that came from a record (no file, no
 *  compaction — there is nothing for either to describe). */
export function entryOfRecordBlock(block: TraceBlock & StreamBlockExtras): StreamIndexEntry {
  return {
    identity: block.id,
    ordinal: block.ordinal,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    promptHead: promptHeadOf(block.prompt),
    compacted: false,
    file: ''
  }
}

/**
 * A whole window of blocks as TurnRecords. `tailFinal` applies ONLY when the
 * window's last block is also the stream's last block — a page from the
 * middle of a history is entirely closed by the next-user rule.
 */
export function turnRecordsOfStream(
  blocks: readonly (TraceBlock & StreamBlockExtras)[],
  marks: (identity: string) => StreamMarkFields | undefined,
  options: { total: number; tailFinal: boolean }
): TurnRecord[] {
  return blocks.map((block) =>
    turnRecordOfStreamBlock(
      block,
      marks(block.id),
      block.ordinal < options.total ? true : options.tailFinal
    )
  )
}
