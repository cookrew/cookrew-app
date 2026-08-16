import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { latencyStats, type LatencyStats } from '../../shared/stats'

/**
 * A CrIcon name — kept as a plain string (not imported from icons.tsx) so this
 * module stays JSX-free and unit-testable under the node tsconfig. Call sites
 * pass it to <CrIcon name={... as CrIconName}>.
 */
export type EventIconName = string

/**
 * Observability event-log adapter (Velvet lane — observability-event-log-spec).
 * Forge's append-only cross-workspace log at ~/.cookrew/events.jsonl + its
 * global stream and query API are the backend lane; this module lets the toast
 * feed and metrics panel build ahead of it. Every call feature-detects the real
 * method on the cookrew() bridge and falls back to an in-memory mock so the UI
 * is exercisable now (a window channel lets a real emit — or a QA dispatch —
 * surface). When Forge lands the stream, detection flips; the mock goes dormant.
 *
 * Proposed contract (append to the note for Forge):
 *   CookrewEvent = { type, entityId, entityName, workspaceId, workspaceName,
 *                    actor: 'orch'|'agent'|'user', timestamp, details? }
 *   api.onEvent(cb) => unsubscribe                        // GLOBAL stream (all workspaces)
 *   api.queryEvents({workspaceId?,types?,since?,until?}) => Promise<CookrewEvent[]>
 *   (mobile: SSE 'event' on /api/events + GET /api/events/query?…)
 */

export type EventActor = 'orch' | 'agent' | 'user'

export interface CookrewEvent {
  /** Dotted type, e.g. 'terminal.recruited' — string for forward-compat. */
  type: string
  entityId: string
  entityName: string
  workspaceId: string
  workspaceName: string
  actor: EventActor
  timestamp: number
  details?: string
  /**
   * How long the thing this event reports on took, in ms (p95-p98-latency-
   * metrics-spec). OPTIONAL and absent — not null, not zero — on every untimed
   * event, which is most of them. Mirrors main/event-log.ts exactly; every
   * existing consumer keeps working unchanged against events without one.
   */
  durationMs?: number
}

/**
 * Whether an event carries a usable duration. Guards the percentile input:
 * a NaN or a negative reaching latencyStats would rank above every real
 * sample and silently poison p95/p98, so a malformed value is treated as
 * untimed rather than trusted.
 */
export function isTimed(e: CookrewEvent): boolean {
  return typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0
}

export interface EventFilter {
  workspaceId?: string
  types?: string[]
  since?: number
  until?: number
}

/** Display metadata per event type. hatch = creation event (avatar hatches). */
export interface EventMeta {
  label: string
  /** Past-tense verb for toast text ("recruited", "dismissed"). */
  verb: string
  /** Singular noun for coalesced counts ("terminal" → "3 terminals recruited"). */
  noun: string
  icon: EventIconName
  hatch: boolean
  /** Metric bucket this type rolls into, or null to exclude from counts. */
  metric: MetricKey | null
  /**
   * false = never toast this type. Timed observability events (turn.completed,
   * terminal.booted) fire on every turn / cold spawn — as toasts they would
   * shadow every Recruited/Created toast with a metrics echo. They exist for
   * the LATENCY rollup, not the feed.
   */
  toast?: false
}

export type MetricKey = 'spawned' | 'cards' | 'forks' | 'switches' | 'removed'

const META: Record<string, EventMeta> = {
  'terminal.recruited': { label: 'Recruited', verb: 'recruited', noun: 'agent', icon: 'agent', hatch: true, metric: 'spawned' },
  'terminal.created': { label: 'Created', verb: 'created', noun: 'terminal', icon: 'terminal', hatch: true, metric: 'spawned' },
  // Timed types (durationMs). metric: null — a turn completing is not a thing
  // spawned/created/removed, so it must not inflate any count bucket; it earns
  // its place in the LATENCY rollup instead.
  'turn.completed': { label: 'Turn', verb: 'finished a turn', noun: 'turn', icon: 'agent', hatch: false, metric: null, toast: false },
  'terminal.booted': { label: 'Booted', verb: 'booted', noun: 'terminal', icon: 'terminal', hatch: false, metric: null, toast: false },
  'terminal.dismissed': { label: 'Dismissed', verb: 'dismissed', noun: 'agent', icon: 'close', hatch: false, metric: 'removed' },
  'terminal.killed': { label: 'Killed', verb: 'killed', noun: 'agent', icon: 'close', hatch: false, metric: 'removed' },
  'note.created': { label: 'Note', verb: 'created', noun: 'note', icon: 'note', hatch: false, metric: 'cards' },
  'note.deleted': { label: 'Note', verb: 'deleted', noun: 'note', icon: 'close', hatch: false, metric: 'removed' },
  'browser.created': { label: 'Browser', verb: 'created', noun: 'browser', icon: 'browser', hatch: false, metric: 'cards' },
  'browser.closed': { label: 'Browser', verb: 'closed', noun: 'browser', icon: 'close', hatch: false, metric: 'removed' },
  'terminal.forked': { label: 'Fork', verb: 'forked', noun: 'agent', icon: 'fork', hatch: true, metric: 'forks' },
  'team.forked': { label: 'Team fork', verb: 'forked', noun: 'team', icon: 'fork', hatch: false, metric: 'forks' },
  'connection.made': { label: 'Wired', verb: 'connected', noun: 'connection', icon: 'connect', hatch: false, metric: null },
  'connection.removed': { label: 'Unwired', verb: 'disconnected', noun: 'connection', icon: 'close', hatch: false, metric: null },
  'workspace.created': { label: 'Workspace', verb: 'created', noun: 'workspace', icon: 'plus', hatch: false, metric: null },
  'workspace.switched': { label: 'Switched', verb: 'switched to', noun: 'workspace', icon: 'next', hatch: false, metric: 'switches' },
  'workspace.renamed': { label: 'Renamed', verb: 'renamed', noun: 'workspace', icon: 'note', hatch: false, metric: null },
  'workspace.deleted': { label: 'Workspace', verb: 'deleted', noun: 'workspace', icon: 'close', hatch: false, metric: 'removed' },
  'role.saved': { label: 'Role', verb: 'saved', noun: 'role', icon: 'agent', hatch: false, metric: null },
  'team.saved': { label: 'Team', verb: 'saved', noun: 'team', icon: 'fork', hatch: false, metric: null },
  'team.copied': { label: 'Team copy', verb: 'copied into', noun: 'team', icon: 'fork', hatch: false, metric: 'forks' },
  'team.moved': { label: 'Team move', verb: 'moved into', noun: 'team', icon: 'fork', hatch: false, metric: 'forks' },
  // The dispatch plane's product surface: accepted/settled announcements
  // (details carry the agent's name and, on failure, the honest error).
  'dispatch.accepted': { label: 'Dispatch', verb: 'took a dispatch', noun: 'dispatch', icon: 'agent', hatch: false, metric: null },
  'dispatch.done': { label: 'Dispatch', verb: 'finished a dispatch', noun: 'dispatch', icon: 'agent', hatch: false, metric: null },
  'dispatch.failed': { label: 'Dispatch', verb: 'failed a dispatch', noun: 'dispatch', icon: 'close', hatch: false, metric: null },
  'dispatch.interrupted': { label: 'Dispatch', verb: 'had a dispatch interrupted', noun: 'dispatch', icon: 'close', hatch: false, metric: null },
  'terminal.input-refused': { label: 'Refused', verb: 'refused input', noun: 'terminal', icon: 'close', hatch: false, metric: null }
}

const FALLBACK_META: EventMeta = {
  label: 'Event',
  verb: 'changed',
  noun: 'item',
  icon: 'dot',
  hatch: false,
  metric: null
}

export function eventMeta(type: string): EventMeta {
  return META[type] ?? FALLBACK_META
}

/** Semantic category for Fresco's tint hooks: create/remove/fork/switch. */
export type EventKind = 'create' | 'remove' | 'fork' | 'switch'

/**
 * Category of an event type, or undefined for a neutral base. Drives the
 * `data-kind` tint on toast glyphs and timeline icons (Fresco visual v1).
 */
export function kindFor(type: string): EventKind | undefined {
  if (type.endsWith('.forked')) return 'fork'
  if (type === 'workspace.switched') return 'switch'
  const verb = type.split('.').pop() ?? ''
  if (['created', 'saved', 'made', 'recruited', 'copied', 'moved'].includes(verb)) return 'create'
  if (['dismissed', 'killed', 'deleted', 'closed', 'removed'].includes(verb)) return 'remove'
  return undefined
}

/** All metric buckets in display order. */
export const METRIC_ORDER: { key: MetricKey; label: string }[] = [
  { key: 'spawned', label: 'Agents spawned' },
  { key: 'cards', label: 'Cards created' },
  { key: 'forks', label: 'Forks' },
  { key: 'switches', label: 'Switches' },
  { key: 'removed', label: 'Removed' }
]

/** One LATENCY table row: an event type and the percentile summary for it. */
export interface LatencyRow {
  type: string
  /** eventMeta label, resolved here so the panel stays presentational. */
  label: string
  stats: LatencyStats
}

/**
 * Percentile rollup per event type, computed CLIENT-SIDE from whatever the
 * caller already filtered (p95-p98-latency-metrics-spec §4) — so the workspace
 * / type / time filters apply for free and no new IPC is needed. Untimed
 * events are dropped, which is why an all-untimed log yields [] and the panel
 * can hide the section outright rather than draw a table of zeros.
 *
 * Ordered worst tail first (p95 desc, type asc to break ties deterministically)
 * because the point of the section is finding the offender, not reading an
 * alphabet. Percentile math is Piye's shared module — never re-implemented.
 */
export function latencyRows(events: readonly CookrewEvent[]): LatencyRow[] {
  const byType = new Map<string, number[]>()
  for (const e of events) {
    if (!isTimed(e)) continue
    const bucket = byType.get(e.type)
    if (bucket) bucket.push(e.durationMs as number)
    else byType.set(e.type, [e.durationMs as number])
  }
  const rows: LatencyRow[] = []
  for (const [type, values] of byType) {
    const stats = latencyStats(values)
    if (stats) rows.push({ type, label: eventMeta(type).label, stats })
  }
  return rows.sort((a, b) => b.stats.p95 - a.stats.p95 || a.type.localeCompare(b.type))
}

/**
 * Duration for display. Sub-second stays in ms (the resolution that matters
 * for a boot), seconds get one decimal, and past a minute it reads as m/s —
 * "94.3s" is a number you have to parse, "1m 34s" is one you can feel.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  // 1m 60s is not a time. Carry the rounded-up second into the minute.
  return secs === 60 ? `${mins + 1}m 0s` : `${mins}m ${secs}s`
}

/** Default burst-coalesce window: same type+workspace within this gap merges. */
export const COALESCE_MS = 2000

/**
 * Burst coalescing (projection A): index of a live toast the incoming event
 * should merge into, or -1 for a fresh toast. An event merges when a non-
 * leaving toast of the same type AND workspace was last touched within the
 * window — so a team fork of 11 recruits collapses to one grouped toast while
 * unrelated events stay separate. Pure so the burst behaviour is unit-tested.
 */
export function coalesceIndex(
  toasts: readonly { type: string; workspaceId: string; lastAt: number; leaving: boolean }[],
  event: { type: string; workspaceId: string },
  now: number,
  windowMs: number = COALESCE_MS
): number {
  return toasts.findIndex(
    (t) =>
      !t.leaving &&
      t.type === event.type &&
      t.workspaceId === event.workspaceId &&
      now - t.lastAt <= windowMs
  )
}

interface EventBridge {
  onEvent?: (cb: (e: CookrewEvent) => void) => () => void
  queryEvents?: (filter?: EventFilter) => Promise<CookrewEvent[]>
}

function bridge(): EventBridge {
  return cookrew() as unknown as EventBridge
}

/** True once Forge's real event stream is present on the bridge. */
export function hasEventLog(): boolean {
  return typeof bridge().onEvent === 'function'
}

/** Window channel so a real emit (or a QA dispatch) surfaces without backend. */
const MOCK_EVENT = 'cookrew:mock-event'
/** In-memory mock log so the metrics panel has something to query pre-backend. */
const mockLog: CookrewEvent[] = []

/**
 * Subscribe to the global event stream. Real stream when present; otherwise
 * the window channel, which also appends to the mock log so the metrics panel
 * stays consistent with what the toast feed showed.
 */
export function onEvent(cb: (e: CookrewEvent) => void): () => void {
  const fn = bridge().onEvent
  if (fn) return fn(cb)
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<CookrewEvent>).detail
    if (!detail) return
    mockLog.push(detail)
    cb(detail)
  }
  window.addEventListener(MOCK_EVENT, listener)
  return () => window.removeEventListener(MOCK_EVENT, listener)
}

/**
 * Timed sample events for the mock adapter, so the LATENCY section is
 * exercisable without the live backend. Offsets are relative to `now` (all
 * within the last hour, so every time range shows them) and the durations are
 * deliberately skewed — a long tail on turn.completed is what makes p98
 * diverge from p50 and proves the row is not just an average in disguise.
 *
 * Named "SAMPLE" on purpose: these must be legible as fabricated the moment
 * they land in the timeline next to real observed events.
 */
export const MOCK_LATENCY_SAMPLES: readonly { type: string; agoMs: number; durationMs: number }[] = [
  { type: 'turn.completed', agoMs: 55 * 60_000, durationMs: 4_200 },
  { type: 'turn.completed', agoMs: 48 * 60_000, durationMs: 6_800 },
  { type: 'turn.completed', agoMs: 41 * 60_000, durationMs: 5_100 },
  { type: 'turn.completed', agoMs: 35 * 60_000, durationMs: 9_400 },
  { type: 'turn.completed', agoMs: 28 * 60_000, durationMs: 3_600 },
  { type: 'turn.completed', agoMs: 22 * 60_000, durationMs: 7_900 },
  { type: 'turn.completed', agoMs: 17 * 60_000, durationMs: 12_500 },
  { type: 'turn.completed', agoMs: 11 * 60_000, durationMs: 5_800 },
  { type: 'turn.completed', agoMs: 6 * 60_000, durationMs: 88_000 },
  { type: 'turn.completed', agoMs: 2 * 60_000, durationMs: 4_900 },
  { type: 'workspace.switched', agoMs: 44 * 60_000, durationMs: 310 },
  { type: 'workspace.switched', agoMs: 26 * 60_000, durationMs: 520 },
  { type: 'workspace.switched', agoMs: 9 * 60_000, durationMs: 1_450 },
  { type: 'terminal.booted', agoMs: 52 * 60_000, durationMs: 820 },
  { type: 'terminal.booted', agoMs: 31 * 60_000, durationMs: 1_180 },
  { type: 'terminal.booted', agoMs: 4 * 60_000, durationMs: 640 }
]

/** Build (but do not emit) the sample timed events. Pure — testable. */
export function mockLatencyEvents(now: number): CookrewEvent[] {
  return MOCK_LATENCY_SAMPLES.map((s) => ({
    type: s.type,
    entityId: `sample-${s.type}`,
    entityName: 'SAMPLE',
    workspaceId: 'sample-ws',
    workspaceName: 'Sample workspace',
    actor: 'orch' as EventActor,
    timestamp: now - s.agoMs,
    details: 'mock latency sample',
    durationMs: s.durationMs
  }))
}

/**
 * Seed the mock log with the timed samples. Explicit opt-in, never automatic:
 * fabricated events appearing on their own would read as real history. Refuses
 * when Forge's log is live — the point is to stand in for a missing backend,
 * not to pollute a present one. Emits through the existing window channel so
 * every open query refreshes the same way a real event would.
 */
export function seedMockEvents(now: number = Date.now()): number {
  if (hasEventLog()) {
    console.warn('[event-log] seedMockEvents ignored: the real event log is live')
    return 0
  }
  const events = mockLatencyEvents(now)
  for (const detail of events) {
    window.dispatchEvent(new CustomEvent<CookrewEvent>(MOCK_EVENT, { detail }))
  }
  return events.length
}

function matches(e: CookrewEvent, filter?: EventFilter): boolean {
  if (!filter) return true
  if (filter.workspaceId && e.workspaceId !== filter.workspaceId) return false
  if (filter.types && filter.types.length > 0 && !filter.types.includes(e.type)) return false
  if (filter.since !== undefined && e.timestamp < filter.since) return false
  // Exclusive until, matching Forge's EventQuery semantics.
  if (filter.until !== undefined && e.timestamp >= filter.until) return false
  return true
}

/** Query the event log (newest first). Real API when present, else mock log. */
export async function queryEvents(filter?: EventFilter): Promise<CookrewEvent[]> {
  const fn = bridge().queryEvents
  if (fn) {
    // Bridge may hand back a bare array (remote unwraps) or a {events} wrapper
    // (IPC raw) — accept either.
    const res = (await fn(filter)) as CookrewEvent[] | { events?: CookrewEvent[] } | undefined
    if (Array.isArray(res)) return res
    return res?.events ?? []
  }
  return mockLog.filter((e) => matches(e, filter)).sort((a, b) => b.timestamp - a.timestamp)
}

/** Live query hook: initial fetch + re-query whenever a new event streams in. */
export function useEventQuery(filter?: EventFilter): CookrewEvent[] {
  const [events, setEvents] = useState<CookrewEvent[]>([])
  const key = JSON.stringify(filter ?? {})
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void queryEvents(filter).then((list) => {
        if (alive) setEvents(list)
      })
    }
    refresh()
    const off = onEvent(refresh)
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return events
}
