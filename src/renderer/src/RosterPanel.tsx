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
  // One clock for every relative label — 228 rows must not each own a timer.
  const [now, setNow] = useState(() => Date.now())
  // When each agent last DID something, as opposed to when the tracker last
  // re-serialized it. This is what the ranking uses; updatedAt advances four
  // times a second and reordered the list continuously (activity-clock.ts).
  const clock = useRef<ActivityClock>({})
  clock.current = advanceClock(clock.current, activities, Date.now())
  const { live, quiet } = useMemo(
    () => buildAgentRows({ roster, activities, now, changedAt: clock.current }),
    [roster, activities, now],
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
