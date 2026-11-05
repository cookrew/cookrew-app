import { useState } from 'react'
import { wordsOf } from './workspace-sheet'

/**
 * SAVE A TEAM, FROM THE BOARD. SAVE lived on the canvas's SelectionBar, which
 * nothing renders any more, so FROM TEMPLATE could never appear for a new user
 * (box user test 2, bug 9). A private save only: serving a team is a separate
 * step with its own questions.
 */
export function TeamSaveBar({
  onSave,
  onCancel
}: {
  /** Rejects with the sentence to show. */
  onSave: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [refused, setRefused] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = (): void => {
    if (saving || !name.trim()) return
    setSaving(true)
    onSave(name.trim())
      .catch((error: unknown) => setRefused(wordsOf(error)))
      .finally(() => setSaving(false))
  }

  return (
    <div className="roster-team-save">
      <input
        className="cr-ws-input"
        aria-label="Team name"
        placeholder="Team name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <button type="button" className="cr-btn sm" onClick={onCancel}>
        CANCEL
      </button>
      <button type="button" className="cr-btn sm primary" disabled={saving || !name.trim()} onClick={save}>
        SAVE TEAM
      </button>
      {refused && <p className="cr-ws-say refused" role="alert">{refused}</p>}
    </div>
  )
}
