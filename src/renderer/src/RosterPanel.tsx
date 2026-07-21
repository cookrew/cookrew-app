import { useEffect, useMemo } from 'react'
import { CrIcon } from './icons'
import { AgentAvatar } from './nodes/AgentAvatar'
import { RoleAvatar } from './nodes/RoleAvatar'
import { hasRegistry, useRoster, type AgentRegistryEntry } from './agent-registry'
import { dirLabel } from './workspace-v2'
import './agent-roster.css'

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
                  <RosterRow key={agent.id} agent={agent} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RosterRow({ agent }: { agent: AgentRegistryEntry }): React.JSX.Element {
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
      <span className="roster-ago" title={new Date(agent.spawnedAt).toLocaleString()}>
        {agoLabel(agent.spawnedAt)}
      </span>
    </div>
  )
}
