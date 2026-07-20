import { useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'

/**
 * Dropdown panel in the zoomed-in terminal overlay: lists the agent's
 * completed turns and forks a NEW agent card from any of them. Unlike an
 * in-place rewind, the running agent is never touched — the fork spawns
 * beside it with the transcript up to the chosen turn replayed as context.
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

  useEffect(() => {
    void cookrew()
      .listTurns(terminalId)
      .then(setRecords)
      .catch(() => setRecords([]))
  }, [terminalId])

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
          <CrIcon name="fork" /> FORK FROM A TURN
        </span>
        <button className="cr-btn sm icon" title="Close" aria-label="Close" onClick={onClose}>
          <CrIcon name="close" />
        </button>
      </div>
      <div className="turn-panel-hint">
        Forking spawns a new agent card seeded with the conversation up to that turn. This agent
        keeps running — nothing is rewound.
      </div>
      <div className="turn-panel-list">
        {records === null && <div className="turn-panel-empty">Loading turns…</div>}
        {records !== null && records.length === 0 && (
          <div className="turn-panel-empty">No completed turns yet — send a prompt first.</div>
        )}
        {(records ?? []).map((record) => (
          <div key={record.index} className="turn-panel-row">
            <span className="turn-panel-index">T{record.index}</span>
            <span className="turn-panel-prompt" title={record.prompt}>
              {record.title || firstLine(record.prompt, 80) || '(empty prompt)'}
            </span>
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
    </div>
  )
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
