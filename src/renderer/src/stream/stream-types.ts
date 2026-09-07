// ONE STREAM, AS THE VIEW SEES IT (design: docs/site/one-stream-2026-09-07.html
// phase T3, and one-stream-v2-compare panel C "视图 v2").
//
// The wire shapes and nothing else. They are declared HERE rather than
// imported from src/main because the view must never reach into the reader:
// panel C's rule is that live and replay go through ONE rendering path and the
// view NEVER parses a file. A type imported from the reader is a small door
// back into that habit — the next reader change would edit the view's types,
// and the view would start believing it knows how a transcript is stored.
//
// Everything here is what `/api/terminal/:id/stream*` answers, verbatim.

import type { TraceBlock } from '../../../shared/trace-blocks'

/** What a person or Sous attached to a position — never conversation text. */
export interface StreamMarks {
  title?: string
  seenAt?: number
  pin?: number
  anchor?: number
  fork?: string
}

/**
 * One rail row: the stream's own facts about a position, plus its marks.
 *
 * `ordinal` is the block's 1-based place in the WHOLE chain and never
 * restarts at a compaction — it is the number the rail draws as T<n>, and the
 * reason the 400+ checkpoints a rotation once made unaddressable are
 * addressable again.
 */
export interface StreamCheckpoint {
  identity: string
  ordinal: number
  startedAt: number
  endedAt: number
  promptHead: string
  compacted: boolean
  file: string
  /** A /rewind cut this position away. APPENDED, never removed (panel C ②):
   *  a rolled-back checkpoint stays addressable and stays selectable. */
  rolledBack?: true
  marks?: StreamMarks
  /** What a declared compaction boundary said about itself, when it did. */
  compaction?: { preTokens?: number; postTokens?: number }
  /** The session this block's file rotated out of — the ⇥ marker's pointer. */
  previousSessionId?: string
}

/** One exchange, in full. Identical to today's TraceBlock plus its place in
 *  the stream — the design keeps the block shape exactly. */
export interface StreamBlock extends TraceBlock {
  ordinal: number
  compacted: boolean
  file: string
  sessionId: string
  compaction?: { preTokens?: number; postTokens?: number }
  previousSessionId?: string
}

/** The open exchange, as `/stream/live` pushes it and `/stream/open` seeds it. */
export interface StreamTail {
  block: StreamBlock | null
  final: boolean
  ordinal: number | null
  total: number
  /**
   * The tail's own marks, on the ONE-SHOT tail read only.
   *
   * A card preview shows the Sous title, and a title is a mark — so a tail
   * fetched for a preview has to carry it or the preview would need a second
   * read to find out what the turn is called. The live `tail` event does not
   * set this: on a subscription the `mark` event is what carries a title, and
   * two sources for one fact is the drift this design exists to remove.
   */
  marks?: StreamMarks
}

/** Where a card's record comes from. 'file' walks a transcript; 'door' and
 *  'scrape' answer the same contract from a provider that has no file. */
export type TranscriptSource = 'file' | 'door' | 'scrape'

/**
 * `GET /stream/open` — the whole first paint in one round trip.
 *
 * The rail used to cost two fetches and a join; this is the answer that
 * replaces both. `anomalies` and `rolledBack` ride along DELIBERATELY (panel
 * C ③): a line the stream could not read is counted and reported, never
 * thrown and never silently dropped, because a silently shorter history is
 * exactly what "400 checkpoints were destroyed" looked like.
 */
export interface StreamOpen {
  index: StreamCheckpoint[]
  tail: StreamTail | null
  backwardsCursor: string | null
  source: TranscriptSource
  anomalies: Record<string, number>
  rolledBack: RollbackNote[]
}

/** A /rewind, as the index records it: appended, addressed by ordinal. */
export interface RollbackNote {
  fromOrdinal: number
  at: number
}

/** `GET /stream/index?before=|after=&limit=` */
export interface StreamIndexPage {
  checkpoints: StreamCheckpoint[]
  nextCursor?: string | null
  backwardsCursor?: string | null
  total?: number
}

/** `GET /stream?after=|before=&limit=` */
export interface StreamBlockPage {
  blocks: StreamBlock[]
  marks?: Record<string, StreamMarks>
  total?: number
  unknownAfter?: true
  unknownBefore?: true
  source?: TranscriptSource
}

/**
 * `PUT /stream/marks` — the ONLY write in this design.
 *
 * Every field is `| null` because CLEARING has to be expressible: a title
 * withdrawn and a title never written are different facts, and a patch that
 * could only set would make an un-pinned checkpoint impossible to say
 * (marks.ts makes the same distinction, for the same reason).
 */
export interface MarkPatch {
  identity: string
  title?: string | null
  seenAt?: number | null
  pin?: number | null
  anchor?: number | null
  fork?: string | null
}

/** What the live subscription is doing, as the rail reports it to a person. */
export type LiveState = 'connected' | 'reconnecting' | 'off'

/**
 * WHERE A BLOCK CAME FROM, and the only thing that distinguishes live from
 * replay in the whole view (panel C, "视图 v2").
 *
 * Both go through the same rendering path — same view model, same markup. The
 * flag suppresses SIDE EFFECTS on replay: a page fetched because someone
 * scrolled up must not steal the scroll position or announce itself, while
 * the same block arriving as a live tail should.
 */
export type StreamRenderSource = 'live' | 'replay'

/** Cursor arguments shared by the index and block pagers. */
export interface StreamCursor {
  after?: string
  before?: string
  limit?: number
}
