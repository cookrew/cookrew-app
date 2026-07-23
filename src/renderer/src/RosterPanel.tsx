import { useEffect, useMemo, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { AgentAvatar } from './nodes/AgentAvatar'
import { RoleAvatar } from './nodes/RoleAvatar'
import { hasRegistry, useRoster, type AgentRegistryEntry } from './agent-registry'
import { recoverEligible, recoverErrorToast, recoverToastFor, type RecoverToast } from './recover'
import { dirLabel } from './workspace-v2'
import './agent-roster.css'

/** Once-only loud warn when the bridge lacks recoverAgent. */
let warnedNoRecover = false

/** How long the recover result toast lingers before auto-dismissing. */
const RECOVER_TOAST_MS = 5000

/** Group roster entries by workspace, preserving first-seen workspace order. */
function groupByWorkspace(
  roster: AgentRegistryEntry[]
): { id: string; name: string; agents: AgentRegistryEntry[] }[] {
  const groups = new Map<string, { id: string; name: string; agents: AgentRegistryEntry[] }>()
  for (const entry of roster) {
    const group = groups.get(entry.workspaceId)
    if (group) group.agents.push(entry)
    else groups.set(entry.workspaceId, { id: entry.workspaceId, name: entry.workspaceName, agents: [entry] })
  }
  return [...groups.values()]
}

function agoLabel(since: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * Global agent roster (note item 2): every teammate across ALL workspaces,
 * grouped by workspace with active/inactive flags — so a switch or reboot
 * never hides the crew. Fed by the registry adapter (real API when present,
 * mock from the active workspace otherwise). Phone-friendly sheet. Fresco
 * owns visual polish; this owns structure + data.
 */
export function RosterPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const roster = useRoster()
  const groups = useMemo(() => groupByWorkspace(roster), [roster])
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
    if (!toast) return
    const timer = setTimeout(() => setToast(null), RECOVER_TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // ONE-TAP recover (Conductor ruling: no confirm sheet — recover is
  // non-destructive + reversible). Result → toast, mapped honestly.
  const recover = (agent: AgentRegistryEntry): void => {
    const fn = cookrew().recoverAgent
    if (!fn || recovering !== null) return
    setRecovering(agent.id)
    void fn(agent.id)
      .then((result) => setToast(recoverToastFor(result)))
      .catch((error: unknown) =>
        setToast(recoverErrorToast(error instanceof Error ? error.message : String(error)))
      )
      .finally(() => setRecovering(null))
  }

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel roster-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="agent" />
          <span className="tf-title">ALL AGENTS</span>
          <span className="roster-count">
            {activeCount} active · {roster.length} total
          </span>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {!hasRegistry() && (
          <div className="tf-banner">
            REGISTRY API NOT WIRED YET — showing the active workspace only; the cross-workspace
            roster lands with Forge&apos;s registry.
          </div>
        )}

        {roster.length === 0 ? (
          <div className="tf-role-note">No agents yet.</div>
        ) : (
          <div className="roster-list">
            {groups.map((group) => (
              <div key={group.id} className="roster-group">
                <div className="roster-group-head">
                  <span className="roster-ws-name">{group.name}</span>
                  <span className="roster-ws-count">{group.agents.length}</span>
                </div>
                {group.agents.map((agent) => (
                  <RosterRow
                    key={agent.id}
                    agent={agent}
                    canRecover={canRecover}
                    recovering={recovering === agent.id}
                    onRecover={recover}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Recover result toast (agent-recover): honest mapping of the API
            result — ok / deferred-boot / legacy best-effort / error. */}
        {toast && (
          <div className="roster-toast" data-tone={toast.tone} role="status" aria-live="polite">
            {toast.text}
          </div>
        )}
      </div>
    </div>
  )
}

function RosterRow({
  agent,
  canRecover,
  recovering,
  onRecover
}: {
  agent: AgentRegistryEntry
  canRecover: boolean
  recovering: boolean
  onRecover: (agent: AgentRegistryEntry) => void
}): React.JSX.Element {
  return (
    <div className={`roster-row${agent.active ? '' : ' inactive'}`}>
      <span className="roster-avatar">
        {agent.role ? (
          <RoleAvatar name={agent.role} className="roster-role-avatar" />
        ) : (
          <AgentAvatar preset={agent.preset} phase="idle" />
        )}
      </span>
      <span className="roster-text">
        <span className="roster-name-line">
          <span className="roster-name">{agent.name}</span>
          {agent.orch && <span className="cr-chip amber roster-chip">ORCH</span>}
          {!agent.active && <span className="cr-chip roster-chip roster-off">INACTIVE</span>}
        </span>
        <span className="roster-meta">
          <span className="roster-preset">{agent.preset}</span>
          {agent.role && <span className="roster-role">· {agent.role}</span>}
          <span className="roster-cwd" title={agent.cwd}>
            · {dirLabel(agent.cwd)}
          </span>
        </span>
      </span>
      {/* Inline ONE-TAP recover on eligible (inactive) rows — revealed on row
          hover/selected like row actions (Fresco reserves the slot; always
          visible on touch). Non-destructive + reversible, so no confirm sheet
          (Conductor ruling). Structure pinned with Fresco: coin + label. */}
      {canRecover && recoverEligible(agent) && (
        <button
          className="roster-recover"
          disabled={recovering}
          title={`Recover ${agent.name} — resume its session as it was`}
          onClick={() => onRecover(agent)}
        >
          <span className="roster-recover-coin" aria-hidden="true" />
          {recovering ? 'RECOVERING…' : 'RECOVER'}
        </button>
      )}
      <span className="roster-ago" title={new Date(agent.spawnedAt).toLocaleString()}>
        {agoLabel(agent.spawnedAt)}
      </span>
    </div>
  )
}
