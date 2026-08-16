import { useMemo, useState, useEffect } from 'react'
import { CrIcon, type CrIconName } from './icons'
import {
  eventMeta,
  hasEventLog,
  kindFor,
  METRIC_ORDER,
  useEventQuery,
  type CookrewEvent,
  type EventFilter
} from './event-log'

type TimeRange = '1h' | '24h' | 'all'

const RANGE_MS: Record<TimeRange, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  all: null
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Metrics / history panel (observability-event-log-spec, projection B): a
 * timeline of lifecycle events plus rolled-up counts (agents spawned, cards
 * created, forks, switches), filterable by workspace / type / time range.
 * Phone-friendly sheet. Fed by the event-log adapter — Forge's query API when
 * present, the mock log otherwise. Fresco owns visual polish.
 */
export function MetricsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [range, setRange] = useState<TimeRange>('24h')
  const [workspace, setWorkspace] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [now, setNow] = useState(() => Date.now())

  // Re-anchor the relative range on open so "last hour" stays meaningful.
  useEffect(() => setNow(Date.now()), [range])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  const span = RANGE_MS[range]
  const filter: EventFilter = useMemo(
    () => (span === null ? {} : { since: now - span }),
    [span, now]
  )
  const all = useEventQuery(filter)

  // Workspace / type option lists come from what's in the (time-filtered) log.
  const workspaces = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of all) if (!seen.has(e.workspaceId)) seen.set(e.workspaceId, e.workspaceName)
    return [...seen.entries()]
  }, [all])
  const types = useMemo(() => [...new Set(all.map((e) => e.type))].sort(), [all])

  const events = useMemo(
    () =>
      all.filter(
        (e) =>
          (workspace === 'all' || e.workspaceId === workspace) &&
          (typeFilter === 'all' || e.type === typeFilter)
      ),
    [all, workspace, typeFilter]
  )

  const counts = useMemo(() => {
    const tally: Record<string, number> = {}
    for (const e of events) {
      const metric = eventMeta(e.type).metric
      if (metric) tally[metric] = (tally[metric] ?? 0) + 1
    }
    return tally
  }, [events])

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel metrics-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="search" />
          <span className="tf-title">ACTIVITY</span>
          <span className="roster-count">{events.length} events</span>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {!hasEventLog() && (
          <div className="tf-banner">
            EVENT LOG NOT WIRED YET — showing events observed this session; the durable
            cross-workspace history lands with Forge&apos;s log.
          </div>
        )}

        <div className="metrics-counts">
          {METRIC_ORDER.map((m) => (
            <div key={m.key} className="metrics-stat">
              <span className="metrics-stat-n">{counts[m.key] ?? 0}</span>
              <span className="metrics-stat-l">{m.label}</span>
            </div>
          ))}
        </div>

        <div className="metrics-filters">
          <div className="metrics-seg">
            {(['1h', '24h', 'all'] as TimeRange[]).map((r) => (
              <button
                key={r}
                className={`cr-chip clickable${range === r ? ' amber' : ''}`}
                onClick={() => setRange(r)}
              >
                {r === 'all' ? 'ALL' : `LAST ${r.toUpperCase()}`}
              </button>
            ))}
          </div>
          <select
            className="dm-cwd-select"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="all">All workspaces</option>
            {workspaces.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="dm-cwd-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {eventMeta(t).label} ({t})
              </option>
            ))}
          </select>
        </div>

        {events.length === 0 ? (
          <div className="tf-role-note">No events in this range.</div>
        ) : (
          <div className="metrics-timeline">
            {events.map((event, i) => (
              <MetricsRow
                key={`${event.timestamp}-${event.entityId}-${i}`}
                event={event}
                showDay={i === 0 || dayLabel(event.timestamp) !== dayLabel(events[i - 1].timestamp)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MetricsRow({ event, showDay }: { event: CookrewEvent; showDay: boolean }): React.JSX.Element {
  const meta = eventMeta(event.type)
  return (
    <>
      {showDay && <div className="metrics-day">{dayLabel(event.timestamp)}</div>}
      <div className="metrics-row">
        <span className="metrics-time">{timeLabel(event.timestamp)}</span>
        <span className="metrics-icon" data-kind={kindFor(event.type)}>
          <CrIcon name={meta.icon as CrIconName} />
        </span>
        <span className="metrics-text">
          <span className="metrics-name">{event.entityName}</span>
          <span className="metrics-verb"> {meta.verb}</span>
          {event.details && <span className="metrics-detail"> · {event.details}</span>}
        </span>
        <span className="metrics-ws" title={event.workspaceName}>
          {event.workspaceName}
        </span>
      </div>
    </>
  )
}
