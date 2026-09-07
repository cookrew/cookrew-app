// THE ONE STREAM (design: docs/site/one-stream-2026-09-07.html, phase T1).
//
// A card's transcripts read as ONE conversation: the lineage's files oldest
// first, each parsed by the accumulator that already exists, through the
// windowed append-only cache that already exists (trace.ts), with a single
// ordinal running through the whole chain.
//
// WHAT THIS REPLACES, AND WHY IT HAD TO. Today the same conversation is
// derived twice from the same file — once into TurnRecords that are STORED
// (a second copy of every prompt and reply), once into TraceBlocks that are
// not — and the renderer joins the two by an identity that can drift. Every
// checkpoint incident this codebase has had comes off that split:
//
//   · the 400+ checkpoints that went unaddressable at a compaction, because
//     each file numbered its own T1..Tn and the stored ledger renumbered
//     across the boundary after the fact (session-lineage-walk.ts, ledger-rebuild.ts);
//   · the 2026-09-06 cap that would have dropped a session id — and with it a
//     whole transcript — off the only list that could reach it;
//   · the phantom rail rows the renderer "clamps around" when a stored record
//     pairs with no block.
//
// The ordinal here is DERIVED, never stored, and never restarts. A compaction
// is an attribute of the block after it. There is no second copy to drift.
//
// NEVER THE WHOLE CHAIN. One measured chain is 119 + 91 + 91 + 71 MB. Blocks
// come from trace.ts's per-file cache (appended bytes only after the first
// read); the light index is derived once per file and keyed by (file, byte
// offset), so an append extends it and a shrink — a /rewind truncation —
// rebuilds that one file. A window materialises only the blocks in it.
//
// NEVER THROWS FOR A MISSING FILE. A chain member with no transcript on disk,
// or one that vanishes mid-read, comes back in `missing`. A card whose oldest
// predecessor was deleted still shows every checkpoint it can still reach —
// the opposite of the failure that made 400 checkpoints look destroyed.

import { existsSync } from 'node:fs'
import {
  fileEntriesOf,
  streamPositionsOf,
  type CompactionFacts,
  type FileEntry,
  type StreamIndexEntry,
  type StreamPosition
} from '../shared/stream-index'
import type { TraceBlock } from '../shared/trace-blocks'
import type { AnomalyCounts, StreamLine } from '../shared/stream-projection'
import { collapseByIdentity } from '../shared/stream-replay'
import { placeUndeclared } from './stream-placement'
import { evictOverBudget, type TraceDocument, type TraceKind } from './trace'
import type { MissingStreamFile, StreamChain } from './stream-chain'
import type { RollbackMark } from './stream-state'

/** Files whose derived index stays memoized. Mirrors trace.ts's file memo:
 *  an evicted file re-derives once from blocks that are already cached. */
const STREAM_INDEX_MEMO_CAP = 128

/** Window size when a caller does not ask for one (parity with the pager). */
export const STREAM_PAGE_DEFAULT_LIMIT = 20

export interface StreamReaderDeps {
  /** The files that ARE this card's stream, oldest first (stream-chain.ts). */
  chainOf: (terminalId: string) => Promise<StreamChain>
  /** One file's parsed document, through trace.ts's windowed cache. */
  documentOf: (file: string, kind: TraceKind) => Promise<TraceDocument>
  /** Injected for tests; production is fs.existsSync. */
  exists?: (file: string) => boolean
}

/** A block with its place in the whole stream. The TraceBlock fields are
 *  unchanged — this design keeps today's block shape exactly. */
export interface StreamBlock extends TraceBlock {
  /** 1-based position in the WHOLE chain. Never restarts at a compaction. */
  ordinal: number
  /** First block after a compaction boundary (declared, or a file rotation). */
  compacted: boolean
  /** What the declared boundary said about itself (T2: the rail's ◆ shows
   *  these, and /trace/markers is one of the routes that adapt over this). */
  compaction?: CompactionFacts
  /** The session this block's file rotated out of — the ⇥ marker's pointer. */
  previousSessionId?: string
  file: string
  sessionId: string
}

export interface StreamIndexResult {
  entries: StreamIndexEntry[]
  /** Chain members with no readable transcript. Reported, never thrown. */
  missing: MissingStreamFile[]
  /** What the materialised path skipped, by class. Absent on the raw reader,
   *  which has no state to count into (stream-materialise.ts, T2.5). */
  anomalies?: AnomalyCounts
  /** Rewinds this card has taken, appended (stream-state.ts, T2.5). */
  rolledBack?: RollbackMark[]
}

/**
 * The chain as CANONICAL LINES — the seam the stateless projection reads
 * (one-stream T2.5, panel C ①).
 *
 * Same walk as `index`, handed over one record at a time with the byte offset
 * each record was derived from, so a cursor can address it. `byteOffset` is
 * the file's ingested prefix rather than the record's own start, because the
 * parsers this reader composes do not carry per-record offsets — so the cursor
 * advances at FILE granularity and the ordinal at record granularity, which is
 * exactly enough to replay a suffix without re-reading a chain.
 */
export interface StreamLinesResult {
  lines: StreamLine[]
  /** The chain's files in order, with the prefix each was read from —
   *  INCLUDING files that contributed no records, because a cursor is
   *  addressed against a file and not against a record. */
  files: { file: string; bytesRead: number }[]
  missing: MissingStreamFile[]
}

export interface StreamBlocksRequest {
  /** Return the blocks AFTER this identity. Omitted starts at the stream's
   *  oldest block — a cursor walk forward, which is what /stream?after= is. */
  after?: string
  /**
   * Return the `limit` blocks BEFORE this identity — the drawer scrolling UP,
   * which is the direction a transcript is actually read (T2). Symmetric with
   * `after` on purpose: a window is named by an identity at one of its ends,
   * never by an array offset, so a page cannot shift under a caller when the
   * stream grows. `after` wins if both are given.
   */
  before?: string
  limit?: number
}

export interface StreamBlocksResult {
  blocks: StreamBlock[]
  /** Length of the whole stream, so a virtualizer can size itself. */
  total: number
  missing: MissingStreamFile[]
  /** The cursor named an identity this stream does not hold. Said out loud
   *  rather than silently falling back to the start — a cursor that resolves
   *  to the wrong place is how a pager duplicates or skips a page. */
  unknownAfter?: true
  /** Same, for the backward cursor. */
  unknownBefore?: true
}

export interface StreamTailResult {
  /**
   * The stream's LAST block, open or closed; null only for an empty stream.
   *
   * T1 returned this only while the tail was open, and T2 changed it — the
   * block always travels now, with `open` saying what it is. A subscriber
   * that has just watched a turn finish must be able to render the finished
   * exchange without a second round trip, and nulling the block made "the
   * turn ended" indistinguishable from "there is nothing here".
   *
   * `open` is the harness's own evidence, and only Codex and Pi write it into
   * the block shape (TraceBlock.final — `task_complete`/`turn_aborted`,
   * pi's terminal stopReasons). Claude's end-of-turn marker (`stop_reason:
   * "end_turn"`) is read by session-turns.ts and is NOT projected onto trace
   * blocks, so a Claude tail always reads as open HERE — stream-finality.ts
   * settles it at the tail, and StreamTailState.final is the answer.
   */
  block: StreamBlock | null
  open: boolean
  missing: MissingStreamFile[]
  /**
   * How many bytes of `block.file` this exchange spans, from its own opening
   * record to EOF (T5 QA 2026-09-07 — TraceDocument.tailBlockBytes).
   *
   * The finality window. Absent when the reader cannot vouch for it: a
   * non-Claude parser, or a tail block that is NOT its file's last block
   * (a replay collapsed onto a newer copy). Absent falls back to the fixed
   * tail window, which is what shipped before this existed.
   */
  tailBytes?: number
}

export interface StreamReader {
  index(terminalId: string): Promise<StreamIndexResult>
  lines(terminalId: string): Promise<StreamLinesResult>
  blocks(terminalId: string, request?: StreamBlocksRequest): Promise<StreamBlocksResult>
  tail(terminalId: string): Promise<StreamTailResult>
}

/** One chain member as loaded: its blocks, and the light entries over them. */
interface LoadedFile {
  file: string
  sessionId: string
  blocks: readonly TraceBlock[]
  entries: readonly FileEntry[]
  /** The byte prefix these entries were derived from — trace.ts publishes it
   *  so a derived index can be keyed by (file, offset) and a cursor can
   *  address it. */
  bytesRead: number
  /** The rotation walk named this file (stream-chain.ts). */
  declared: boolean
  /** This file's first block's clock, or null when it holds none. */
  startedAt: number | null
  /** The byte span of this file's LAST block (TraceDocument.tailBlockBytes). */
  tailBlockBytes?: number
}

/** The (file, byte offset) key the light index is cached under. */
interface IndexMemo {
  bytesRead: number
  entries: FileEntry[]
}

export function createStreamReader(deps: StreamReaderDeps): StreamReader {
  const exists = deps.exists ?? existsSync
  const memo = new Map<string, IndexMemo>()

  /**
   * The light entries for one file, EXTENDED rather than rebuilt.
   *
   * Same offset → the cached entries, untouched. Grown → re-derive from the
   * previous tail (an append can rewrite the open block in place and adds
   * blocks past it) and splice. Shrunk → a /rewind truncated the file, and
   * everything derived from the removed bytes is void: rebuild, which is
   * exactly the contract trace.ts's own cache follows on a shrink.
   */
  const entriesOf = (file: string, document: TraceDocument): FileEntry[] => {
    const cached = memo.get(file)
    if (cached && cached.bytesRead === document.bytesRead) {
      touch(memo, file, cached)
      return cached.entries
    }
    if (cached && document.bytesRead > cached.bytesRead) {
      const from = Math.max(0, cached.entries.length - 1)
      const entries = [
        ...cached.entries.slice(0, from),
        ...fileEntriesOf(document.blocks, document.markers, from)
      ]
      touch(memo, file, { bytesRead: document.bytesRead, entries })
      return entries
    }
    const entries = fileEntriesOf(document.blocks, document.markers)
    touch(memo, file, { bytesRead: document.bytesRead, entries })
    return entries
  }

  const load = async (
    terminalId: string
  ): Promise<{ files: LoadedFile[]; missing: MissingStreamFile[] }> => {
    let chain: StreamChain
    try {
      chain = await deps.chainOf(terminalId)
    } catch {
      // A chain that cannot be resolved is an empty stream with the reason
      // reported — never an exception into a rail render.
      return {
        files: [],
        missing: [
          {
            sessionId: terminalId,
            file: '',
            reason: 'unreadable'
          }
        ]
      }
    }
    const missing = [...chain.missing]
    const files: LoadedFile[] = []
    for (const ref of chain.files) {
      let document: TraceDocument
      try {
        document = await deps.documentOf(ref.file, ref.kind)
      } catch {
        missing.push({ sessionId: ref.sessionId, file: ref.file, reason: 'unreadable' })
        continue
      }
      if (document.blocks.length === 0 && document.bytesRead === 0 && !exists(ref.file)) {
        // It was there when the chain was resolved and is not there now.
        missing.push({ sessionId: ref.sessionId, file: ref.file, reason: 'no-transcript' })
        continue
      }
      files.push({
        file: ref.file,
        sessionId: ref.sessionId,
        blocks: document.blocks,
        entries: entriesOf(ref.file, document),
        bytesRead: document.bytesRead,
        declared: ref.declared === true,
        startedAt: document.blocks[0]?.startedAt ?? null,
        ...(document.tailBlockBytes !== undefined
          ? { tailBlockBytes: document.tailBlockBytes }
          : {})
      })
    }
    return { files: placeUndeclared(files), missing }
  }

  const walkOf = async (
    terminalId: string
  ): Promise<{ files: LoadedFile[]; positions: StreamPosition[]; missing: MissingStreamFile[] }> => {
    const { files, missing } = await load(terminalId)
    return { files, positions: streamPositionsOf(files), missing }
  }

  /**
   * The walk with each exchange drawn ONCE (stream-replay.ts).
   *
   * Every read a caller renders goes through this; only `lines()` sees the
   * raw walk, because the projection has to be shown the repeat in order to
   * record which files hold it. Collapsing here rather than in the routes is
   * what makes `total`, the rail and the block cursors agree by construction:
   * `/stream?after=<identity>` resolves to exactly one position, and that
   * position is in the NEWEST file that holds the exchange.
   */
  const positionsOf = async (
    terminalId: string
  ): Promise<{ files: LoadedFile[]; positions: StreamPosition[]; missing: MissingStreamFile[] }> => {
    const { files, positions, missing } = await walkOf(terminalId)
    return { files, positions: collapseByIdentity(positions).positions, missing }
  }

  const blockAt = (files: readonly LoadedFile[], position: StreamPosition): StreamBlock => {
    const file = files[position.fileAt]
    const block = file.blocks[position.localAt]
    // A NEW object every time: the cached block is shared state the parsers
    // extend in place, and this codebase's rule is that nothing derived
    // mutates what it read.
    return {
      ...block,
      ordinal: position.entry.ordinal,
      compacted: position.entry.compacted,
      ...(position.entry.compaction !== undefined
        ? { compaction: position.entry.compaction }
        : {}),
      ...(position.entry.previousSessionId !== undefined
        ? { previousSessionId: position.entry.previousSessionId }
        : {}),
      file: file.file,
      sessionId: file.sessionId
    }
  }

  return {
    async index(terminalId) {
      const { positions, missing } = await positionsOf(terminalId)
      return { entries: positions.map((position) => position.entry), missing }
    },

    async lines(terminalId) {
      // THE RAW WALK, repeats included: the projection is the layer that
      // records which files hold an exchange, and it cannot record a copy it
      // was never shown.
      const { files, positions, missing } = await walkOf(terminalId)
      return {
        lines: positions.map((position) => ({
          file: position.entry.file,
          byteOffset: files[position.fileAt].bytesRead,
          // The record's own clock reading, which becomes the projection's
          // first/latest pair. `endedAt` and not `startedAt`: an open block's
          // end MOVES as the reply grows, and that movement is exactly the
          // "latest" the upsert guard is meant to follow.
          at: position.entry.endedAt,
          ordinal: position.entry.ordinal,
          ordinalInFile: position.localAt,
          entry: position.entry
        })),
        files: files.map((file) => ({ file: file.file, bytesRead: file.bytesRead })),
        missing
      }
    },

    async blocks(terminalId, request = {}) {
      const { files, positions, missing } = await positionsOf(terminalId)
      const limit = Math.max(1, request.limit ?? STREAM_PAGE_DEFAULT_LIMIT)
      const total = positions.length
      const window = (from: number, to: number): StreamBlock[] =>
        positions.slice(from, to).map((p) => blockAt(files, p))
      if (request.after !== undefined) {
        const at = positions.findIndex((position) => position.entry.identity === request.after)
        if (at < 0) return { blocks: [], total, missing, unknownAfter: true }
        return { blocks: window(at + 1, at + 1 + limit), total, missing }
      }
      if (request.before !== undefined) {
        const at = positions.findIndex((position) => position.entry.identity === request.before)
        if (at < 0) return { blocks: [], total, missing, unknownBefore: true }
        // SHORT at the start rather than shifted forward: a virtualizer that
        // asked for the page before block 3 must never be handed block 4.
        return { blocks: window(Math.max(0, at - limit), at), total, missing }
      }
      return { blocks: window(0, limit), total, missing }
    },

    async tail(terminalId) {
      const { files, positions, missing } = await positionsOf(terminalId)
      const last = positions[positions.length - 1]
      if (last === undefined) return { block: null, open: false, missing }
      const block = blockAt(files, last)
      // THE SPAN IS ONLY CLAIMED WHEN IT IS THIS BLOCK'S. `tailBlockBytes`
      // describes a FILE's last block; the stream's tail is normally the same
      // record, but a replay collapsed onto a newer copy can leave it
      // elsewhere. Claiming a neighbour's span would aim the finality read at
      // the wrong exchange, so it is simply omitted and the fixed window
      // stands.
      const file = files[last.fileAt]
      const ownSpan =
        file !== undefined &&
        file.tailBlockBytes !== undefined &&
        last.localAt === file.blocks.length - 1
      return {
        block,
        open: block.final !== true,
        missing,
        ...(ownSpan ? { tailBytes: file.tailBlockBytes as number } : {})
      }
    }
  }
}

/** Insertion order IS recency here (delete + set), matching trace.ts's memos:
 *  an evicted file costs one re-derivation over blocks that are still cached. */
function touch(memo: Map<string, IndexMemo>, file: string, value: IndexMemo): void {
  if (memo.has(file)) memo.delete(file)
  memo.set(file, value)
  evictOverBudget(memo, () => 0, {
    maxCount: STREAM_INDEX_MEMO_CAP,
    maxBytes: Infinity,
    keepNewest: 1
  })
}
