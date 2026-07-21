import { useEffect, useRef, useState } from 'react'
import type { TeamMeta, WorkspaceList, WorkspaceMeta } from '../../shared/model'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { DirectoryManager } from './DirectoryManager'
import { removeWorkspace } from './workspace-v2'

function templateLabel(team: TeamMeta): string {
  const when = new Date(team.savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${team.terminalCount} agent${team.terminalCount === 1 ? '' : 's'} · ${when}`
}

interface WorkspaceSwitcherProps {
  fallbackName: string
  fallbackDir: string
}

/**
 * The workspace identity in the header, doubling as a switcher. Click to open
 * a dropdown of all workspaces; pick one to switch (which rebuilds the canvas
 * and its PTYs), or create a new one inline.
 */
export function WorkspaceSwitcher({
  fallbackName,
  fallbackDir
}: WorkspaceSwitcherProps): React.JSX.Element {
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDir, setNewDir] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [managingDirs, setManagingDirs] = useState<WorkspaceMeta | null>(null)
  const [teams, setTeams] = useState<TeamMeta[]>([])
  /** Saved team template the new workspace boots from, or null for empty. */
  const [template, setTemplate] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void cookrew().listWorkspaces().then(setList)
    return cookrew().onWorkspaceList(setList)
  }, [])

  useEffect(() => {
    void cookrew().teamList().then(setTeams).catch(() => undefined)
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setConfirmRemove(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = list?.workspaces.find((w) => w.id === list.activeId)
  const name = active?.name ?? fallbackName
  const icon = active?.icon ?? '🗂'
  const dir = active?.dir ?? fallbackDir

  const switchTo = (id: string): void => {
    setOpen(false)
    if (list && id !== list.activeId) void cookrew().switchWorkspace(id)
  }

  const startCreate = (): void => {
    setCreating(true)
    setNewName('')
    setNewDir(dir)
    setTemplate(null)
  }

  // Picking a template pre-fills the name from the team so the workspace reads
  // as an instance of it; the user can still edit before creating.
  const pickTemplate = (teamName: string | null): void => {
    setTemplate(teamName)
    if (teamName && !newName.trim()) setNewName(teamName)
  }

  const submitCreate = (): void => {
    const trimmed = newName.trim()
    if (!trimmed) return
    // From a template: the backend reuses the fork-from-saved machinery to
    // boot the new workspace pre-populated (nodes, roles, session snapshots).
    void cookrew().createWorkspace(trimmed, newDir.trim(), template ?? undefined)
    setCreating(false)
    setOpen(false)
  }

  // Removing the active workspace switches away first (backend also guards);
  // the last workspace can never be removed.
  const removeWs = (id: string): void => {
    if (!list || list.workspaces.length <= 1) return
    if (id === list.activeId) {
      const other = list.workspaces.find((w) => w.id !== id)
      if (other) void cookrew().switchWorkspace(other.id)
    }
    void removeWorkspace(id)
    setConfirmRemove(null)
  }

  const openDirManager = (meta: WorkspaceMeta): void => {
    setManagingDirs(meta)
    setOpen(false)
  }

  return (
    <div className="cr-ws" ref={rootRef}>
      <button className="cr-ws-current" onClick={() => setOpen((v) => !v)} title={dir}>
        <span className="cr-ws-icon">{icon}</span>
        <span className="cr-kicker cr-ws-name">{name}</span>
        <span className="cr-ws-caret">
          <CrIcon name={open ? 'caret-down' : 'caret-right'} />
        </span>
      </button>

      {open && (
        <div className="cr-ws-menu">
          <div className="cr-ws-menu-head">WORKSPACES</div>
          {(list?.workspaces ?? []).map((w) => {
            const isActive = w.id === list?.activeId
            const canRemove = (list?.workspaces.length ?? 0) > 1
            return (
              <div key={w.id} className={`cr-ws-row${isActive ? ' active' : ''}`}>
                <button className="cr-ws-item" onClick={() => switchTo(w.id)}>
                  <span className="cr-ws-icon">{w.icon}</span>
                  <span className="cr-ws-item-text">
                    <span className="cr-ws-item-name">{w.name}</span>
                    <span className="cr-ws-item-dir" title={w.dir}>
                      {w.dir}
                    </span>
                  </span>
                  {isActive && (
                    <span className="cr-ws-check">
                      <CrIcon name="check" />
                    </span>
                  )}
                </button>
                <button
                  className="cr-ws-mini"
                  title="Manage directories"
                  onClick={() => openDirManager(w)}
                >
                  <CrIcon name="terminal" />
                </button>
                {confirmRemove === w.id ? (
                  <button
                    className="cr-ws-mini danger"
                    title="Confirm remove"
                    onClick={() => removeWs(w.id)}
                  >
                    <CrIcon name="check" />
                  </button>
                ) : (
                  <button
                    className="cr-ws-mini"
                    title={canRemove ? 'Remove workspace' : 'Cannot remove the last workspace'}
                    disabled={!canRemove}
                    onClick={() => setConfirmRemove(w.id)}
                  >
                    <CrIcon name="close" />
                  </button>
                )}
              </div>
            )
          })}

          <div className="cr-ws-sep" />
          {creating ? (
            <div className="cr-ws-new">
              <input
                className="cr-ws-input"
                placeholder="workspace name"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
              />
              <input
                className="cr-ws-input"
                placeholder="working directory"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
              />
              {teams.length > 0 && (
                <div className="cr-ws-template">
                  <div className="cr-ws-template-head">FROM TEMPLATE</div>
                  <button
                    className={`cr-ws-template-item${template === null ? ' active' : ''}`}
                    onClick={() => pickTemplate(null)}
                  >
                    <span className="cr-ws-template-name">Empty workspace</span>
                  </button>
                  {teams.map((team) => (
                    <button
                      key={team.name}
                      className={`cr-ws-template-item${template === team.name ? ' active' : ''}`}
                      onClick={() => pickTemplate(team.name)}
                    >
                      <CrIcon name="fork" />
                      <span className="cr-ws-template-name">{team.name}</span>
                      <span className="cr-ws-template-meta">{templateLabel(team)}</span>
                    </button>
                  ))}
                </div>
              )}
              <button className="cr-ws-create" onClick={submitCreate}>
                {template ? `CREATE FROM ${template.toUpperCase()}` : 'CREATE'}
              </button>
            </div>
          ) : (
            <button className="cr-ws-item add" onClick={startCreate}>
              <span className="cr-ws-icon">
                <CrIcon name="plus" />
              </span>
              <span className="cr-ws-item-name">New workspace</span>
            </button>
          )}
        </div>
      )}

      {managingDirs && (
        <DirectoryManager meta={managingDirs} onClose={() => setManagingDirs(null)} />
      )}
    </div>
  )
}
