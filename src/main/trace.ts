// Trace reader (note trace-sourced-context-final): serves identity-keyed
// TraceBlock windows straight from the agent-owned session files. Memory
// cache only — NO new store. I/O is WINDOWED and ASYNC per the lazy
// contract: the first fetch streams the file in chunks, subsequent fetches
// read ONLY the appended bytes (a shrink — /rewind truncation — resets).

import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { TerminalNodeData } from '../shared/model'
import {
  TraceBlock,
  TraceIndexEntry,
  TracePage,
  TracePageRequest,
  pageTraceBlocks,
  parseClaudeTrace,
  parseCodexTrace,
  traceIndexOf
} from '../shared/trace-blocks'
import { claudeSessionFile } from './claude-fork'
import { isClaudeCommand } from '../shared/claude-fork'
import { defaultCodexSessionsDir, isCodexCommand } from './codex-bind'
import type { WorkspaceStore } from './store'

export type TraceSource = 'claude' | 'codex' | null

export interface TraceReaderOptions {
  /** Overrides for tests. */
  projectsDir?: string
  codexSessionsDir?: string
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
    const file = claude ?? this.codexFile(node)
    if (!file) return []
    const blocks = await this.blocksOf(terminalId, file, claude ? 'claude' : 'codex')
    const memo = this.indexCache.get(terminalId)
    if (memo && memo.blocks === blocks) return memo.entries
    const entries = traceIndexOf(blocks)
    this.indexCache.set(terminalId, { blocks, entries })
    return entries
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
      const blocks = await this.blocksOf(terminalId, claude, 'claude')
      return { ...pageTraceBlocks(blocks, request), source: 'claude' }
    }
    const codex = this.codexFile(node)
    if (codex) {
      const blocks = await this.blocksOf(terminalId, codex, 'codex')
      return { ...pageTraceBlocks(blocks, request), source: 'codex' }
    }
    return { blocks: [], total: 0, source: null }
  }

  private claudeFile(node: TerminalNodeData): string | null {
    if (!isClaudeCommand(node.command) || !node.claudeSessionId) return null
    const file = claudeSessionFile(node.cwd, node.claudeSessionId, this.options.projectsDir)
    return existsSync(file) ? file : null
  }

  private codexSessionsBase(): string {
    return path.resolve(this.options.codexSessionsDir ?? defaultCodexSessionsDir())
  }

  /**
   * SECURITY: a codexSessionRef is only honored when it resolves INSIDE the
   * codex sessions tree — node fields can arrive over the unauthenticated
   * mobile surface, and a planted ref must never turn the trace reader into
   * an arbitrary-file oracle. (updateNode also allow-lists the field away;
   * this is the defense-in-depth check at the read site.)
   */
  private validCodexRef(ref: string | null | undefined): string | null {
    if (!ref) return null
    const resolved = path.resolve(ref)
    return resolved.startsWith(this.codexSessionsBase() + path.sep) ? resolved : null
  }

  private codexFile(node: TerminalNodeData): string | null {
    if (!isCodexCommand(node.command)) return null
    // Use ONLY the authoritative bound ref (set deterministically at spawn by
    // lsof of the codex process). No mtime rebind here — that was a stray-grab
    // / cross-wiring source (EXACT-CONTEXT gate). Unbound → no trace, honest.
    const bound = this.validCodexRef(node.codexSessionRef)
    return bound && existsSync(bound) ? bound : null
  }

  private async blocksOf(
    terminalId: string,
    file: string,
    kind: 'claude' | 'codex'
  ): Promise<TraceBlock[]> {
    try {
      const info = await stat(file)
      const cached = this.cache.get(terminalId)
      if (cached && cached.file === file && info.size === cached.bytesRead) {
        return cached.blocks // unchanged: zero I/O
      }
      if (cached && cached.file === file && info.size > cached.bytesRead) {
        // Append-only growth: read ONLY the new bytes.
        const appended = await readWindow(file, cached.bytesRead, info.size - cached.bytesRead)
        return this.ingest(terminalId, file, kind, cached, appended, info.size)
      }
      // First read, file switch, or a shrink (/rewind truncation): reload.
      const whole = await readWindow(file, 0, info.size)
      const fresh: CacheEntry = {
        file,
        bytesRead: 0,
        remainder: Buffer.alloc(0),
        lines: [],
        blocks: []
      }
      return this.ingest(terminalId, file, kind, fresh, whole, info.size)
    } catch (error) {
      console.error('Trace read failed:', error)
      return []
    }
  }

  /** Fold new bytes into the cache: complete lines parse, the tail waits. */
  private ingest(
    terminalId: string,
    file: string,
    kind: 'claude' | 'codex',
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
    const blocks = kind === 'claude' ? parseClaudeTrace(lines) : parseCodexTrace(lines)
    this.cache.set(terminalId, {
      file,
      bytesRead,
      remainder: Buffer.from(remainder),
      lines,
      blocks
    })
    return blocks
  }
}
