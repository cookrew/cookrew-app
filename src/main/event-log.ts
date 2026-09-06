// Append-only cross-workspace observability log (~/.cookrew/events.jsonl),
// per note observability-event-log-spec. Every mutating store op flows here
// through the store's single emit choke-point; consumers are the toast feed,
// the metrics/history panel, and the derived agent roster.
//
// Guardrails: writes are BUFFERED and flushed on a short timer (never block
// PTY streams or the render loop), the file rolls at a size cap keeping N
// rotated files, and events carry METADATA ONLY — never prompt/reply text.
//
// Reads: a rotated file is immutable once rotated, so its parsed rows are
// cached and pinned to the file's identity (ino, size, mtime); the live
// file (at most maxBytes) is read and split on every query. A
// limited query walks newest-first and stops at the limit, so its cost does
// not grow with the rotated log, only with the live file. Rows served from
// the cache are SHARED objects — callers serialise them, never mutate.

import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type EventActor = 'orch' | 'agent' | 'user'

export interface CookrewEvent {
  /** e.g. 'terminal.recruited', 'workspace.switched' — see note for the set. */
  type: string
  entityId: string
  entityName: string
  workspaceId: string
  workspaceName: string
  actor: EventActor
  /** Epoch ms. */
  timestamp: number
  /** Brief metadata (preset, target names) — never conversation content. */
  details?: string
  /**
   * How long the thing this event reports on TOOK, in milliseconds. Optional
   * and absent — not null, not zero — on every untimed event, which is most
   * of them: the log records that a note was created, not how long creating
   * it took. Consumers derive P50/P95/P98 from the events that carry one and
   * must keep working unchanged against the ones that do not.
   *
   * A duration is a count of milliseconds and nothing else. Emitters drop a
   * value that is not finite and non-negative rather than let a NaN reach a
   * percentile, where it would skew every number ranked above it.
   */
  durationMs?: number
}

export interface EventQuery {
  workspaceId?: string
  /** Exact type, or a 'terminal.' style prefix filter. */
  type?: string
  /** Exact-type set (Velvet's filter shape); OR-ed with `type` when both set. */
  types?: string[]
  /** Epoch ms range, inclusive since / exclusive until. */
  since?: number
  until?: number
  /** Newest-last cap applied after filtering. */
  limit?: number
}

interface EventLogOptions {
  /** Roll the live file past this size. */
  maxBytes?: number
  /** Rotated files kept (events.1.jsonl … events.N.jsonl). */
  keepFiles?: number
  /** Buffer window before an async batched write. */
  flushMs?: number
}

const DEFAULTS = { maxBytes: 4 * 1024 * 1024, keepFiles: 3, flushMs: 200 }

/**
 * What tells one file on disk from another, rename or not: a rename keeps
 * ino, size and mtime. Birth time is carried for diagnostics only and is NOT
 * part of the identity — where libuv has no statx it is filled from ctime,
 * which a rename changes, and every rotation would then drop the whole cache.
 */
interface FileIdentity {
  ino: number
  size: number
  mtimeMs: number
  birthtimeMs: number
}

/** A rotated file's rows, pinned to the file they were parsed from. */
interface CachedFile extends FileIdentity {
  events: readonly CookrewEvent[]
}

/**
 * One place rows come from, oldest-first inside. A cached rotated file is
 * already parsed; the live file and the buffer are raw lines that parse on
 * demand, so a newest-first walk only pays for the lines it looks at.
 */
type Source =
  | { readonly kind: 'parsed'; readonly events: readonly CookrewEvent[] }
  | { readonly kind: 'raw'; readonly lines: readonly string[] }

function isEvent(value: unknown): value is CookrewEvent {
  const e = value as CookrewEvent
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.type === 'string' &&
    typeof e.entityId === 'string' &&
    typeof e.workspaceId === 'string' &&
    typeof e.timestamp === 'number'
  )
}

function matches(event: CookrewEvent, query: EventQuery): boolean {
  if (query.workspaceId !== undefined && event.workspaceId !== query.workspaceId) return false
  if (query.type !== undefined || query.types !== undefined) {
    const single =
      query.type !== undefined &&
      (event.type === query.type ||
        (query.type.endsWith('.') && event.type.startsWith(query.type)))
    const listed = query.types !== undefined && query.types.includes(event.type)
    if (!single && !listed) return false
  }
  if (query.since !== undefined && event.timestamp < query.since) return false
  if (query.until !== undefined && event.timestamp >= query.until) return false
  return true
}

/** One JSONL line as an event, or null for an empty, torn or foreign line. */
function parseLine(line: string): CookrewEvent | null {
  if (line.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(line)
    return isEvent(parsed) ? parsed : null
  } catch {
    return null // torn/corrupt line — skip
  }
}

function parseLines(text: string): CookrewEvent[] {
  const events: CookrewEvent[] = []
  for (const line of text.split('\n')) {
    const event = parseLine(line)
    if (event) events.push(event)
  }
  return events
}

const SHARED_FIELDS = ['type', 'entityId', 'entityName', 'workspaceId', 'workspaceName', 'actor'] as const

/**
 * The same rows with one copy of each repeated string: types, ids and names
 * recur on nearly every line, and JSON.parse hands each line its own. Only
 * matters for the rows a cache keeps, where it roughly halves what they hold.
 * A field is replaced only where the line had a string for it; the row's key
 * set is exactly what JSON.parse produced, so a row read from a rotated file
 * is indistinguishable from the same row read from the live file.
 */
function shareStrings(events: readonly CookrewEvent[]): CookrewEvent[] {
  const seen = new Map<string, string>()
  const one = (value: string): string => {
    const known = seen.get(value)
    if (known !== undefined) return known
    seen.set(value, value)
    return value
  }
  return events.map((e) => {
    const row: Record<string, unknown> = { ...e }
    for (const field of SHARED_FIELDS) {
      const value = row[field]
      if (typeof value === 'string') row[field] = one(value)
    }
    return row as unknown as CookrewEvent
  })
}

function identityOf(stat: Stats): FileIdentity {
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs }
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function lengthOf(source: Source): number {
  return source.kind === 'parsed' ? source.events.length : source.lines.length
}

function eventAt(source: Source, index: number): CookrewEvent | null {
  return source.kind === 'parsed' ? source.events[index] : parseLine(source.lines[index])
}

/** Every row across the sources, oldest first — the full walk count() needs. */
function everyEvent(sources: readonly Source[]): CookrewEvent[] {
  const events: CookrewEvent[] = []
  for (const source of sources) {
    for (let i = 0; i < lengthOf(source); i += 1) {
      const event = eventAt(source, i)
      if (event) events.push(event)
    }
  }
  return events
}

/**
 * The newest `limit` matches, oldest first: what filtering everything and
 * keeping the tail returned, found by walking from the newest row backwards
 * and stopping as soon as enough are held.
 */
function newestMatches(sources: readonly Source[], query: EventQuery, limit: number): CookrewEvent[] {
  const collected: CookrewEvent[] = []
  for (let s = sources.length - 1; s >= 0 && collected.length < limit; s -= 1) {
    const source = sources[s]
    for (let i = lengthOf(source) - 1; i >= 0 && collected.length < limit; i -= 1) {
      const event = eventAt(source, i)
      if (event && matches(event, query)) collected.push(event)
    }
  }
  return collected.reverse()
}

/**
 * Emits 'event' with each appended CookrewEvent (renderer + mobile SSE
 * broadcast hook) in append order, before the batched write lands.
 */
export class EventLog extends EventEmitter {
  private buffer: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly opts: Required<EventLogOptions>
  /** The parsed rotated files, rebuilt on every read from what exists now. */
  private rotatedCache: readonly CachedFile[] = []

  constructor(
    private file = path.join(homedir(), '.cookrew', 'events.jsonl'),
    options: EventLogOptions = {}
  ) {
    super()
    // Rotated names are made by replacing the suffix; without it every
    // rotated name would BE the live file, and the cache would pin it.
    if (!file.endsWith('.jsonl')) throw new Error(`EventLog file must end in .jsonl: ${file}`)
    this.opts = { ...DEFAULTS, ...options }
  }

  append(event: CookrewEvent): void {
    this.buffer.push(JSON.stringify(event))
    this.emit('event', event)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.opts.flushMs)
    }
  }

  /** Drain the buffer to disk now (also called on app quit). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return
    const lines = this.buffer
    this.buffer = []
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.file, lines.join('\n') + '\n', 'utf8')
    } catch (error) {
      console.error('Event log write failed:', error)
    }
  }

  private rotated(n: number): string {
    return this.file.replace(/\.jsonl$/, `.${n}.jsonl`)
  }

  /** events.jsonl → events.1.jsonl → … → events.N.jsonl (oldest dropped). */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.opts.maxBytes) return
      for (let n = this.opts.keepFiles - 1; n >= 1; n -= 1) {
        if (existsSync(this.rotated(n))) renameSync(this.rotated(n), this.rotated(n + 1))
      }
      renameSync(this.file, this.rotated(1))
    } catch (error) {
      console.error('Event log rotation failed:', error)
    }
  }

  /**
   * Everything persisted or buffered, oldest first: the rotated files from
   * the cache, then the live file read fresh, then the buffer. Building the
   * list is what refreshes the cache, so query() and count() cannot drift.
   */
  private sources(): Source[] {
    const rotated: Source[] = []
    const next: CachedFile[] = []
    for (let n = this.opts.keepFiles; n >= 1; n -= 1) {
      const loaded = this.loadRotated(this.rotated(n))
      if (!loaded) continue
      if (loaded.pinned) next.push(loaded.entry)
      rotated.push({ kind: 'parsed', events: loaded.entry.events })
    }
    this.rotatedCache = next
    return [...rotated, { kind: 'raw', lines: this.readLive() }, { kind: 'raw', lines: this.buffer }]
  }

  /**
   * A rotated file's rows, from the cache when a cached file has the same
   * identity — a rename keeps ino, size and mtime, so after a rotation the
   * entry follows its file and only the newly rotated one is parsed. A file
   * whose identity changed between the stat and the read is served but not
   * pinned, so a swap by another process is re-checked next call.
   */
  private loadRotated(file: string): { entry: CachedFile; pinned: boolean } | null {
    const before = this.identity(file)
    if (!before) return null
    for (const known of this.rotatedCache) {
      if (sameFile(known, before)) return { entry: known, pinned: true }
    }
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (!isMissing(error)) console.error('Event log read failed:', error)
      return null
    }
    const after = this.identity(file)
    const entry = { ...before, events: shareStrings(parseLines(text)) }
    return { entry, pinned: after !== null && sameFile(before, after) }
  }

  private identity(file: string): FileIdentity | null {
    try {
      return identityOf(statSync(file))
    } catch (error) {
      if (!isMissing(error)) console.error('Event log stat failed:', error)
      return null
    }
  }

  /** The live file's lines, unparsed; the file is never cached. */
  private readLive(): string[] {
    try {
      return readFileSync(this.file, 'utf8').split('\n')
    } catch (error) {
      if (!isMissing(error)) console.error('Event log read failed:', error)
      return []
    }
  }

  /** Filtered events, oldest first; `limit` keeps the NEWEST matches. */
  query(query: EventQuery = {}): CookrewEvent[] {
    const sources = this.sources()
    // NaN and +Infinity never trimmed anything (the old `length > limit`
    // test is false for both), so they are no limit here; every other value,
    // -Infinity included, trims exactly as the old tail slice did.
    const { limit } = query
    if (limit !== undefined && !Number.isNaN(limit) && limit !== Infinity) {
      return newestMatches(sources, query, limit)
    }
    return everyEvent(sources).filter((e) => matches(e, query))
  }

  /** Metric counts by event type over the same filter. */
  count(query: EventQuery = {}): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const e of everyEvent(this.sources())) {
      if (!matches(e, query)) continue
      counts[e.type] = (counts[e.type] ?? 0) + 1
    }
    return counts
  }
}
