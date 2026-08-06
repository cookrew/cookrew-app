import { useEffect, useMemo, useRef, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { AgentAvatar } from './nodes/AgentAvatar'
import { RoleAvatar } from './nodes/RoleAvatar'
import { hasRegistry, useRoster, type AgentRegistryEntry } from './agent-registry'
import { AgentRow } from './AgentRow'
import { buildAgentRows, type AgentRow as Row } from './agent-rows'
import { advanceClock, type ActivityClock } from './activity-clock'
import { searchAgents } from './agent-search'
import {
  EMPTY_FILTER,
  applyFilter,
  buildFacets,
  eventClock,
  type AgentFacets,
  type AgentFilter,
  type FacetEvent,
} from './agent-facets'
import { TeamForkPicker } from './TeamForkPicker'
import { useCanvasUi } from './canvas-ui'
import { recoverEligible, recoverErrorToast, recoverToastFor, type RecoverToast } from './recover'
import { dirLabel } from './workspace-v2'
import type { WorkspaceState } from '../../shared/model'
import './agent-roster.css'

/** Once-only loud warn when the bridge lacks recoverAgent. */
let warnedNoRecover = false

/** How long the recover result toast lingers before auto-dismissing. */
const RECOVER_TOAST_MS = 5000

/**
 * Global agent roster (note item 2): every teammate across ALL workspaces,
 * grouped by workspace with active/inactive flags — so a switch or reboot
 * never hides the crew. Fed by the registry adapter (real API when present,
 * mock from the active workspace otherwise). Phone-friendly sheet. Fresco
 * owns visual polish; this owns structure + data.
 */
export function RosterPanel({
  workspace,
  onClose,
}: {
  /** Loaded workspace — what FORK TEAM can act on. Null before it loads. */
  workspace: WorkspaceState | null
  onClose: () => void
}): React.JSX.Element {
  const roster = useRoster()
  const { activities, zoomToNode } = useCanvasUi()
  const [showQuiet, setShowQuiet] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Edit mode: rows become checkboxes and the footer becomes team actions. */
  const [editing, setEditing] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [forkOpen, setForkOpen] = useState(false)
  const [filter, setFilter] = useState<AgentFilter>(EMPTY_FILTER)
  /**
   * The cookrew event log, joined to agents by entityId. It is the ONLY
   * cross-workspace signal of when an agent was last touched — live turn state
   * covers the loaded workspace alone — so it both ranks and filters.
   */
  const [events, setEvents] = useState<FacetEvent[]>([])
  // One clock for every relative label — 228 rows must not each own a timer.
  const [now, setNow] = useState(() => Date.now())
  // When each agent last DID something, as opposed to when the tracker last
  // re-serialized it. This is what the ranking uses; updatedAt advances four
  // times a second and reordered the list continuously (activity-clock.ts).
  const clock = useRef<ActivityClock>({})
  clock.current = advanceClock(clock.current, activities, Date.now())
  const changedAt = useMemo(
    () => ({ ...eventClock(events), ...clock.current }),
    [events, clock.current],
  )
  const all = useMemo(
    () => buildAgentRows({ roster, activities, now, changedAt }),
    [roster, activities, now, changedAt],
  )
  const facets = useMemo(() => buildFacets([...all.live, ...all.quiet]), [all])
  const { live, quiet } = useMemo(
    () => ({
      live: applyFilter(all.live, filter),
      quiet: applyFilter(all.quiet, filter),
    }),
    [all, filter],
  )
  // Searching looks through the WHOLE crew: a quiet agent you are hunting for
  // by name must not be hidden behind a disclosure.
  const searching = query.trim().length > 0
  const results = useMemo(
    () => (searching ? searchAgents([...live, ...quiet], query) : []),
    [searching, live, quiet, query],
  )
  const activeCount = roster.filter((a) => a.active).length
  /** Id of the row whose recover is in flight (disables its button). */
  const [recovering, setRecovering] = useState<string | null>(null)
  /** Transient recover-result toast (ok / defer / warn / error). */
  const [toast, setToast] = useState<RecoverToast | null>(null)
  // LIVE api only (never mocked): the button renders once the bridge has it —
  // both IPC and the phone remote expose recoverAgent (api/remote parity).
  const canRecover = typeof cookrew().recoverAgent === 'function'
  if (!canRecover && !warnedNoRecover) {
    // Loud-absent-bridge rule: a missing op degrades visibly in the console,
    // never silently (the listTraceIndex lesson).
    warnedNoRecover = true
    console.error('[roster] recoverAgent missing on this bridge — RECOVER hidden (older build?)')
  }

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

  // Auto-dismiss the recover toast.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // One read of the log on open, then follow the live stream. Metadata only —
  // no conversation text ever crosses this wire (main/event-log.ts).
  useEffect(() => {
    const query = cookrew().queryEvents
    if (typeof query !== 'function') return
    void query({ limit: 4000 })
      .then((list) => setEvents(list as FacetEvent[]))
      .catch(() => undefined)
    const off = cookrew().onEvent?.((event) =>
      setEvents((prior) => [...prior, event as FacetEvent]),
    )
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), RECOVER_TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // ONE-TAP recover (Conductor ruling: no confirm sheet — recover is
  // non-destructive + reversible). Result → toast, mapped honestly.
  // A row click is a handoff, not an expand: select here, zoom there. The
  // canvas already owns the trace reader, the checkpoint rail and fork.
  const open = (row: Row): void => {
    setSelected(row.id)
    if (row.active) {
      zoomToNode(row.id)
      onClose()
    }
  }

  const toggle = (row: Row): void => {
    const next = new Set(picked)
    if (next.has(row.id)) next.delete(row.id)
    else next.add(row.id)
    setPicked(next)
  }

  const recover = (row: Row): void => {
    const fn = cookrew().recoverAgent
    if (!fn || recovering !== null) return
    setRecovering(row.id)
    void fn(row.id)
      .then((result) => setToast(recoverToastFor(result)))
      .catch((error: unknown) =>
        setToast(recoverErrorToast(error instanceof Error ? error.message : String(error))),
      )
      .finally(() => setRecovering(null))
  }

  const renderRow = (row: Row): React.JSX.Element => (
    <AgentRow
      key={row.id}
      row={row}
      now={now}
      selected={editing ? picked.has(row.id) : selected === row.id}
      recovering={recovering === row.id}
      canRecover={!editing && canRecover && recoverEligible(row)}
      selectable={editing}
      onOpen={editing ? toggle : open}
      onRecover={recover}
    />
  )

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel roster-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="agent" />
          <span className="tf-title">ALL AGENTS</span>
          <span className="roster-count">
            {searching
              ? `${results.length} of ${roster.length}`
              : `${activeCount} active · ${roster.length} total`}
          </span>
          <button
            className={`cr-btn sm${editing ? ' on' : ''}`}
            title="Select agents to save or fork as a team"
            onClick={() => {
              setEditing(!editing)
              setPicked(new Set())
            }}
          >
            {editing ? 'DONE' : 'SELECT'}
          </button>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {/* Search ranks the crew by anything you remember — who they are, or
            what was said. Conversation text covers the LOADED workspace only;
            the note below says so rather than letting it look complete. */}
        <div className="roster-search">
          <CrIcon name="search" />
          <input
            className="roster-search-input"
            type="search"
            value={query}
            placeholder="Search agents, tasks, replies…"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
          />
          {searching && (
            <button className="cr-btn sm icon" title="Clear" onClick={() => setQuery('')}>
              <CrIcon name="close" />
            </button>
          )}
        </div>

        {!hasRegistry() && (
          <div className="tf-banner">
            REGISTRY API NOT WIRED YET — showing the active workspace only; the cross-workspace
            roster lands with Forge&apos;s registry.
          </div>
        )}

        {/* Facets from the registry + event log — structured narrowing, which
            is what these records can answer well. Conversation text is NOT
            here: the event log carries none by design. */}
        <FacetBar facets={facets} filter={filter} onChange={setFilter} />

        {roster.length === 0 ? (
          <div className="tf-role-note">No agents yet.</div>
        ) : searching ? (
          <div className="roster-list">
            {results.length === 0 ? (
              <div className="tf-role-note">
                Nothing matches “{query.trim()}”. Conversation text is searched for the loaded
                workspace only.
              </div>
            ) : (
              results.map(renderRow)
            )}
          </div>
        ) : (
          <div className="roster-list">
            {live.map(renderRow)}

            {/* The 228 collapse: agents that have never run a turn carry no
                information, so they fold behind one row instead of filling
                the panel. */}
            {quiet.length > 0 && (
              <>
                {showQuiet && quiet.map(renderRow)}
                <button className="roster-quiet" onClick={() => setShowQuiet(!showQuiet)}>
                  {showQuiet ? `HIDE ${quiet.length} QUIET` : `+ ${quiet.length} QUIET · SHOW`}
                </button>
              </>
            )}
          </div>
        )}

        {/* Edit mode footer: the fork sheet is the existing TeamForkPicker,
            handed this selection — not a second implementation of forking. */}
        {editing && (
          <div className="roster-edit-bar">
            <span className="roster-edit-count">{picked.size} SELECTED</span>
            <span className="roster-edit-spacer" />
            <button
              className="cr-btn sm"
              disabled={picked.size === 0 || !workspace}
              title={
                workspace
                  ? 'Fork the selected agents into a new workspace'
                  : 'Forking needs a loaded workspace'
              }
              onClick={() => setForkOpen(true)}
            >
              FORK TEAM
            </button>
          </div>
        )}

        {/* Recover result toast (agent-recover): honest mapping of the API
            result — ok / deferred-boot / legacy best-effort / error. */}
        {toast && (
          <div className="roster-toast" data-tone={toast.tone} role="status" aria-live="polite">
            {toast.text}
          </div>
        )}

        {forkOpen && workspace && (
          <TeamForkPicker workspace={workspace} seed={picked} onClose={() => setForkOpen(false)} />
        )}
      </div>
    </div>
  )
}

/** OR within a facet, AND across facets — chips, as people expect them. */
function FacetBar({
  facets,
  filter,
  onChange,
}: {
  facets: AgentFacets
  filter: AgentFilter
  onChange: (next: AgentFilter) => void
}): React.JSX.Element | null {
  const groups: {
    key: keyof AgentFilter
    items: { value: string; count: number; id?: string }[]
  }[] = [
    { key: 'states', items: facets.states },
    { key: 'presets', items: facets.presets },
    { key: 'roles', items: facets.roles },
    { key: 'workspaceIds', items: facets.workspaces },
  ]
  const active = groups.some((g) => filter[g.key].length > 0)
  if (facets.presets.length + facets.roles.length + facets.workspaces.length === 0) return null

  const toggle = (key: keyof AgentFilter, value: string): void => {
    const current = filter[key] as string[]
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    onChange({ ...filter, [key]: next } as AgentFilter)
  }

  return (
    <div className="roster-facets">
      {active && (
        <button className="cr-chip clickable" onClick={() => onChange(EMPTY_FILTER)}>
          CLEAR
        </button>
      )}
      {groups.map((group) =>
        group.items.map((item) => {
          // Workspaces filter by id but read as their name.
          const value = item.id ?? item.value
          const on = (filter[group.key] as string[]).includes(value)
          return (
            <button
              key={`${group.key}:${value}`}
              className={`cr-chip clickable${on ? ' amber' : ''}`}
              title={`${item.value} · ${item.count}`}
              onClick={() => toggle(group.key, value)}
            >
              {item.value} {item.count}
            </button>
          )
        }),
      )}
    </div>
  )
}
