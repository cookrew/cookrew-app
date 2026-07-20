import { useEffect, useMemo, useState } from 'react'
import type {
  AgentRole,
  TeamForkSpec,
  TeamMeta,
  WorkspaceState
} from '../../shared/model'
import { cookrew } from './api'
import { CrIcon, type CrIconName } from './icons'
import { RoleAvatar } from './nodes/RoleAvatar'
import { DEFAULT_CHOICE, TeamTurnChooser, type TerminalChoice } from './TeamTurnChooser'
import './team-fork.css'

const KIND_ICON: Record<string, CrIconName> = {
  terminal: 'agent',
  note: 'note',
  browser: 'browser'
}

function dateLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Team fork picker: choose which canvas elements travel into a forked
 * workspace and, per terminal, which turn context they carry (latest /
 * first / assembled selection / fresh from role). Also hosts team save —
 * snapshotting the live canvas so later forks can start from the saved
 * version instead of live state. Fork executes the team:fork contract
 * (see the team-fork-roles-spec note); if the API is unavailable the spec
 * preview still shows what would be sent and errors surface inline.
 */
export function TeamForkPicker({
  workspace,
  onClose
}: {
  workspace: WorkspaceState
  onClose: () => void
}): React.JSX.Element {
  const nodes = workspace.nodes
  const [included, setIncluded] = useState<ReadonlySet<string>>(
    () => new Set(nodes.map((n) => n.id))
  )
  const [choices, setChoices] = useState<Record<string, TerminalChoice>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [teams, setTeams] = useState<TeamMeta[]>([])
  const [roles, setRoles] = useState<AgentRole[]>([])
  const [apiMissing, setApiMissing] = useState(false)
  const [source, setSource] = useState<'live' | string>('live')
  const [forkName, setForkName] = useState('')
  const [saveName, setSaveName] = useState('')
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState<'fork' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void cookrew()
      .teamList()
      .then(setTeams)
      .catch(() => setApiMissing(true))
    void cookrew()
      .roleList()
      .then(setRoles)
      .catch(() => undefined)
  }, [])

  // ESC closes the picker (before it ever reaches the canvas zoom-back).
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

  const roleFor = (nodeRole: string | null | undefined): string | null => {
    if (!nodeRole) return null
    // Gate on the saved role actually existing when the list is available.
    if (roles.length > 0) return roles.some((r) => r.name === nodeRole) ? nodeRole : null
    return nodeRole
  }

  const toggleIncluded = (id: string): void => {
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const choiceOf = (id: string): TerminalChoice => choices[id] ?? DEFAULT_CHOICE

  const spec: TeamForkSpec = useMemo(() => {
    if (source !== 'live') {
      return { name: forkName.trim() || undefined, nodeIds: [], choices: [], fromSavedTeam: source }
    }
    const terminals = nodes.filter((n) => n.kind === 'terminal' && included.has(n.id))
    return {
      name: forkName.trim() || undefined,
      nodeIds: nodes.filter((n) => included.has(n.id)).map((n) => n.id),
      choices: terminals.map((t) => {
        const choice = choiceOf(t.id)
        return {
          nodeId: t.id,
          mode: choice.mode,
          ...(choice.mode === 'assembled' ? { turnIndexes: choice.turnIndexes } : {}),
          ...(choice.mode === 'role'
            ? { roleName: (t as { role?: string | null }).role ?? undefined }
            : {})
        }
      })
    }
  }, [source, forkName, nodes, included, choices])

  const incompleteAssembly =
    source === 'live'
      ? nodes.find(
          (n) =>
            n.kind === 'terminal' &&
            included.has(n.id) &&
            choiceOf(n.id).mode === 'assembled' &&
            choiceOf(n.id).turnIndexes.length === 0
        )
      : undefined
  const nothingIncluded = source === 'live' && spec.nodeIds.length === 0

  const runFork = (): void => {
    if (busy) return
    setBusy('fork')
    setError(null)
    void cookrew()
      .teamFork(spec)
      .then(() => onClose())
      .catch((err: unknown) => {
        setBusy(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const runSave = (): void => {
    if (busy) return
    setBusy('save')
    setError(null)
    void cookrew()
      .teamSave(saveName.trim() || undefined)
      .then((meta) => {
        setBusy(null)
        setSavedFlash(meta.name)
        setSaveName('')
        void cookrew().teamList().then(setTeams).catch(() => undefined)
      })
      .catch((err: unknown) => {
        setBusy(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const sourceTeam = teams.find((t) => t.name === source)

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="fork" />
          <span className="tf-title">FORK TEAM</span>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {apiMissing && (
          <div className="tf-banner">
            TEAM API UNAVAILABLE — the picker previews the fork spec; forking is disabled
            until the app exposes the team API.
          </div>
        )}

        {teams.length > 0 && (
          <div className="tf-source">
            <span className="tf-label">SOURCE</span>
            <button
              className={`cr-chip clickable${source === 'live' ? ' amber' : ''}`}
              onClick={() => setSource('live')}
            >
              LIVE CANVAS
            </button>
            {teams.map((team) => (
              <button
                key={team.name}
                className={`cr-chip clickable${source === team.name ? ' amber' : ''}`}
                title={`Saved ${dateLabel(team.savedAt)} · ${team.nodeCount} nodes`}
                onClick={() => setSource(team.name)}
              >
                {team.name}
              </button>
            ))}
          </div>
        )}

        {source === 'live' ? (
          <div className="tf-list">
            {nodes.map((node) => {
              const isTerminal = node.kind === 'terminal'
              const nodeRole = roleFor((node as { role?: string | null }).role)
              const isIncluded = included.has(node.id)
              const isOpen = expanded.has(node.id)
              const choice = choiceOf(node.id)
              return (
                <div key={node.id} className={`tf-row${isIncluded ? '' : ' excluded'}`}>
                  <div className="tf-row-main">
                    <button
                      className={`tf-include${isIncluded ? ' on' : ''}`}
                      title={isIncluded ? 'Leave behind' : 'Include in fork'}
                      onClick={() => toggleIncluded(node.id)}
                    >
                      {isIncluded && <CrIcon name="check" />}
                    </button>
                    <span className="tf-kind">
                      <CrIcon name={KIND_ICON[node.kind] ?? 'dot'} />
                    </span>
                    <span className="tf-name">{node.name}</span>
                    {isTerminal && (
                      <button
                        className={`cr-chip clickable tf-mode-chip${choice.mode === 'role' ? ' role amber' : ''}`}
                        title="Choose the turn context this agent forks from"
                        disabled={!isIncluded}
                        onClick={() => toggleExpanded(node.id)}
                      >
                        {choice.mode === 'role' && nodeRole && (
                          <RoleAvatar name={nodeRole} className="role-avatar" />
                        )}
                        {choice.mode === 'assembled'
                          ? `ASSEMBLE (${choice.turnIndexes.length})`
                          : choice.mode === 'role'
                            ? `ROLE · ${(nodeRole ?? '').toUpperCase()}`
                            : choice.mode.toUpperCase()}
                        <CrIcon name={isOpen ? 'caret-down' : 'caret-right'} />
                      </button>
                    )}
                  </div>
                  {isTerminal && isIncluded && isOpen && (
                    <TeamTurnChooser
                      terminalId={node.id}
                      roleName={nodeRole}
                      choice={choice}
                      onChange={(next) => setChoices((prev) => ({ ...prev, [node.id]: next }))}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="tf-saved-summary">
            <p>
              Forks the saved snapshot <strong>{source}</strong>
              {sourceTeam ? (
                <>
                  {' '}
                  ({sourceTeam.terminalCount} agents, {sourceTeam.nodeCount} nodes, saved{' '}
                  {dateLabel(sourceTeam.savedAt)})
                </>
              ) : null}
              — every agent at its saved latest turn. The live canvas stays untouched.
            </p>
          </div>
        )}

        {source === 'live' && (
          <div className="tf-save">
            <span className="tf-label">SAVE TEAM</span>
            <input
              className="tf-input"
              placeholder={workspace.name}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSave()}
            />
            <button className="cr-btn sm" disabled={busy !== null} onClick={runSave}>
              {busy === 'save' ? 'SAVING…' : 'SAVE'}
            </button>
            {savedFlash && <span className="tf-saved-flash">saved “{savedFlash}” ✓</span>}
          </div>
        )}

        {error && <div className="tf-error">{error}</div>}
        {incompleteAssembly && (
          <div className="tf-hint">
            Pick at least one turn for “{incompleteAssembly.name}” or switch it off ASSEMBLE.
          </div>
        )}

        <details className="tf-preview">
          <summary>fork spec preview</summary>
          <pre>{JSON.stringify(spec, null, 2)}</pre>
        </details>

        <div className="tf-foot">
          <input
            className="tf-input tf-fork-name"
            placeholder={`${workspace.name} fork`}
            value={forkName}
            onChange={(e) => setForkName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runFork()}
          />
          <button className="cr-btn sm" onClick={onClose}>
            CANCEL
          </button>
          <button
            className="cr-btn sm primary"
            disabled={busy !== null || incompleteAssembly !== undefined || nothingIncluded}
            onClick={runFork}
          >
            <CrIcon name="fork" /> {busy === 'fork' ? 'FORKING…' : 'FORK TEAM'}
          </button>
        </div>
      </div>
    </div>
  )
}
