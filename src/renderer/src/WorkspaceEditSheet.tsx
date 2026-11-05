import { useEffect, useState } from 'react'
import { WORKSPACE_ICONS } from '../../shared/workspace-door'
import { useSheetEscape, wordsOf } from './workspace-sheet'

export interface WorkspaceEditSheetProps {
  name: string
  icon: string
  /** Rejects with the sentence to show: a taken name, a blank one. */
  onSave: (name: string, icon: string) => Promise<void>
  onCancel: () => void
}

/**
 * NAME AND ICON. `/api/workspaces/rename` existed with nothing on screen calling
 * it, so a 300-character name was permanent and every workspace wore 🗂.
 */
export function WorkspaceEditSheet({ name, icon, onSave, onCancel }: WorkspaceEditSheetProps): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const [mark, setMark] = useState(icon)
  const [refused, setRefused] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useSheetEscape(onCancel)
  useEffect(() => setRefused(null), [draft])

  const save = (): void => {
    if (saving) return
    setSaving(true)
    onSave(draft, mark)
      .catch((error: unknown) => setRefused(wordsOf(error)))
      .finally(() => setSaving(false))
  }

  // The workspace's own mark first, when it is not one the row offers: ⑂ on a fork.
  const offered = WORKSPACE_ICONS.some((one) => one === icon) ? WORKSPACE_ICONS : [icon, ...WORKSPACE_ICONS]
  return (
    <div className="cr-ws-new" role="dialog" aria-label="Rename workspace">
      <div className="cr-ws-new-head">RENAME WORKSPACE</div>
      <input
        className="cr-ws-input"
        aria-label="Workspace name"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
        }}
      />
      <div className="cr-ws-icons" role="group" aria-label="Icon">
        {offered.map((one) => (
          <button
            type="button"
            key={one}
            className="cr-ws-icon"
            aria-label={`Icon ${one}`}
            aria-pressed={one === mark}
            onClick={() => setMark(one)}
          >
            {one}
          </button>
        ))}
      </div>
      {refused && <p className="cr-ws-say refused" role="alert">{refused}</p>}
      <div className="cr-ws-new-foot">
        <button type="button" className="cr-ws-cancel" onClick={onCancel}>
          CANCEL
        </button>
        <button type="button" className="cr-ws-create" disabled={saving || !draft.trim()} onClick={save}>
          SAVE
        </button>
      </div>
    </div>
  )
}
