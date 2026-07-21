// Append-only cross-workspace observability log (~/.cookrew/events.jsonl),
// per note observability-event-log-spec. Every mutating store op flows here
// through the store's single emit choke-point; consumers are the toast feed,
// the metrics/history panel, and the derived agent roster.
//
// Guardrails: writes are BUFFERED and flushed on a short timer (never block
// PTY streams or the render loop), the file rolls at a size cap keeping N
// rotated files, and events carry METADATA ONLY — never prompt/reply text.

import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
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

/**
 * Emits 'event' with each appended CookrewEvent (renderer + mobile SSE
 * broadcast hook) in append order, before the batched write lands.
 */
export class EventLog extends EventEmitter {
  private buffer: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly opts: Required<EventLogOptions>

  constructor(
    private file = path.join(homedir(), '.cookrew', 'events.jsonl'),
    options: EventLogOptions = {}
  ) {
    super()
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

  /** events.jsonl → events.1.jsonl → … → events.N.jsonl (oldest dropped). */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.opts.maxBytes) return
      const rotated = (n: number): string =>
        this.file.replace(/\.jsonl$/, `.${n}.jsonl`)
      for (let n = this.opts.keepFiles - 1; n >= 1; n -= 1) {
        if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1))
      }
      renameSync(this.file, rotated(1))
    } catch (error) {
      console.error('Event log rotation failed:', error)
    }
  }

  /** All persisted + buffered events, oldest first (rotated files included). */
  private readAll(): CookrewEvent[] {
    const files: string[] = []
    for (let n = this.opts.keepFiles; n >= 1; n -= 1) {
      files.push(this.file.replace(/\.jsonl$/, `.${n}.jsonl`))
    }
    files.push(this.file)
    const events: CookrewEvent[] = []
    for (const file of files) {
      try {
        if (!existsSync(file)) continue
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (line.trim().length === 0) continue
          try {
            const parsed: unknown = JSON.parse(line)
            if (isEvent(parsed)) events.push(parsed)
          } catch {
            // torn/corrupt line — skip
          }
        }
      } catch (error) {
        console.error('Event log read failed:', error)
      }
    }
    for (const line of this.buffer) {
      const parsed: unknown = JSON.parse(line)
      if (isEvent(parsed)) events.push(parsed)
    }
    return events
  }

  /** Filtered events, oldest first; `limit` keeps the NEWEST matches. */
  query(query: EventQuery = {}): CookrewEvent[] {
    const filtered = this.readAll().filter((e) => matches(e, query))
    return query.limit !== undefined && filtered.length > query.limit
      ? filtered.slice(filtered.length - query.limit)
      : filtered
  }

  /** Metric counts by event type over the same filter. */
  count(query: EventQuery = {}): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const e of this.readAll()) {
      if (!matches(e, query)) continue
      counts[e.type] = (counts[e.type] ?? 0) + 1
    }
    return counts
  }
}
