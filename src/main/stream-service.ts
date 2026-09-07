// THE ONE READER, AS THE ROUTES SEE IT (one-stream T2).
//
// T1 built the pieces: stream-chain.ts decides WHICH files are the stream,
// stream.ts reads them as one, marks.ts stores the only thing that is not in
// them, stream-marks.ts performs the single join. This module composes those
// four into the one object the HTTP layer depends on, so that:
//
//   · mobile-api.ts gains ONE dep, not five, and the routes stay testable
//     against a hand-built service with no disk under it;
//   · the composition — which chain a non-Claude harness has, where the marks
//     ledger lives, how a tail's finality is settled — is decided once, here,
//     instead of once per route.
//
// WHAT IS NOT HERE. 'door' and 'scrape' cards. They have no transcript this
// process can read (a door's record lives at someone else's app; a scrape
// card's record is the PTY and nothing else), so `sourceOf` reports them and
// the routes answer them from the SAME providers the old routes use. That is
// the design's own line: "for a harness with no file ('scrape' in
// transcript-source.ts) the PTY tracker still provides it — that is the one
// place scraping remains."

import { existsSync } from 'node:fs'
import { isClaudeCommand } from '../shared/claude-fork'
import { isCodexCommand } from './codex-bind'
import { isPiCommand } from './pi-bind'
import { restorePointIndex } from '../shared/model'
import type { TerminalNodeData } from '../shared/model'
import { claudeStreamChain, type ChainOptions, type StreamChain } from './stream-chain'
import {
  createStreamReader,
  type StreamBlocksRequest,
  type StreamBlocksResult,
  type StreamReaderDeps,
  type StreamTailResult
} from './stream'
import { createCheckpointReader, type CheckpointsResult } from './stream-marks'
import {
  markFileFor,
  readMarks,
  writeMark,
  type Mark,
  type MarkOptions,
  type MarkPatch,
  type MarkResult
} from './marks'
import { createStreamIndexStore, type MaterialisedIndex } from './stream-materialise'
import {
  readStreamState,
  writeStreamState,
  type RollbackMark,
  type StreamStateOptions
} from './stream-state'
import { tailIsFinal, type FinalityDeps } from './stream-finality'
import { transcriptSourceFor, type TranscriptSource } from './transcript-source'
import type { TraceDocument, TraceKind } from './trace'

/** The tail, with the finality question answered. */
export interface StreamTailState extends StreamTailResult {
  /**
   * The settled rule (stream-finality.ts). Note it is NOT simply `!open`:
   * `open` is the raw block evidence T1 could see, `final` is that plus
   * Claude's end-of-turn marker read from the tail. A tail with neither is
   * open-and-not-final; there is no third state.
   */
  final: boolean
  /** Which parser the tail file is read with; null for an empty stream. */
  kind: TraceKind | null
  /** Length of the whole stream, so a live subscriber can size the rail. */
  total: number
}

/** The HTTP layer's whole view of the stream. */
export interface StreamService {
  /** Where this card's record comes from, or null when no such terminal is
   *  known — the 404 the new routes answer with. */
  sourceOf(terminalId: string): TranscriptSource | null
  /** Which transcripts ARE this card's stream (the live route stats the tail
   *  of this; the /trace adapter reads its kind off it). */
  chain(terminalId: string): Promise<StreamChain>
  /** The one join: positions + what is attached to them. */
  checkpoints(terminalId: string): Promise<CheckpointsResult>
  /** A window of blocks, by identity, never the whole chain. */
  blocks(terminalId: string, request?: StreamBlocksRequest): Promise<StreamBlocksResult>
  /** The stream's last block with the settled finality rule applied. */
  tailState(terminalId: string): Promise<StreamTailState>
  marks(terminalId: string): Map<string, Mark>
  writeMark(terminalId: string, patch: MarkPatch): MarkResult
  /** The ledger's path, so the live route can watch it. Null for an id that
   *  cannot safely name a file. */
  marksFile(terminalId: string): string | null
  /** Checkpoint ordinals this card was rewound TO (node.restoreStack) — the
   *  ⟲ markers /trace/markers has always carried. */
  rewindPoints(terminalId: string): number[]
  /**
   * The materialised index behind `checkpoints` (T2.5). OPTIONAL so a test
   * double — or a service composed without a state directory — is still a
   * StreamService; every caller must be able to answer without it.
   */
  materialised?(terminalId: string): Promise<MaterialisedIndex>
  /** Every /rewind this card has taken, appended, oldest first. The live
   *  route diffs this to emit its `rollback` event. */
  rollbacks?(terminalId: string): Promise<RollbackMark[]>
}

export interface StreamServiceDeps {
  /** The node behind a terminal id, across workspaces. Null = unknown card. */
  nodeOf: (terminalId: string) => TerminalNodeData | null
  /** One file's parsed document, through trace.ts's windowed cache. */
  documentOf: (file: string, kind: TraceKind) => Promise<TraceDocument>
  /** The harness's own session file for a non-Claude card (TraceReader
   *  .watchSpec). Injected because the registry owns that resolution. */
  fileOf?: (node: TerminalNodeData) => string | null
  chainOptions?: ChainOptions
  markOptions?: MarkOptions
  /** Where ~/.cookrew/stream/<id>.json lives, and the clock a rollback mark
   *  is stamped with. */
  stateOptions?: StreamStateOptions
  finality?: FinalityDeps
  exists?: (file: string) => boolean
  /** Test seams. */
  now?: () => number
  chainCoalesceMs?: number
}

/**
 * Which files are a card's stream, for every harness.
 *
 * Claude walks a lineage (stream-chain.ts). Codex and Pi rotate nothing —
 * one rollout is one stream — so their chain is the single file the registry
 * resolves, present or honestly missing. Anything else has no file-derived
 * stream at all, which `sourceOf` has already reported as 'scrape'.
 */
export async function streamChainOf(
  node: TerminalNodeData,
  deps: StreamServiceDeps
): Promise<StreamChain> {
  if (isClaudeCommand(node.command)) return claudeStreamChain(node, deps.chainOptions ?? {})
  const kind: TraceKind | null = isCodexCommand(node.command)
    ? 'codex'
    : isPiCommand(node.command)
      ? 'pi'
      : null
  const file = kind === null ? null : (deps.fileOf?.(node) ?? null)
  if (kind === null || file === null) return { files: [], missing: [] }
  const exists = deps.exists ?? existsSync
  return exists(file)
    ? { files: [{ sessionId: node.id, file, kind }], missing: [] }
    : { files: [], missing: [{ sessionId: node.id, file, reason: 'no-transcript' }] }
}

/**
 * How long one resolved chain is reused.
 *
 * NOT a cache — a COALESCER. One request touches the chain several times (the
 * reader resolves it, the adapter reads the tail file's kind off it, the live
 * pass stats its tail), and for Claude each resolution is a rotation walk that
 * reads the head of every file in the lineage. A quarter second folds those
 * into one walk while staying far below the rail's own tick, so a rebind is
 * visible on the very next refresh rather than being pinned by a memo.
 */
export const CHAIN_COALESCE_MS = 250

/** The coalescing chain resolver — see CHAIN_COALESCE_MS. */
function chainResolver(deps: StreamServiceDeps): (terminalId: string) => Promise<StreamChain> {
  const cache = new Map<string, { at: number; chain: Promise<StreamChain> }>()
  const clock = deps.now ?? Date.now
  const ttl = deps.chainCoalesceMs ?? CHAIN_COALESCE_MS
  return async (terminalId) => {
    const cached = cache.get(terminalId)
    const at = clock()
    if (cached !== undefined && at - cached.at < ttl) return cached.chain
    const node = deps.nodeOf(terminalId)
    if (node === null) return { files: [], missing: [] }
    const chain = streamChainOf(node, deps).catch((error) => {
      // A failed walk is not remembered: the next call re-resolves rather
      // than serving a quarter second of "this card has no transcript".
      cache.delete(terminalId)
      throw error
    })
    cache.set(terminalId, { at, chain })
    return chain
  }
}

export function createStreamService(deps: StreamServiceDeps): StreamService {
  const chainOf = chainResolver(deps)

  const readerDeps: StreamReaderDeps = {
    chainOf,
    documentOf: deps.documentOf,
    ...(deps.exists ? { exists: deps.exists } : {})
  }
  const reader = createStreamReader(readerDeps)
  // THE RAIL READS THE MATERIALISED INDEX, not the raw walk. The two agree on
  // every card that has never been rewound; where they differ, only this one
  // can say that a /rewind took checkpoints beyond the file and that the
  // blocks after it continue the count rather than reusing it (T2.5).
  const stateOptions = deps.stateOptions ?? {}
  const indexStore = createStreamIndexStore({
    lines: (terminalId) => reader.lines(terminalId),
    readState: (terminalId) => readStreamState(terminalId, stateOptions),
    writeState: (terminalId, state) => writeStreamState(terminalId, state, stateOptions),
    ...(deps.now ? { now: deps.now } : {})
  })
  const checkpointReader = createCheckpointReader({
    index: (terminalId) => indexStore.materialise(terminalId),
    marksOf: (terminalId) => readMarks(terminalId, deps.markOptions ?? {}),
    ...(deps.markOptions ? { markOptions: deps.markOptions } : {})
  })

  return {
    sourceOf(terminalId) {
      const node = deps.nodeOf(terminalId)
      return node === null ? null : transcriptSourceFor(node)
    },
    chain: chainOf,
    checkpoints: (terminalId) => checkpointReader.checkpoints(terminalId),
    materialised: (terminalId) => indexStore.materialise(terminalId),
    async rollbacks(terminalId) {
      return (await indexStore.materialise(terminalId)).rolledBack
    },
    blocks: (terminalId, request) => reader.blocks(terminalId, request),
    async tailState(terminalId) {
      // The chain is primed BEFORE the reader runs, so the reader's own
      // resolution is a cache hit and one request walks the lineage once.
      const chaining = chainOf(terminalId)
      const [chain, tail, window] = await Promise.all([
        chaining,
        reader.tail(terminalId),
        reader.blocks(terminalId, { limit: 1 })
      ])
      const block = tail.block
      if (block === null) {
        return { ...tail, final: false, kind: null, total: window.total }
      }
      const kind = chain.files.find((entry) => entry.file === block.file)?.kind ?? 'claude'
      const final = await tailIsFinal(block, block.file, kind, deps.finality ?? {})
      // `open` follows the SETTLED rule, not just the block's own evidence:
      // a Claude turn that wrote its end_turn is over, and reporting it as
      // still live is what would keep a card spinning after the agent stopped.
      return { ...tail, open: !final, final, kind, total: window.total }
    },
    marks: (terminalId) => readMarks(terminalId, deps.markOptions ?? {}),
    writeMark: (terminalId, patch) => writeMark(terminalId, patch, deps.markOptions ?? {}),
    marksFile: (terminalId) => markFileFor(terminalId, deps.markOptions ?? {}),
    rewindPoints(terminalId) {
      const node = deps.nodeOf(terminalId)
      return (node?.restoreStack ?? [])
        .map((point) => restorePointIndex(point))
        .filter((index) => index > 0)
    }
  }
}
