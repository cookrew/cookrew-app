import { useEffect, useState } from 'react'
import type { TeamMeta } from '../../shared/model'
import { CrIcon } from './icons'
import { TeamGraphThumb } from './TeamGraphThumb'
import { nameAfterTemplate, templateLabel } from './workspace-wall-actions'

/** What the sheet hands back: a name, where it lives, and what it starts as. */
export interface CreateRequest {
  name: string
  dir: string
  /** A saved team to boot from, or null for an empty canvas. */
  template: string | null
}

export interface WorkspaceCreateSheetProps {
  /** The directory the form opens with — the live workspace's, usually. */
  defaultDir: string
  teams: readonly TeamMeta[]
  /** A native folder picker exists (the desktop). Otherwise the path is typed. */
  canPickDir: boolean
  pickDir: () => Promise<string | null>
  onCreate: (request: CreateRequest) => void
  onCancel: () => void
}

/**
 * THE NEW-WORKSPACE SHEET — the header dropdown's inline form, now the wall's.
 *
 * Making a workspace is picking the empty screen at the end of the row, and
 * this is what that screen opens. Nothing here decides anything: it collects
 * a name, a directory and (optionally) a saved team, and hands them back.
 *
 * A NATIVE PICKER WHERE THERE IS ONE. The desktop has a folder dialog; the
 * phone has not, and the path is typed — the same split DirectoryManager
 * makes, because a phone is telling the Mac about the Mac's own disk.
 */
export function WorkspaceCreateSheet({
  defaultDir,
  teams,
  canPickDir,
  pickDir,
  onCreate,
  onCancel,
}: WorkspaceCreateSheetProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [dir, setDir] = useState(defaultDir)
  const [template, setTemplate] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  // Escape leaves the sheet, not the wall under it. Capture, and stopped, so
  // the wall's own Escape (which closes everything) never sees it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate({ name: trimmed, dir: dir.trim(), template })
  }

  const choose = (team: string | null): void => {
    setTemplate(team)
    setName((current) => nameAfterTemplate(current, team))
  }

  const pick = (): void => {
    if (picking) return
    setPicking(true)
    void pickDir()
      .then((picked) => {
        if (picked) setDir(picked)
      })
      .catch((error: unknown) => console.error('Failed to select working directory:', error))
      .finally(() => setPicking(false))
  }

  const onEnter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') submit()
  }

  return (
    <div className="cr-ws-new" role="dialog" aria-label="New workspace">
      <div className="cr-ws-new-head">NEW WORKSPACE</div>
      <input
        className="cr-ws-input"
        placeholder="workspace name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter}
      />
      {canPickDir ? (
        <button
          type="button"
          className="cr-ws-dir-picker"
          title="Select the primary working directory"
          disabled={picking}
          onClick={pick}
        >
          <CrIcon name="terminal" />
          <span>{dir || 'Select working directory'}</span>
          <CrIcon name="caret-right" />
        </button>
      ) : (
        <input
          className="cr-ws-input"
          placeholder="working directory"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={onEnter}
        />
      )}
      {teams.length > 0 && (
        <div className="cr-ws-template">
          <div className="cr-ws-template-head">FROM TEMPLATE</div>
          <button
            type="button"
            className={`cr-ws-template-item${template === null ? ' active' : ''}`}
            onClick={() => choose(null)}
          >
            <span className="cr-ws-template-name">Empty workspace</span>
          </button>
          {teams.map((team) => (
            <button
              type="button"
              key={team.name}
              className={`cr-ws-template-item${template === team.name ? ' active' : ''}`}
              onClick={() => choose(team.name)}
            >
              {/* The same cable-relation thumbnail the clipboard tray shows —
                  a template's shape at a glance. */}
              {team.preview ? (
                <TeamGraphThumb graph={team.preview} width={120} height={56} />
              ) : (
                <CrIcon name="fork" />
              )}
              <span className="cr-ws-template-name">{team.name}</span>
              <span className="cr-ws-template-meta">{templateLabel(team)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cr-ws-new-foot">
        <button type="button" className="cr-ws-cancel" onClick={onCancel}>
          CANCEL
        </button>
        <button type="button" className="cr-ws-create" disabled={!name.trim()} onClick={submit}>
          {template ? `CREATE FROM ${template.toUpperCase()}` : 'CREATE'}
        </button>
      </div>
    </div>
  )
}
