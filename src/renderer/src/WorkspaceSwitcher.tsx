import { useEffect, useRef, useState } from 'react'
import type { WorkspaceList } from '../../shared/model'
import { cookrew } from './api'

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
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void cookrew().listWorkspaces().then(setList)
    return cookrew().onWorkspaceList(setList)
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
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
  }

  const submitCreate = (): void => {
    const trimmed = newName.trim()
    if (!trimmed) return
    void cookrew().createWorkspace(trimmed, newDir.trim())
    setCreating(false)
    setOpen(false)
  }

  return (
    <div className="cr-ws" ref={rootRef}>
      <button className="cr-ws-current" onClick={() => setOpen((v) => !v)} title={dir}>
        <span className="cr-ws-icon">{icon}</span>
        <span className="cr-kicker">{name}</span>
        <span className="cr-ws-caret">{open ? '▾' : '▸'}</span>
      </button>
      <span className="cr-dim cr-ws-dir" title={dir}>
        {dir}
      </span>

      {open && (
        <div className="cr-ws-menu">
          <div className="cr-ws-menu-head">WORKSPACES</div>
          {(list?.workspaces ?? []).map((w) => (
            <button
              key={w.id}
              className={`cr-ws-item${w.id === list?.activeId ? ' active' : ''}`}
              onClick={() => switchTo(w.id)}
            >
              <span className="cr-ws-icon">{w.icon}</span>
              <span className="cr-ws-item-name">{w.name}</span>
              {w.id === list?.activeId && <span className="cr-ws-check">●</span>}
            </button>
          ))}

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
              <button className="cr-ws-create" onClick={submitCreate}>
                CREATE
              </button>
            </div>
          ) : (
            <button className="cr-ws-item add" onClick={startCreate}>
              <span className="cr-ws-icon">＋</span>
              <span className="cr-ws-item-name">New workspace</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
