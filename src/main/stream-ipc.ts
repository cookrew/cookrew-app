// THE STREAM, FOR THE DESKTOP RENDERER (one-stream T3).
//
// WHY THIS EXISTS AT ALL. T2 put the stream behind HTTP, which is the wire the
// COMPANION has. The desktop renderer has no origin to fetch — `cookrew()` is
// the preload bridge and every read is an IPC invoke — so "the renderer reads
// one stream" would have been true of the phone and false of the Mac, and the
// desktop rail would have rendered nothing at all.
//
// ONE READER, TWO DOORS. Every answer below is built from the SAME
// StreamService the routes use, through the same projections in
// shared/stream-turns.ts. Nothing is re-derived here; if this file and
// stream-routes.ts ever disagree, one of them is doing arithmetic it should
// have imported.
//
// A DOOR OR SCRAPE CARD ANSWERS TOO. Its record lives at someone else's app,
// or only on a PTY, so there is no transcript this process can walk — but it
// already hands out one continuous history, and reshaping that into the same
// contract is what lets the renderer hold ONE code path for every card. That
// is the entire point of naming this "one stream".

import {
  blockOfRecord,
  entryOfRecordBlock,
  markFieldsOf,
  streamIndexRowOf,
  type StreamIndexRow,
  type StreamMarkFields
} from '../shared/stream-turns'
import type { StreamBlock } from './stream'
import type { StreamService } from './stream-service'
import type { TurnRecord } from '../shared/turn'
import type { TranscriptSource } from './transcript-source'

/** Rows the open carries. The newest screenful and a cursor for the rest —
 *  never the whole chain, which on one measured card is 400 MB of files. */
export const STREAM_OPEN_ROWS = 100

/** Default window for a block page, matching the pager's own. */
const BLOCK_LIMIT = 20

export interface StreamIpcDeps {
  stream: StreamService
  /** The door/scrape fallback — the SAME provider the old routes use. */
  turnHistory: (terminalId: string) => Promise<TurnRecord[]>
}

export interface StreamOpenAnswer {
  index: StreamIndexRow[]
  tail: { block: StreamBlock | null; final: boolean; ordinal: number | null; total: number } | null
  backwardsCursor: string | null
  source: TranscriptSource
  anomalies: Record<string, number>
  rolledBack: { fromOrdinal: number; at: number }[]
}

export interface StreamCursorRequest {
  after?: string
  before?: string
  limit?: number
}

function limitOf(request: StreamCursorRequest | undefined, fallback: number): number {
  const raw = request?.limit
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.floor(raw), 500)
    : fallback
}

/**
 * Every row of a card's stream, with its marks — the one join, already done.
 *
 * Door and scrape cards go through the same shape as a file card. `missing`
 * and `orphanMarks` come back as ANOMALY COUNTS rather than being dropped: a
 * chain member with no transcript and a mark the stream cannot place are both
 * evidence that something moved, and swallowing either is precisely how
 * history looked destroyed when it was merely unindexed.
 */
async function allRows(
  terminalId: string,
  source: TranscriptSource,
  deps: StreamIpcDeps
): Promise<{ rows: StreamIndexRow[]; anomalies: Record<string, number> }> {
  const marks = deps.stream.marks(terminalId)
  const anomalies: Record<string, number> = {}
  if (source === 'file') {
    const { checkpoints, missing, orphanMarks } = await deps.stream.checkpoints(terminalId)
    if (missing.length > 0) anomalies.missingFile = missing.length
    if (orphanMarks.length > 0) anomalies.orphanMark = orphanMarks.length
    return {
      rows: checkpoints.map((entry) => streamIndexRowOf(entry, marks.get(entry.identity))),
      anomalies
    }
  }
  const blocks = (await deps.turnHistory(terminalId)).map(blockOfRecord)
  const placed = new Set(blocks.map((block) => block.id))
  const orphans = [...marks.keys()].filter((identity) => !placed.has(identity))
  if (orphans.length > 0) anomalies.orphanMark = orphans.length
  return {
    rows: blocks.map((block) => streamIndexRowOf(entryOfRecordBlock(block), marks.get(block.id))),
    anomalies
  }
}

/** The whole first paint in one call: newest rows, the tail, the cursors. */
export async function streamOpen(
  terminalId: string,
  deps: StreamIpcDeps
): Promise<StreamOpenAnswer | null> {
  const source = deps.stream.sourceOf(terminalId)
  if (source === null) return null
  const { rows, anomalies } = await allRows(terminalId, source, deps)
  const from = Math.max(0, rows.length - STREAM_OPEN_ROWS)
  const page = rows.slice(from)
  return {
    index: page,
    tail: await streamTail(terminalId, deps),
    // A cursor ONLY when there is genuinely more behind this page. Handing
    // back a cursor at the stream's oldest would leave the rail paging
    // forever against an answer that never grows.
    backwardsCursor: from > 0 ? (page[0]?.identity ?? null) : null,
    source,
    anomalies,
    // T2.5 owns the rollback ledger; until it lands this process has no note
    // to report, and reporting an empty list is the honest answer rather than
    // pretending the field does not exist.
    rolledBack: []
  }
}

/** A page of rows, backwards or forwards from an identity. */
export async function streamIndex(
  terminalId: string,
  request: StreamCursorRequest,
  deps: StreamIpcDeps
): Promise<{
  checkpoints: StreamIndexRow[]
  nextCursor: string | null
  backwardsCursor: string | null
  total: number
}> {
  const source = deps.stream.sourceOf(terminalId)
  if (source === null) {
    return { checkpoints: [], nextCursor: null, backwardsCursor: null, total: 0 }
  }
  const { rows } = await allRows(terminalId, source, deps)
  const limit = limitOf(request, STREAM_OPEN_ROWS)
  if (request.before !== undefined) {
    const at = rows.findIndex((row) => row.identity === request.before)
    // An unknown cursor is an EMPTY page, not the start of the stream: a
    // cursor that silently resolves to the wrong place is how a pager
    // duplicates or skips a page.
    if (at < 0) return { checkpoints: [], nextCursor: null, backwardsCursor: null, total: rows.length }
    const from = Math.max(0, at - limit)
    const page = rows.slice(from, at)
    return {
      checkpoints: page,
      nextCursor: null,
      backwardsCursor: from > 0 ? (page[0]?.identity ?? null) : null,
      total: rows.length
    }
  }
  if (request.after !== undefined) {
    const at = rows.findIndex((row) => row.identity === request.after)
    if (at < 0) return { checkpoints: [], nextCursor: null, backwardsCursor: null, total: rows.length }
    const page = rows.slice(at + 1, at + 1 + limit)
    return {
      checkpoints: page,
      nextCursor: page[page.length - 1]?.identity ?? null,
      backwardsCursor: null,
      total: rows.length
    }
  }
  const page = rows.slice(Math.max(0, rows.length - limit))
  return {
    checkpoints: page,
    nextCursor: null,
    backwardsCursor: rows.length > page.length ? (page[0]?.identity ?? null) : null,
    total: rows.length
  }
}

/** A window of FULL blocks, by identity — never the whole chain. */
export async function streamBlocks(
  terminalId: string,
  request: StreamCursorRequest,
  deps: StreamIpcDeps
): Promise<{
  blocks: StreamBlock[]
  marks: Record<string, StreamMarkFields>
  total: number
  unknownAfter?: true
  unknownBefore?: true
}> {
  const source = deps.stream.sourceOf(terminalId)
  if (source === null) return { blocks: [], marks: {}, total: 0 }
  const marks = deps.stream.marks(terminalId)
  const limit = limitOf(request, BLOCK_LIMIT)
  const withMarks = (
    blocks: StreamBlock[],
    total: number,
    flags: { unknownAfter?: true; unknownBefore?: true } = {}
  ): {
    blocks: StreamBlock[]
    marks: Record<string, StreamMarkFields>
    total: number
    unknownAfter?: true
    unknownBefore?: true
  } => {
    const out: Record<string, StreamMarkFields> = {}
    for (const block of blocks) {
      const fields = markFieldsOf(marks.get(block.id))
      if (fields !== undefined) out[block.id] = fields
    }
    return { blocks, marks: out, total, ...flags }
  }
  if (source === 'file') {
    const page = await deps.stream.blocks(terminalId, {
      ...(request.after !== undefined ? { after: request.after } : {}),
      ...(request.before !== undefined ? { before: request.before } : {}),
      limit
    })
    return withMarks(page.blocks, page.total, {
      ...(page.unknownAfter === true ? { unknownAfter: true as const } : {}),
      ...(page.unknownBefore === true ? { unknownBefore: true as const } : {})
    })
  }
  const all = (await deps.turnHistory(terminalId)).map(blockOfRecord) as StreamBlock[]
  if (request.after !== undefined) {
    const at = all.findIndex((block) => block.id === request.after)
    if (at < 0) return withMarks([], all.length, { unknownAfter: true })
    return withMarks(all.slice(at + 1, at + 1 + limit), all.length)
  }
  if (request.before !== undefined) {
    const at = all.findIndex((block) => block.id === request.before)
    if (at < 0) return withMarks([], all.length, { unknownBefore: true })
    return withMarks(all.slice(Math.max(0, at - limit), at), all.length)
  }
  return withMarks(all.slice(0, limit), all.length)
}

/** The open exchange, with the settled finality rule applied. */
export async function streamTail(
  terminalId: string,
  deps: StreamIpcDeps
): Promise<StreamOpenAnswer['tail']> {
  const source = deps.stream.sourceOf(terminalId)
  if (source === null) return null
  if (source === 'file') {
    const state = await deps.stream.tailState(terminalId)
    return {
      block: state.block,
      final: state.final,
      ordinal: state.block?.ordinal ?? null,
      total: state.total
    }
  }
  const history = await deps.turnHistory(terminalId)
  const last = history[history.length - 1]
  if (last === undefined) return { block: null, final: false, ordinal: null, total: 0 }
  const block = blockOfRecord(last) as StreamBlock
  return { block, final: last.final === true, ordinal: block.ordinal, total: history.length }
}

/** Every folded mark for a card, so the bridge's live pass can diff them. */
export function streamMarks(
  terminalId: string,
  deps: StreamIpcDeps
): Record<string, StreamMarkFields> {
  const out: Record<string, StreamMarkFields> = {}
  for (const [identity, mark] of deps.stream.marks(terminalId)) {
    const fields = markFieldsOf(mark)
    if (fields !== undefined) out[identity] = fields
  }
  return out
}
