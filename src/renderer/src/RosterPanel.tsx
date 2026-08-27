import { useEffect, useMemo, useRef, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { AgentAvatar } from './nodes/AgentAvatar'
import { RoleAvatar } from './nodes/RoleAvatar'
import { hasRegistry, useRoster, type AgentRegistryEntry } from './agent-registry'
import { AgentRow } from './AgentRow'
import { exportStateOf, useGrantRoster } from './grant-state'
import { EXPORT_ERROR, fill } from './grant-copy'
import { NoteRow } from './NoteRow'
import { BrowserRow } from './BrowserRow'
import { buildAgentRows, type AgentRow as Row } from './agent-rows'
import { advanceClock, type ActivityClock } from './activity-clock'
import { searchAgents } from './agent-search'
import type { TurnMatch } from '../../shared/turn-search'
import {
  EMPTY_FILTER,
  MAX_RETAINED_FACET_EVENTS,
  applyFilter,
  buildFacets,
  eventClock,
  retainFacetEvents,
  type AgentFacets,
  type AgentFilter,
  type FacetEvent,
} from './agent-facets'
import { TeamForkPicker } from './TeamForkPicker'
import { useCanvasUi } from './canvas-ui'
import { useActivitiesSnapshot, useThumbsSnapshot } from './activity-thumb-store'
import { recoverEligible, recoverErrorToast, recoverToastFor, type RecoverToast } from './recover'
import { dirLabel } from './workspace-v2'
import type { BrowserNodeData, NoteNodeData, WorkspaceState } from '../../shared/model'
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
  activeWorkspaceId = null,
  picked: pickedProp,
  onTogglePick,
  onClipStaged,
  editing: editingProp,
  onEditingChange,
  onClose,
  onOpenGrants,
  variant = 'modal',
}: {
  /** Opens WHO CAN CALL — the next step after an agent becomes exportable. */
  onOpenGrants?: () => void
  /** Loaded workspace — what FORK TEAM can act on. Null before it loads. */
  workspace: WorkspaceState | null
  /** Active workspace id — scopes facet tags and what SELECT may pick. */
  activeWorkspaceId?: string | null
  /**
   * The CANVAS clipboard selection, shared: picking on the board IS picking
   * on the canvas, so a copy staged here shows the same tray there. Absent
   * (older callers) → a local set.
   */
  picked?: ReadonlySet<string>
  onTogglePick?: (id: string) => void
  /** COPY/CUT staged from the board — jump to the canvas CLIPBOARD mode. */
  onClipStaged?: () => void
  /**
   * Selection mode, CONTROLLED by App when the dock owns the toggle (view
   * variant): the dock's clipboard button slides in where the canvas tools
   * were and drives this. Absent → local state (modal variant).
   */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  onClose: () => void
  /**
   * `modal` floats over the canvas on a scrim and closes on an outside click.
   * `view` fills the stage as one of the two main views, where the header's
   * switch is what leaves it — so there is no scrim to dismiss and no ✕, which
   * would otherwise be a second, differently-shaped way out of the same place.
   */
  variant?: 'modal' | 'view'
}): React.JSX.Element {
  const roster = useRoster()
  const { zoomToNode } = useCanvasUi()
  // The roster needs the whole map (it lists every agent's live status); it is
  // one sidebar component, not 91 cards, so a snapshot subscription is right.
  const activities = useActivitiesSnapshot()
  const thumbs = useThumbsSnapshot()
  const [showQuiet, setShowQuiet] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Edit mode: rows become checkboxes and the footer becomes team actions. */
  const [localEditing, setLocalEditing] = useState(false)
  const editing = editingProp ?? localEditing
  const setEditing = onEditingChange ?? setLocalEditing
  const [localPicked, setLocalPicked] = useState<ReadonlySet<string>>(() => new Set())
  const picked = pickedProp ?? localPicked
  const togglePick =
    onTogglePick ??
    ((id: string): void => {
      setLocalPicked((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    })
  const [forkOpen, setForkOpen] = useState(false)
  const [filter, setFilter] = useState<AgentFilter>(EMPTY_FILTER)
  /**
   * The facet tags only surface while the search field holds focus — the
   * board's default face is the roster, not the filter chrome. Focus is
   * tracked at the panel root (capture phase) so moving from the input to a
   * facet chip keeps them open; blur fires before click, so state alone on
   * the input would unmount the chips mid-click.
   */
  const [searchHot, setSearchHot] = useState(false)
  /**
   * The cookrew event log, joined to agents by entityId. It is the ONLY
   * cross-workspace signal of when an agent was last touched — live turn state
   * covers the loaded workspace alone — so it both ranks and filters.
   */
  const [events, setEvents] = useState<FacetEvent[]>([])
  /** Checkpoint hits from the whole ledger, keyed by agent. */
  const [hits, setHits] = useState<Map<string, TurnMatch>>(() => new Map())
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
  // Facet TAGS speak for the CURRENT workspace only — a wall of every
  // workspace's presets/roles was noise; the list itself stays global.
  const facets = useMemo(() => {
    const rows = [...all.live, ...all.quiet]
    const scoped =
      activeWorkspaceId === null ? rows : rows.filter((r) => r.workspaceId === activeWorkspaceId)
    return buildFacets(scoped)
  }, [all, activeWorkspaceId])
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
  const results = useMemo(() => {
    if (!searching) return []
    const rows = [...live, ...quiet]
    const direct = searchAgents(rows, query)
    // An agent whose only match is in its HISTORY still belongs in the results;
    // searchAgents only sees what the row currently displays.
    const seen = new Set(direct.map((r) => r.id))
    const historical = rows.filter((r) => !seen.has(r.id) && hits.has(r.id))
    return [...direct, ...historical]
  }, [searching, live, quiet, query, hits])
  const activeCount = roster.filter((a) => a.active).length
  // The active workspace's NOTES & BROWSERS join the board in the SAME row
  // family as agents, but each kind binds ITS OWN body from the exact
  // source its canvas card uses: a note's content from the workspace state
  // (what NoteNode renders), a browser's snapshot from the shared `thumbs`
  // record (what BrowserNode shows). Three kinds — never one mechanical
  // template. Search narrows by name, url, or note content.
  const elements = useMemo(() => {
    if (!workspace) return []
    const q = query.trim().toLowerCase()
    return workspace.nodes
      .filter((n) => n.kind !== 'terminal')
      .filter(
        (n) =>
          q.length === 0 ||
          n.name.toLowerCase().includes(q) ||
          (n.kind === 'browser' && (n as BrowserNodeData).url.toLowerCase().includes(q)) ||
          (n.kind === 'note' && (n as NoteNodeData).content.toLowerCase().includes(q)),
      )
  }, [workspace, query])
  /**
   * The grant roster — ONE read for the whole list, shared by every row, so
   * "who can call this" stays legible at rest without forty IPC round trips.
   */
  const { roster: grants, refresh: refreshGrants } = useGrantRoster(activeWorkspaceId)

  /**
   * The first inch of the author journey: mark an agent exportable, or stop.
   *
   * Exporting to NOBODY is the whole point of the two-level model — it makes
   * the agent appear in the grant matrix to be ticked, and it entitles no one
   * until the owner grants someone. The gate reads the same record and its
   * closed default is unchanged.
   */
  const setExportable = async (nodeId: string, name: string, on: boolean): Promise<void> => {
    const api = cookrew() as unknown as {
      grantExport?: (w: string, n: string, c: string[]) => Promise<{ ok: boolean }>
      grantUnexport?: (w: string, n: string) => Promise<{ ok: boolean }>
    }
    if (!activeWorkspaceId) return
    // In flight, so one press cannot become two. Keyed by node: exporting one
    // agent must not freeze the control on every other row.
    setExportBusy(nodeId)
    setExportError((prior) => ({ ...prior, [nodeId]: null }))
    try {
      const call = on
        ? api.grantExport?.(activeWorkspaceId, nodeId, [])
        : api.grantUnexport?.(activeWorkspaceId, nodeId)
      // A bridge without the method resolves undefined, which used to read as
      // success and silently do nothing — the failure mode that makes a control
      // look broken and invites a second press.
      const result = await call
      if (!result?.ok) throw new Error('refused')
      await refreshGrants()
    } catch {
      const copy = on ? EXPORT_ERROR.on : EXPORT_ERROR.off
      setExportError((prior) => ({ ...prior, [nodeId]: fill(copy.text, { agent: name }) }))
    } finally {
      setExportBusy(null)
    }
  }

  /** Node whose export toggle is in flight, and any per-node failure to show. */
  const [exportBusy, setExportBusy] = useState<string | null>(null)
  const [exportError, setExportError] = useState<Record<string, string | null>>({})

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

  /**
   * Checkpoint search runs in MAIN over every agent's turn ledger — the only
   * corpus that is both cross-workspace and small enough to scan. Debounced,
   * because it reads ~3 MB; only snippets come back, never turn bodies.
   */
  useEffect(() => {
    const search = cookrew().searchTurns
    if (typeof search !== 'function' || !searching) {
      setHits(new Map())
      return
    }
    const timer = setTimeout(() => {
      void search(query, 200)
        .then((matches) => {
          // Best hit per agent — the row shows one line, not a thread.
          const best = new Map<string, TurnMatch>()
          for (const match of matches) {
            const seen = best.get(match.terminalId)
            if (!seen || match.score > seen.score) best.set(match.terminalId, match)
          }
          setHits(best)
        })
        .catch(() => undefined)
    }, 150)
    return () => clearTimeout(timer)
  }, [query, searching])

  // One read of the log on open, then follow the live stream. Metadata only —
  // no conversation text ever crosses this wire (main/event-log.ts).
  useEffect(() => {
    const query = cookrew().queryEvents
    if (typeof query !== 'function') return
    void query({ limit: MAX_RETAINED_FACET_EVENTS })
      .then((list) => setEvents(retainFacetEvents(list as FacetEvent[])))
      .catch(() => undefined)
    const off = cookrew().onEvent?.((event) =>
      setEvents((prior) => retainFacetEvents([...prior, event as FacetEvent])),
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

  // The clipboard stages from the ACTIVE canvas only (that is what a paste
  // reads) — picking a foreign-workspace row says so instead of no-opping.
  const toggle = (row: Row): void => {
    if (activeWorkspaceId !== null && row.workspaceId !== activeWorkspaceId) {
      setToast({
        tone: 'warn',
        text: `“${row.name}” lives in ${row.workspaceName} — switch there to clip it`,
      })
      return
    }
    togglePick(row.id)
  }

  /** COPY/CUT from the board: stage the shared selection, land on the
   *  canvas in CLIPBOARD mode where the tray shows what's staged. */
  const runClip = (cut: boolean): void => {
    const set = cookrew().teamClipSet
    if (!set || picked.size === 0) return
    void set([...picked], cut)
      .then(() => {
        setEditing(false)
        onClipStaged?.()
      })
      .catch((error: unknown) =>
        setToast({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        }),
      )
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

  /** Element click: tick in edit mode, hand off to the canvas otherwise. */
  const openElement = (id: string): void => {
    if (editing) {
      togglePick(id)
      return
    }
    zoomToNode(id)
    onClose()
  }

  const renderElement = (node: (typeof elements)[number]): React.JSX.Element =>
    node.kind === 'note' ? (
      <NoteRow
        key={node.id}
        node={node as NoteNodeData}
        workspaceName={workspace?.name ?? ''}
        selected={editing ? picked.has(node.id) : selected === node.id}
        selectable={editing}
        onOpen={openElement}
      />
    ) : (
      <BrowserRow
        key={node.id}
        node={node as BrowserNodeData}
        thumb={thumbs[node.id]}
        workspaceName={workspace?.name ?? ''}
        selected={editing ? picked.has(node.id) : selected === node.id}
        selectable={editing}
        onOpen={openElement}
      />
    )

  const renderRow = (row: Row): React.JSX.Element => (
    <AgentRow
      key={row.id}
      row={row}
      now={now}
      selected={editing ? picked.has(row.id) : selected === row.id}
      recovering={recovering === row.id}
      canRecover={!editing && canRecover && recoverEligible(row)}
      hit={hits.get(row.id) ?? null}
      selectable={editing}
      exportState={editing ? null : exportStateOf(grants, row.id)}
      exportBusy={exportBusy === row.id}
      exportError={exportError[row.id] ?? null}
      onExport={(r) => void setExportable(r.id, r.name, true)}
      onUnexport={(r) => void setExportable(r.id, r.name, false)}
      onOpenGrants={onOpenGrants}
      onOpen={editing ? toggle : open}
      onRecover={recover}
    />
  )

  return (
    <div
      className={variant === 'view' ? 'roster-view' : 'tf-scrim'}
      onClick={variant === 'view' ? undefined : onClose}
    >
      <div
        className="tf-panel roster-panel"
        onClick={(e) => e.stopPropagation()}
        onFocusCapture={(e) => {
          if ((e.target as Element).closest?.('.roster-search, .roster-facets')) setSearchHot(true)
        }}
        onBlurCapture={(e) => {
          const next = e.relatedTarget as Element | null
          if (!next?.closest?.('.roster-search, .roster-facets')) setSearchHot(false)
        }}
      >
        <div className="tf-head">
          <CrIcon name="agent" />
          <span className="tf-title">BOARD</span>
          <span className="roster-count">
            {searching
              ? `${results.length} of ${roster.length}`
              : `${activeCount} active · ${roster.length} total`}
          </span>
          {/* Search ranks the crew by anything you remember — who they are, or
              what was said. It lives in the header's top-right and never grabs
              focus on its own: opening BOARD lands on the roster. Conversation
              text covers the LOADED workspace only. */}
          <div className="roster-search">
            <CrIcon name="search" />
            <input
              className="roster-search-input"
              type="search"
              value={query}
              placeholder="Search agents, tasks, replies…"
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
          {variant === 'modal' && (
            <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
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
            here: the event log carries none by design. Shown only while the
            search field is hot. */}
        {searchHot && <FacetBar facets={facets} filter={filter} onChange={setFilter} />}

        {roster.length === 0 && elements.length === 0 ? (
          <div className="tf-role-note">No agents yet.</div>
        ) : searching ? (
          <div className="roster-list">
            {results.length === 0 && elements.length === 0 ? (
              <div className="tf-role-note">
                Nothing matches “{query.trim()}” — in any agent's name, current task, or checkpoint
                history.
              </div>
            ) : (
              <>
                {results.map(renderRow)}
                {elements.map(renderElement)}
              </>
            )}
          </div>
        ) : (
          <div className="roster-list">
            {live.map(renderRow)}
            {/* Notes & browsers of the active workspace — each kind binds
                its own canvas-card source (NoteRow / BrowserRow). */}
            {elements.map(renderElement)}

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

        {/* Edit mode footer: COPY/CUT share the canvas clipboard (the same
            selection, the same tray); the fork sheet is the existing
            TeamForkPicker — not a second implementation of forking. */}
        {editing && (
          <div className="roster-edit-bar">
            <span className="roster-edit-count">{picked.size} SELECTED</span>
            <span className="roster-edit-spacer" />
            {typeof cookrew().teamClipSet === 'function' && (
              <>
                <button
                  className="cr-btn sm"
                  disabled={picked.size === 0}
                  title="Copy the selection to the clipboard — lands on the canvas in CLIPBOARD mode"
                  onClick={() => runClip(false)}
                >
                  COPY
                </button>
                <button
                  className="cr-btn sm"
                  disabled={picked.size === 0}
                  title="Cut the selection — pasting moves it out of this workspace"
                  onClick={() => runClip(true)}
                >
                  CUT
                </button>
              </>
            )}
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
