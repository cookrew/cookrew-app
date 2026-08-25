// Trace reader (note trace-sourced-context-final): serves identity-keyed
// TraceBlock windows straight from the agent-owned session files. Memory
// cache only — NO new store. I/O is WINDOWED and ASYNC per the lazy
// contract: the first fetch streams the file in chunks, subsequent fetches
// read ONLY the appended bytes (a shrink — /rewind truncation — resets).

import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { TerminalNodeData } from '../shared/model'
import { restorePointIndex } from '../shared/model'
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
import { harnessFor , type TurnFinality } from './harness'
import { isPiCommand, piSessionHome } from './pi-bind'
import type { SessionTurnParser } from './session-sync'
import type { TurnRecord } from '../shared/turn'
import type { WorkspaceStore } from './store'

export type TraceSource = 'claude' | 'codex' | 'pi' | null

/** A session file + the harness's turn parser, for SessionTurnSync.watch. */
export interface SessionWatchSpec {
  file: string
  parse: SessionTurnParser
  /**
   * The harness's declared closure story (see TurnFinality): 'native' can
   * prove its tail record final, 'boundary' only ever finalizes a record
   * when the NEXT one arrives — which a background dispatch never sends, so
   * dispatch acceptance refuses 'boundary' file targets (A2 precondition).
   */
  finality: TurnFinality
}

export interface TraceReaderOptions {
  /** Overrides for tests. */
  projectsDir?: string
  codexSessionsDir?: string
  piSessionsRoot?: string
  piAgentDir?: string
}

const READ_CHUNK_BYTES = 256 * 1024

/** M8: cap on per-file memoized trace state (block cache + segmentMemo). */
const TRACE_FILE_MEMO_CAP = 128

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
  /**
   * T1 latest-checkpoint cache, stat-guarded. A canvas of mostly-idle agents
   * polls latestCheckpoint on every card each tick; without this, an idle
   * agent's unchanged file is re-opened, re-read and re-parsed every time. Keyed
   * by terminal id → the file's identity (path+size+mtime) it was computed from;
   * a matching stat returns the cached turn with NO open/read/parse, turning a
   * fleet poll tick from N reads into N cheap stats.
   */
  private latestCache = new Map<
    string,
    {
      file: string
      size: number
      mtimeMs: number
      value: { prompt: string; reply: string; title?: string } | null
    }
  >()

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
      const toIndex = restorePointIndex(point)
      if (toIndex > 0 && toIndex < currentMax) {
        markers.push({ kind: 'rewind', afterIndex: toIndex, toIndex })
      }
    }

    return markers.sort((a, b) => a.afterIndex - b.afterIndex)
  }

  /** Per-file memo: refs/markers keyed by the blocks ARRAY IDENTITY — trace
   *  growth re-ingests (fresh array) and re-derives once; steady state and
   *  repeat calls within one poll are cache hits. */
  private segmentMemo = new Map<string, { blocks: TraceBlock[]; refs: { index: number; id: string }[]; markers: TraceBoundaryMarker[] }>()

  /** M8: both per-file maps (block cache + segmentMemo) are insertion-order
   *  capped — otherwise they grew one entry per session file for the whole
   *  process lifetime. FIFO suffices: a polled LIVE file is re-touched
   *  constantly so it never reaches the eviction tail; an evicted file just
   *  re-reads fully once on next access, then goes incremental again. */
  private static cappedSet<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.has(key)) map.delete(key) // refresh recency
    map.set(key, value)
    while (map.size > TRACE_FILE_MEMO_CAP) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

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
    TraceReader.cappedSet(this.segmentMemo, file, { blocks, refs, markers })
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
    return file ? { file, parse: harness.parseTurns, finality: harness.turnFinality } : null
  }

  /**
   * The LATEST checkpoint only — perf tier T1 (trace-perf-architecture). A card
   * that is merely VISIBLE needs the last turn, not the whole history and never
   * a PTY. So this reads a bounded TAIL of the session JSONL and returns the
   * last complete turn: prompt, reply, title. O(tail), not O(file); a 100 MB
   * transcript costs the same as a 10 KB one.
   *
   * The tail can start mid-turn, so the parser's FIRST record may be partial —
   * but the LAST record is always complete (the file ends at the newest
   * append), and that is the only one a card shows. The absolute checkpoint
   * COUNT is deliberately not computed here: it needs the whole file, which is
   * the cost this tier exists to avoid. Callers that need a count pay for it on
   * zoom (the full paged parse) or from a persisted counter.
   */
  async latestCheckpoint(
    terminalId: string,
    tailBytes = 256 * 1024
  ): Promise<{ prompt: string; reply: string; title?: string } | null> {
    const spec = this.watchSpec(terminalId)
    if (!spec || !existsSync(spec.file)) return null
    let size: number
    let mtimeMs: number
    try {
      const st = await stat(spec.file)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      return null
    }
    // Stat-guard: an unchanged file (same path, size, mtime) returns the cached
    // turn with no open/read/parse. This is the fleet-poll fast path — most
    // agents are idle, so most ticks land here and cost only the stat above.
    const cached = this.latestCache.get(terminalId)
    if (cached && cached.file === spec.file && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.value
    }
    const remember = (
      value: { prompt: string; reply: string; title?: string } | null
    ): { prompt: string; reply: string; title?: string } | null => {
      this.latestCache.set(terminalId, { file: spec.file, size, mtimeMs, value })
      return value
    }
    // Escalate the window until it holds a COMPLETE turn. A turn only parses
    // when the window contains its opening user line, so a single heavy turn
    // (huge tool output — a session mid-flight can exceed 256 KB in one turn)
    // reads empty from a small tail. Grow 256 KB → 1 MB → 4 MB → whole file
    // until a record appears; the common case still pays one 256 KB read.
    for (let window = tailBytes; ; window = Math.min(window * 4, size)) {
      let records: TurnRecord[]
      try {
        const start = Math.max(0, size - window)
        const len = Math.min(size, window)
        const fh = await open(spec.file, 'r')
        let text: string
        try {
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, start)
          text = buf.toString('utf8')
        } finally {
          await fh.close()
        }
        // Drop the first line only when we read from mid-file — it is almost
        // certainly a partial JSONL record the parser cannot use. A window that
        // reached the start of the file keeps every line.
        const lines = text.split('\n')
        const usable = start > 0 && lines.length > 1 ? lines.slice(1) : lines
        records = spec.parse(usable)
      } catch {
        return null // a transient read error — do NOT cache, retry next tick
      }
      const last = records[records.length - 1]
      if (last) {
        return remember({
          prompt: last.prompt,
          reply: last.reply,
          ...(last.title ? { title: last.title } : {})
        })
      }
      // No complete turn in this window. If we have now read the whole file,
      // there genuinely is none; otherwise grow and retry.
      if (size - window <= 0) return remember(null)
    }
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
    // Same home as the watch/resume paths: a session adopted from a legacy
    // pane lives in pi's own cwd dir, and the trace drawer must not go blank
    // for exactly the terminals whose rail works.
    return (
      piSessionHome(node.cwd, node.piSessionId, node.id, {
        sessionsRoot: this.options.piSessionsRoot,
        agentDir: this.options.piAgentDir
      })?.file ?? null
    )
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
    TraceReader.cappedSet(this.cache, file, {
      file,
      bytesRead,
      remainder: Buffer.from(remainder),
      lines,
      blocks
    })
    return blocks
  }
}
