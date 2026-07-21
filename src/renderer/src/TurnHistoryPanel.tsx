import { useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'

/**
 * Dropdown panel in the zoomed-in terminal overlay: lists the agent's
 * CHECKPOINTS (completed turns) and forks a NEW agent card from any of them.
 * Unlike an in-place rewind, the running agent is never touched — the fork
 * spawns beside it seeded with the transcript up to the chosen checkpoint.
 * "turn" stays the internal/tracking word; the surface reads "checkpoint".
 */
export function TurnHistoryPanel({
  terminalId,
  onClose
}: {
  terminalId: string
  onClose: () => void
}): React.JSX.Element {
  const [records, setRecords] = useState<TurnRecord[] | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  /** Checkpoint index whose "save as role" name input is open. */
  const [savingIndex, setSavingIndex] = useState<number | null>(null)

  useEffect(() => {
    void cookrew()
      .listTurns(terminalId)
      .then(setRecords)
      .catch(() => setRecords([]))
  }, [terminalId])

  const savingRecord = (records ?? []).find((r) => r.index === savingIndex) ?? null

  const fork = (turnIndex: number): void => {
    if (forkingIndex !== null) return
    setForkingIndex(turnIndex)
    void cookrew()
      .forkTerminal(terminalId, turnIndex)
      .then(() => onClose())
      .catch((error) => {
        console.error('Fork failed:', error)
        setForkingIndex(null)
      })
  }

  return (
    <div className="turn-panel">
      <div className="turn-panel-head">
        <span className="turn-panel-title">
          <CrIcon name="fork" /> FORK FROM A CHECKPOINT
        </span>
        <button className="cr-btn sm icon" title="Close" aria-label="Close" onClick={onClose}>
          <CrIcon name="close" />
        </button>
      </div>
      <div className="turn-panel-hint">
        Forking spawns a new agent card seeded with the conversation up to that checkpoint. This
        agent keeps running — nothing is rewound.
      </div>
      <div className="turn-panel-list">
        {records === null && <div className="turn-panel-empty">Loading checkpoints…</div>}
        {records !== null && records.length === 0 && (
          <div className="turn-panel-empty">No checkpoints yet — send a prompt first.</div>
        )}
        {(records ?? []).map((record) => (
          <div key={record.index} className="turn-panel-row">
            <span className="turn-panel-index">T{record.index}</span>
            <span className="turn-panel-prompt" title={record.prompt}>
              {record.title || firstLine(record.prompt, 80) || '(empty prompt)'}
            </span>
            {hasRoleFromCheckpoint() && (
              <button
                className={`cr-btn sm turn-panel-role${savingIndex === record.index ? ' active' : ''}`}
                title={`Save a reusable role from checkpoint ${record.index}`}
                aria-label="Save role from this checkpoint"
                disabled={forkingIndex !== null}
                onClick={() => setSavingIndex(savingIndex === record.index ? null : record.index)}
              >
                <CrIcon name="agent" />
              </button>
            )}
            <button
              className="cr-btn sm turn-panel-fork"
              disabled={forkingIndex !== null}
              onClick={() => fork(record.index)}
            >
              <CrIcon name="fork" /> {forkingIndex === record.index ? '…' : 'FORK'}
            </button>
          </div>
        ))}
      </div>
      {savingRecord && (
        <SaveRoleRow
          terminalId={terminalId}
          checkpoint={savingRecord}
          onDone={() => setSavingIndex(null)}
        />
      )}
    </div>
  )
}

/**
 * Inline "save role from this checkpoint" input. window.prompt is unusable in
 * Electron, so the name is collected in a field. The role stores the
 * checkpoint's uuid + prompt (+ optional session-copy ref) server-side — this
 * only passes the terminal + checkpoint index; Forge's RoleStore does the rest.
 */
function SaveRoleRow({
  terminalId,
  checkpoint,
  onDone
}: {
  terminalId: string
  checkpoint: TurnRecord
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
    void saveRoleFromCheckpoint({ terminalId, checkpoint, name: trimmed })
      .then(() => onDone())
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <div className="turn-panel-saverole">
      <span className="turn-panel-saverole-label">SAVE ROLE FROM CHECKPOINT {checkpoint.index}</span>
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
      {error && <span className="turn-panel-saverole-err">{error}</span>}
    </div>
  )
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
