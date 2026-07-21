import { useEffect, useState } from 'react'
import { cookrew } from './api'

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
}

export type MetricKey = 'spawned' | 'cards' | 'forks' | 'switches' | 'removed'

const META: Record<string, EventMeta> = {
  'terminal.recruited': { label: 'Recruited', verb: 'recruited', noun: 'agent', icon: 'agent', hatch: true, metric: 'spawned' },
  'terminal.created': { label: 'Created', verb: 'created', noun: 'terminal', icon: 'terminal', hatch: true, metric: 'spawned' },
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
  'team.saved': { label: 'Team', verb: 'saved', noun: 'team', icon: 'fork', hatch: false, metric: null }
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
  if (['created', 'saved', 'made', 'recruited'].includes(verb)) return 'create'
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
