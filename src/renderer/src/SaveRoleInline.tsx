// THE INLINE "SAVE AS ROLE" FORM — its own file.
//
// Extracted from CheckpointTimeline when D2 (canvas QA 2026-09-07) grew the
// rail's focus policy: the timeline was already past the 800-line ceiling and
// this form shares nothing with the rail but a callback. Behaviour unchanged,
// character for character.

import { useState } from 'react'
import { saveRoleFromCheckpoint } from './role-checkpoint'

export function SaveRoleInline({
  terminalId,
  checkpoint,
  expectedUuid,
  onDone
}: {
  terminalId: string
  checkpoint: number
  /** The row's trace identity — guards the numeric-checkpoint ledger lookup
   *  against the post-compact index divergence (see role-checkpoint.ts). */
  expectedUuid?: string
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    void saveRoleFromCheckpoint({ terminalId, checkpoint, expectedUuid, name: trimmed })
      .then(() => onDone())
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(false)
      })
  }
  return (
    <div className="cr-ckpt-saverole">
      <input
        className="tf-input"
        placeholder="role name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onDone()
        }}
      />
      <button className="cr-btn sm" disabled={busy || !name.trim()} onClick={submit}>
        {busy ? '…' : 'SAVE'}
      </button>
      {error && <span className="cr-ckpt-rewind-error">{error}</span>}
    </div>
  )
}
