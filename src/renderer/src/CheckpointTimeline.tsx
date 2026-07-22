import { useEffect, useRef, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import type { TurnPaging } from './nodes/TurnPager'

const LONG_PRESS_MS = 450

/**
 * Vertical checkpoint timeline on the terminal context view (checkpoint-ux
 * item 4) — replaces the arrow pager. Each checkpoint is a diamond node; PRESS
 * jumps the context there (paging.goto → the overlay's ptyJump scrolls the
 * terminal); a round pulsing head marks LIVE. HOVER (desktop, CSS) / LONG-PRESS
 * (phone → `.acting`) reveals inline SAVE ROLE + FORK AGENT — the primary
 * role-save + fork entry point. Markup follows Fresco's `.cr-ckpt-*` contract;
 * Fresco owns the visuals, this owns the press/long-press/save/fork logic.
 */
export function CheckpointTimeline({
  terminalId,
  paging,
  titleMode
}: {
  terminalId: string
  paging: TurnPaging
  titleMode: TitleMode
}): React.JSX.Element | null {
  const records = paging.records ?? []
  /** Checkpoint index whose actions are revealed via phone long-press. */
  const [acting, setActing] = useState<number | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Never leave a long-press timer running after the timeline unmounts.
  useEffect(() => {
    return () => {
      if (pressTimer.current) clearTimeout(pressTimer.current)
    }
  }, [])

  if (records.length === 0) return null

  const clearPress = (): void => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }
  const onPointerDown = (index: number): void => {
    clearPress()
    pressTimer.current = setTimeout(() => setActing(index), LONG_PRESS_MS)
  }
  const closeActions = (): void => {
    setActing(null)
    setSavingIndex(null)
  }

  const fork = (record: TurnRecord): void => {
    if (forkingIndex !== null) return
    setForkingIndex(record.index)
    void cookrew()
      .forkTerminal(terminalId, record.index)
      .catch((error) => console.error('Fork failed:', error))
      .finally(() => {
        setForkingIndex(null)
        closeActions()
      })
  }

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  return (
    <div className="cr-ckpt-timeline" role="list" aria-label="Checkpoints">
      <button
        className={`cr-ckpt-node live${paging.viewing === null ? ' active' : ''}`}
        title="Live checkpoint"
        aria-label="Live"
        onMouseDown={(e) => e.preventDefault()}
        onClick={paging.live}
      >
        <span className="cr-ckpt-node-mark" />
      </button>
      {records.map((record) => {
        const isActive = paging.viewing?.index === record.index
        const isActing = acting === record.index
        return (
          // A div (not nested <button>) so the ROLE/FORK buttons inside stay
          // valid interactive elements; Fresco's CSS targets the class, not
          // the tag.
          <div
            key={record.index}
            role="listitem"
            className={`cr-ckpt-node${isActive ? ' active' : ''}${isActing ? ' acting' : ''}`}
            title={`Checkpoint ${record.index} · ${checkpointTitle(record, titleMode)}`}
            aria-label={`Checkpoint ${record.index}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseLeave={() => {
              clearPress()
              closeActions()
            }}
            onPointerDown={() => onPointerDown(record.index)}
            onPointerUp={clearPress}
            onClick={() => {
              if (isActing) return
              paging.goto(record.index)
            }}
          >
            <span className="cr-ckpt-node-mark" />
            <span className="cr-ckpt-node-actions" onMouseDown={stop} onClick={stop}>
              {savingIndex === record.index ? (
                <SaveRoleInline terminalId={terminalId} record={record} onDone={closeActions} />
              ) : (
                <>
                  {hasRoleFromCheckpoint() && (
                    <button className="cr-ckpt-action" onClick={() => setSavingIndex(record.index)}>
                      <CrIcon name="agent" /> ROLE
                    </button>
                  )}
                  <button
                    className="cr-ckpt-action"
                    disabled={forkingIndex !== null}
                    onClick={() => fork(record)}
                  >
                    <CrIcon name="fork" /> {forkingIndex === record.index ? '…' : 'FORK'}
                  </button>
                </>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SaveRoleInline({
  terminalId,
  record,
  onDone
}: {
  terminalId: string
  record: TurnRecord
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    void saveRoleFromCheckpoint({ terminalId, checkpoint: record, name: trimmed })
      .then(() => onDone())
      .catch(() => setBusy(false))
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
    </div>
  )
}
