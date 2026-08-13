import { useMemo, useState, useEffect } from 'react'
import { CrIcon, type CrIconName } from './icons'
import {
  eventMeta,
  formatDuration,
  hasEventLog,
  kindFor,
  latencyRows,
  METRIC_ORDER,
  seedMockEvents,
  useEventQuery,
  type CookrewEvent,
  type EventFilter,
  type LatencyRow
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

  // Derived from the SAME already-filtered list the timeline draws, so the
  // workspace / type / time filters apply to the percentiles for free.
  const latency = useMemo(() => latencyRows(events), [events])

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
            <button
              className="cr-btn sm metrics-latency-seed"
              onClick={() => seedMockEvents()}
              title="Add fabricated timed events so the LATENCY section renders"
            >
              LOAD SAMPLE LATENCY
            </button>
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

        {/* Hidden outright when nothing in range carries a duration: a latency
            table with no samples would be a grid of dashes claiming meaning. */}
        {latency.length > 0 && (
          <div className="metrics-latency">
            <div className="metrics-latency-head">
              <span className="metrics-latency-title">LATENCY</span>
              <span className="metrics-latency-sub">
                {latency.reduce((n, r) => n + r.stats.count, 0)} timed events
              </span>
            </div>
            <table className="metrics-latency-table">
              <thead>
                <tr>
                  <th className="metrics-latency-th" scope="col">
                    EVENT
                  </th>
                  <th className="metrics-latency-th num" scope="col">
                    N
                  </th>
                  {LATENCY_STATS.map((s) => (
                    <th key={s.key} className="metrics-latency-th num" data-stat={s.key} scope="col">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {latency.map((row) => (
                  <LatencyTableRow key={row.type} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}

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

/** Percentile columns, in display order. `key` doubles as Fresco's data hook. */
const LATENCY_STATS: { key: 'p50' | 'p95' | 'p98' | 'max'; label: string }[] = [
  { key: 'p50', label: 'P50' },
  { key: 'p95', label: 'P95' },
  { key: 'p98', label: 'P98' },
  { key: 'max', label: 'MAX' }
]

function LatencyTableRow({ row }: { row: LatencyRow }): React.JSX.Element {
  const meta = eventMeta(row.type)
  return (
    <tr className="metrics-latency-row" data-type={row.type} data-kind={kindFor(row.type)}>
      <th className="metrics-latency-type" scope="row" title={row.type}>
        <span className="metrics-latency-icon">
          <CrIcon name={meta.icon as CrIconName} />
        </span>
        <span className="metrics-latency-label">{row.label}</span>
        <span className="metrics-latency-slug">{row.type}</span>
      </th>
      <td className="metrics-latency-n num">{row.stats.count}</td>
      {LATENCY_STATS.map((s) => (
        <td key={s.key} className="metrics-latency-cell num" data-stat={s.key}>
          {formatDuration(row.stats[s.key])}
        </td>
      ))}
    </tr>
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
