import { useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { RoleAvatar } from './nodes/RoleAvatar'

/** Per-terminal fork strategy chosen in the team-fork picker. */
export interface TerminalChoice {
  mode: 'latest' | 'first' | 'assembled' | 'role'
  /** 1-based TurnRecord.index values, ascending (assembled mode). */
  turnIndexes: number[]
}

export const DEFAULT_CHOICE: TerminalChoice = { mode: 'latest', turnIndexes: [] }

const MODE_LABEL: Record<TerminalChoice['mode'], string> = {
  latest: 'LATEST CHECKPOINT',
  first: 'FIRST CHECKPOINT',
  assembled: 'ASSEMBLE',
  role: 'FROM ROLE'
}

function conclusion(record: TurnRecord): string {
  const text = record.title ?? record.prompt ?? ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat || '(empty prompt)'
}

/**
 * Expanded body of a terminal row in the team-fork picker: mode chips plus
 * the turn list with brief conclusions (Sous title, else prompt snippet).
 * latest/first highlight the turn that will be used; assembled turns the
 * list into a multi-select whose order is the source (ascending) order.
 */
export function TeamTurnChooser({
  terminalId,
  roleName,
  choice,
  onChange
}: {
  terminalId: string
  /** Saved role attached to this agent, or null — gates the FROM ROLE chip. */
  roleName: string | null
  choice: TerminalChoice
  onChange: (next: TerminalChoice) => void
}): React.JSX.Element {
  const [records, setRecords] = useState<TurnRecord[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void cookrew()
      .listTurns(terminalId)
      .then((list) => {
        if (!cancelled) setRecords(list)
      })
      .catch(() => {
        if (!cancelled) setRecords([])
      })
    return () => {
      cancelled = true
    }
  }, [terminalId])

  const modes: TerminalChoice['mode'][] = ['latest', 'first', 'assembled']
  if (roleName) modes.push('role')

  const setMode = (mode: TerminalChoice['mode']): void => {
    onChange({ mode, turnIndexes: mode === 'assembled' ? choice.turnIndexes : [] })
  }

  const toggleTurn = (index: number): void => {
    const has = choice.turnIndexes.includes(index)
    const next = has
      ? choice.turnIndexes.filter((i) => i !== index)
      : [...choice.turnIndexes, index].sort((a, b) => a - b)
    onChange({ mode: 'assembled', turnIndexes: next })
  }

  const effectiveIndex =
    records === null || records.length === 0
      ? null
      : choice.mode === 'latest'
        ? records[records.length - 1].index
        : choice.mode === 'first'
          ? records[0].index
          : null

  return (
    <div className="tf-chooser">
      <div className="tf-modes">
        {modes.map((mode) => (
          <button
            key={mode}
            className={`cr-chip clickable tf-mode-chip${mode === 'role' ? ' role' : ''}${choice.mode === mode ? ' amber' : ''}`}
            title={mode === 'role' ? `Fresh agent booted from role "${roleName}"` : undefined}
            onClick={() => setMode(mode)}
          >
            {mode === 'role' && roleName ? <RoleAvatar name={roleName} /> : null}
            {MODE_LABEL[mode]}
            {mode === 'role' && roleName ? ` · ${roleName.toUpperCase()}` : ''}
          </button>
        ))}
      </div>

      {choice.mode === 'role' ? (
        <div className="tf-role-note">
          Boots fresh with the role prompt — no checkpoint history carries over.
        </div>
      ) : records === null ? (
        <div className="tf-role-note">Loading checkpoints…</div>
      ) : records.length === 0 ? (
        <div className="tf-role-note">No checkpoints yet — the fork boots fresh.</div>
      ) : (
        <div className="tf-turns">
          {records.map((record) => {
            const selected =
              choice.mode === 'assembled'
                ? choice.turnIndexes.includes(record.index)
                : record.index === effectiveIndex
            return (
              <button
                key={record.index}
                className={`tf-turn${selected ? ' selected' : ''}${choice.mode === 'assembled' ? '' : ' readonly'}`}
                disabled={choice.mode !== 'assembled'}
                onClick={() => toggleTurn(record.index)}
              >
                <span className="tf-turn-mark">
                  {selected ? <CrIcon name="check" /> : <span className="tf-turn-box" />}
                </span>
                <span className="tf-turn-index">T{record.index}</span>
                <span className="tf-turn-text">{conclusion(record)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
