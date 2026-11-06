import { useEffect, useRef, useState } from 'react'
import type { TeamMeta } from '../../shared/model'
import type { WorkspaceCheck } from '../../shared/workspace-door'
import { CrIcon } from './icons'
import { TeamGraphThumb } from './TeamGraphThumb'
import { nameAfterTemplate, templateLabel } from './workspace-wall-actions'
import { useSheetEscape, wordsOf } from './workspace-sheet'

/** How long typing rests before the folder is asked about. */
const CHECK_REST_MS = 250

/** What the sheet hands back: a name, where it lives, and what it starts as. */
export interface CreateRequest {
  name: string
  dir: string
  /** A saved team to boot from, or null for an empty canvas. */
  template: string | null
}

export interface WorkspaceCreateSheetProps {
  /** The directory the form opens with, until the check suggests one. */
  defaultDir: string
  teams: readonly TeamMeta[]
  /** A native folder picker exists (the desktop). Otherwise the path is typed. */
  canPickDir: boolean
  pickDir: () => Promise<string | null>
  /** Resolves when made. A rejection stays on the sheet, in its own words. */
  onCreate: (request: CreateRequest) => void | Promise<void>
  onCancel: () => void
  /** Asks what a new workspace would be told; the sheet says it before creating. */
  check?: (name: string, dir: string) => Promise<WorkspaceCheck>
  /** Test seams: open with a name typed and a check already answered. */
  initialName?: string
  initialCheck?: WorkspaceCheck
}

/**
 * THE NEW-WORKSPACE SHEET — the header dropdown's inline form, now the wall's.
 *
 * Making a workspace is picking the empty screen at the end of the row, and
 * this is what that screen opens. Nothing here decides anything: it collects
 * a name, a directory and (optionally) a saved team, and hands them back.
 *
 * THE PATH CAN ALWAYS BE TYPED, and the desktop's folder dialog sits beside it.
 * A phone is telling the machine about the machine's own disk, and someone who
 * knows the path should not have to walk to it.
 *
 * IT SAYS SO FIRST. The check (main/workspace-door.ts) answers as the fields
 * change: a folder that cannot work is refused here, and a taken name or a folder
 * another workspace owns is said before CREATE rather than found out after.
 */
export function WorkspaceCreateSheet({
  defaultDir,
  teams,
  canPickDir,
  pickDir,
  onCreate,
  onCancel,
  check,
  initialName = '',
  initialCheck,
}: WorkspaceCreateSheetProps): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [dir, setDir] = useState(defaultDir)
  const [template, setTemplate] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [verdict, setVerdict] = useState<WorkspaceCheck | null>(initialCheck ?? null)
  const [refused, setRefused] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** The person chose a folder: the suggestion may no longer replace it. */
  const chosen = useRef(false)

  useSheetEscape(onCancel)

  // Opens on the suggestion: beside the live folder, never a hidden worktree.
  useEffect(() => {
    let live = true
    void check?.('', '')
      .then((answer) => {
        if (live && !chosen.current) setDir(answer.suggestedDir)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!check) return
    let live = true
    const timer = window.setTimeout(() => {
      void check(name, dir)
        .then((answer) => {
          if (live) setVerdict(answer)
        })
        .catch(() => undefined)
    }, CHECK_REST_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [check, name, dir])

  const typeDir = (next: string): void => {
    chosen.current = true
    setRefused(null)
    setDir(next)
  }

  const reason = verdict?.ok === false ? verdict.reason : undefined
  const blocked = !name.trim() || reason !== undefined || creating

  const submit = (): void => {
    if (blocked) return
    setCreating(true)
    setRefused(null)
    Promise.resolve(onCreate({ name: name.trim(), dir: dir.trim(), template }))
      .catch((error: unknown) => setRefused(wordsOf(error)))
      .finally(() => setCreating(false))
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
        if (picked) typeDir(picked)
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
      <div className="cr-ws-dir-row">
        <input
          className="cr-ws-input"
          aria-label="Folder path"
          placeholder="/path/to/folder"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          value={dir}
          onChange={(e) => typeDir(e.target.value)}
          onKeyDown={onEnter}
        />
        {canPickDir && (
          <button
            type="button"
            className="cr-ws-dir-pick"
            title="Choose a folder"
            disabled={picking}
            onClick={pick}
          >
            CHOOSE…
          </button>
        )}
      </div>
      {(refused ?? reason) && <p className="cr-ws-say refused" role="alert">{refused ?? reason}</p>}
      {/* Said once there is something to say it about: a name makes CREATE
          pressable, so this still comes before anything can be created. */}
      {(name.trim() || chosen.current) && verdict?.notes.map((note) => (
        <p className="cr-ws-say" key={note}>{note}</p>
      ))}
      {!name.trim() && <p className="cr-ws-say quiet">Give it a name to create it.</p>}
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
        <button type="button" className="cr-ws-create" disabled={blocked} onClick={submit}>
          {template ? `CREATE FROM ${template.toUpperCase()}` : 'CREATE'}
        </button>
      </div>
    </div>
  )
}
