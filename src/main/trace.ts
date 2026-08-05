// Trace reader (note trace-sourced-context-final): serves identity-keyed
// TraceBlock windows straight from the agent-owned session files. Memory
// cache only — NO new store. I/O is WINDOWED and ASYNC per the lazy
// contract: the first fetch streams the file in chunks, subsequent fetches
// read ONLY the appended bytes (a shrink — /rewind truncation — resets).

import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { TerminalNodeData } from '../shared/model'
import {
  TraceBlock,
  TraceBoundaryMarker,
  TraceIndexEntry,
  TracePage,
  TracePageRequest,
  compactMarkersOf,
  pageTraceBlocks,
  parseClaudeTrace,
  parseCodexTrace,
  parsePiTrace,
  traceIndexOf
} from '../shared/trace-blocks'
import { claudeSessionFile } from './claude-fork'
import { isClaudeCommand } from '../shared/claude-fork'
import { isCodexCommand, validCodexSessionRef } from './codex-bind'
import { harnessFor } from './harness'
import { isPiCommand, piNodeSessionDir, piSessionFile } from './pi-bind'
import type { SessionTurnParser } from './session-sync'
import type { WorkspaceStore } from './store'

export type TraceSource = 'claude' | 'codex' | 'pi' | null

/** A session file + the harness's turn parser, for SessionTurnSync.watch. */
export interface SessionWatchSpec {
  file: string
  parse: SessionTurnParser
}

export interface TraceReaderOptions {
  /** Overrides for tests. */
  projectsDir?: string
  codexSessionsDir?: string
  piSessionsRoot?: string
}

const READ_CHUNK_BYTES = 256 * 1024

/** Async chunked read of [start, start+length) — never the whole file at once. */
async function readWindow(file: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const chunks: Buffer[] = []
    let position = start
    let remaining = length
    while (remaining > 0) {
      const size = Math.min(READ_CHUNK_BYTES, remaining)
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, position)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
      remaining -= bytesRead
    }
    return Buffer.concat(chunks)
  } finally {
    await handle.close()
  }
}

interface CacheEntry {
  file: string
  /** Bytes consumed from the file (complete + partial lines). */
  bytesRead: number
  /** Trailing partial line, kept as BYTES so multibyte chars never tear. */
  remainder: Buffer
  lines: string[]
  blocks: TraceBlock[]
}

export class TraceReader {
  /** Keyed by FILE path (H6): the pager and the lineage/segment reader share
   *  one incremental cache, so boundaryMarkers never re-reads a file the
   *  pager already ingested. */
  private cache = new Map<string, CacheEntry>()
  /** Derived index memo, keyed by the blocks ARRAY IDENTITY — trace growth
   *  produces a fresh array (blocksOf re-ingests), invalidating for free. */
  private indexCache = new Map<string, { blocks: TraceBlock[]; entries: TraceIndexEntry[] }>()

  constructor(
    private store: WorkspaceStore,
    private options: TraceReaderOptions = {}
  ) {}

  /**
   * Cheap identity+title listing over the WHOLE trace (fan/timeline full
   * range — T1..N including identities below the record cap). Derived from
   * the same cached block index the pager uses; lazy and re-derived only
   * when the trace grows.
   */
  async index(terminalId: string): Promise<TraceIndexEntry[]> {
    const hit = this.store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return []
    const node = hit.node
    const claude = this.claudeFile(node)
    const codex = this.codexFile(node)
    const pi = this.piFile(node)
    const file = claude ?? codex ?? pi
    if (!file) return []
    const kind = claude ? 'claude' : codex ? 'codex' : 'pi'
    const blocks = await this.blocksOf(file, kind)
    const memo = this.indexCache.get(terminalId)
    if (memo && memo.blocks === blocks) return memo.entries
    const entries = traceIndexOf(blocks)
    this.indexCache.set(terminalId, { blocks, entries })
    return entries
  }

  /**
   * Checkpoint identities (ordinal + stable message id) for the CURRENT session
   * file. The rail, rewind picker, and executor all operate in this coordinate
   * space. Pre-clear / pre-rewind endpoints are exposed via a separate lineage
   * expansion (not mixed into the main timeline) so indices never drift.
   */
  async checkpointRefs(terminalId: string): Promise<{ index: number; id: string; sessionId?: string }[]> {
    const hit = this.store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return []
    const node = hit.node
    const claude = this.claudeFile(node)
    const codex = this.codexFile(node)
    const pi = this.piFile(node)
    const file = claude ?? codex ?? pi
    if (!file) return []
    const kind = claude ? 'claude' : codex ? 'codex' : 'pi'
    const blocks = await this.blocksOf(file, kind)
    return blocks.map((b) => ({ index: b.index, id: b.id, sessionId: node.claudeSessionId ?? undefined }))
  }

  /**
   * Boundary markers for the main rail: ◆ compact (in the current session
   * file), ⇥ clear (at the start of a session file created by /clear), and
   * ⟲ rewind points (from the node's restoreStack). All coordinates are in the
   * CURRENT session file's checkpoint ordinal space so they line up with the
   * trace index the rail renders. Pre-clear endpoints are reached by expanding
   * a clear marker, not by mixing lineage files into the main rail (that
   * produced offset drift and a confusing duplicate timeline).
   */
  async boundaryMarkers(terminalId: string): Promise<TraceBoundaryMarker[]> {
    const hit = this.store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return []
    const node = hit.node

    // 1) compact markers from the CURRENT session file only.
    const claude = this.claudeFile(node)
    const markers: TraceBoundaryMarker[] = []
    if (claude) {
      const seg = await this.segmentOfFile(claude)
      markers.push(...seg.markers)
    }

    // 2) clear marker at the root of the current session file if it was born
    // from a /clear (the lineage has a predecessor AND the current file's
    // first checkpoint is T1, i.e. it started fresh rather than by restore).
    const currentSid = node.claudeSessionId
    const lineage = node.sessionLineage ?? []
    if (currentSid && lineage.length > 0) {
      const currentFile = claudeSessionFile(node.cwd, currentSid, this.options.projectsDir)
      if (existsSync(currentFile)) {
        const seg = await this.segmentOfFile(currentFile)
        const firstCurrentIndex = seg.refs[0]?.index ?? 1
        if (firstCurrentIndex === 1) {
          const previousSid = lineage[lineage.length - 1]
          markers.push({ kind: 'clear', afterIndex: 0, previousSessionId: previousSid })
        }
      }
    }

    // 3) rewind markers: each restoreStack entry says "the agent was rewound
    // TO toIndex". Because we truncate the copy at that checkpoint, the rewind
    // point lives at toIndex in the CURRENT file's coordinate space (the copy
    // kept everything <= toIndex, then new turns appended after it). Skip
    // no-op rewinds that targeted the live checkpoint of their source file.
    const currentMax =
      claude
        ? (await this.segmentOfFile(claude)).refs.reduce((m, r) => Math.max(m, r.index), 0)
        : 0
    for (const point of node.restoreStack ?? []) {
      if (point.fromIndex > 0 && point.fromIndex < currentMax) {
        markers.push({ kind: 'rewind', afterIndex: point.fromIndex, toIndex: point.fromIndex })
      }
    }

    return markers.sort((a, b) => a.afterIndex - b.afterIndex)
  }

  /** Per-file memo: refs/markers keyed by the blocks ARRAY IDENTITY — trace
   *  growth re-ingests (fresh array) and re-derives once; steady state and
   *  repeat calls within one poll are cache hits. */
  private segmentMemo = new Map<string, { blocks: TraceBlock[]; refs: { index: number; id: string }[]; markers: TraceBoundaryMarker[] }>()

  /**
   * Checkpoint refs + compact markers of one session file, routed through
   * the SAME incremental cache as the pager (H6): only the appended bytes
   * are read on growth, never the whole file per size change — a polling
   * checkpoint rail stays O(appended) instead of O(n\u00b2) in I/O.
   */
  private async segmentOfFile(file: string): Promise<{ refs: { index: number; id: string }[]; markers: TraceBoundaryMarker[] }> {
    const blocks = await this.blocksOf(file, 'claude')
    const memo = this.segmentMemo.get(file)
    if (memo && memo.blocks === blocks) return { refs: memo.refs, markers: memo.markers }
    const refs = blocks.map((b) => ({ index: b.index, id: b.id }))
    const markers = compactMarkersOf(this.cache.get(file)?.lines ?? [])
    this.segmentMemo.set(file, { blocks, refs, markers })
    return { refs, markers }
  }

  /**
   * Session-file watch spec for SessionTurnSync (harness-integration-contract):
   * the file to poll + the harness's turn parser, or null when this terminal
   * has no file-derived history (unbound, scrape-only harness, plain shell).
   * Fully registry-driven: the harness entry owns both the parser and the
   * (security-validated) file resolution, so a conforming harness needs no
   * edits here. A missing file is fine — the sync polls until it appears.
   */
  watchSpec(terminalId: string): SessionWatchSpec | null {
    const hit = this.store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return null
    const node = hit.node
    const harness = harnessFor(node.command)
    if (!harness?.parseTurns || !harness.watchFile) return null
    const file = harness.watchFile(node, this.options)
    return file ? { file, parse: harness.parseTurns } : null
  }

  /** Identity-keyed trace window for a terminal (see the contract note). */
  async page(
    terminalId: string,
    request: TracePageRequest = {}
  ): Promise<TracePage & { source: TraceSource }> {
    const hit = this.store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return { blocks: [], total: 0, source: null }
    const node = hit.node
    const claude = this.claudeFile(node)
    if (claude) {
      const blocks = await this.blocksOf(claude, 'claude')
      return { ...pageTraceBlocks(blocks, request), source: 'claude' }
    }
    const codex = this.codexFile(node)
    if (codex) {
      const blocks = await this.blocksOf(codex, 'codex')
      return { ...pageTraceBlocks(blocks, request), source: 'codex' }
    }
    const pi = this.piFile(node)
    if (pi) {
      const blocks = await this.blocksOf(pi, 'pi')
      return { ...pageTraceBlocks(blocks, request), source: 'pi' }
    }
    return { blocks: [], total: 0, source: null }
  }

  private claudeFile(node: TerminalNodeData): string | null {
    if (!isClaudeCommand(node.command) || !node.claudeSessionId) return null
    const file = claudeSessionFile(node.cwd, node.claudeSessionId, this.options.projectsDir)
    return existsSync(file) ? file : null
  }

  private codexFile(node: TerminalNodeData): string | null {
    if (!isCodexCommand(node.command)) return null
    // Use ONLY the authoritative bound ref (set deterministically at spawn by
    // lsof of the codex process), validated inside the sessions tree. No
    // mtime rebind here — that was a stray-grab / cross-wiring source
    // (EXACT-CONTEXT gate). Unbound → no trace, honest.
    const bound = validCodexSessionRef(node.codexSessionRef, this.options.codexSessionsDir)
    return bound && existsSync(bound) ? bound : null
  }

  private piFile(node: TerminalNodeData): string | null {
    if (!isPiCommand(node.command) || !node.piSessionId) return null
    const sessionsDir = piNodeSessionDir(node.id, { rootDir: this.options.piSessionsRoot })
    return piSessionFile(node.cwd, node.piSessionId, {
      sessionsDir
    })
  }

  private async blocksOf(
    file: string,
    kind: 'claude' | 'codex' | 'pi'
  ): Promise<TraceBlock[]> {
    try {
      const info = await stat(file)
      const cached = this.cache.get(file)
      if (cached && info.size === cached.bytesRead) {
        return cached.blocks // unchanged: zero I/O
      }
      if (cached && info.size > cached.bytesRead) {
        // Append-only growth: read ONLY the new bytes.
        const appended = await readWindow(file, cached.bytesRead, info.size - cached.bytesRead)
        return this.ingest(file, kind, cached, appended, info.size)
      }
      // First read or a shrink (/rewind truncation): reload.
      const whole = await readWindow(file, 0, info.size)
      const fresh: CacheEntry = {
        file,
        bytesRead: 0,
        remainder: Buffer.alloc(0),
        lines: [],
        blocks: []
      }
      return this.ingest(file, kind, fresh, whole, info.size)
    } catch (error) {
      console.error('Trace read failed:', error)
      return []
    }
  }

  /** Fold new bytes into the cache: complete lines parse, the tail waits. */
  private ingest(
    file: string,
    kind: 'claude' | 'codex' | 'pi',
    entry: CacheEntry,
    incoming: Buffer,
    bytesRead: number
  ): TraceBlock[] {
    const pending = Buffer.concat([entry.remainder, incoming])
    const lastNewline = pending.lastIndexOf(0x0a)
    const complete = lastNewline === -1 ? Buffer.alloc(0) : pending.subarray(0, lastNewline + 1)
    const remainder = lastNewline === -1 ? pending : pending.subarray(lastNewline + 1)
    const lines = [...entry.lines]
    if (complete.length > 0) {
      for (const line of complete.toString('utf8').split('\n')) {
        if (line.length > 0) lines.push(line)
      }
    }
    const blocks = kind === 'claude'
      ? parseClaudeTrace(lines)
      : kind === 'codex'
        ? parseCodexTrace(lines)
        : parsePiTrace(lines)
    this.cache.set(file, {
      file,
      bytesRead,
      remainder: Buffer.from(remainder),
      lines,
      blocks
    })
    return blocks
  }
}
