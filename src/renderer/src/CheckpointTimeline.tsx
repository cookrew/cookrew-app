import { useEffect, useRef, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import type { TurnPaging } from './nodes/TurnPager'

const LONG_PRESS_MS = 450

/**
 * Checkpoint timeline on the terminal context view (checkpoint-ux item 4, v5)
 * — replaces BOTH the arrow pager and the "fork from a checkpoint" modal.
 *
 * At rest it's a thin line + the checkpoint count + a "you are here" marker +
 * a LIVE dot (`.cr-ckpt-mini`). Hovering the rail (desktop, CSS) or tapping it
 * (phone → `.open`) fans it into the full list (`.cr-ckpt-full`): oldest on
 * top, LIVE at the bottom, dots pinned right, titles fanning left. PRESS a row
 * → paging.goto scrolls the context there; hover a row (desktop) / long-press
 * (phone → `.acting`) reveals inline SAVE ROLE + FORK AGENT — the primary
 * role-save + fork entry point.
 *
 * Markup follows Fresco's `.cr-ckpt-*` contract; Fresco owns the visuals, this
 * owns the press / long-press / save / fork logic + the active mapping.
 * The `here` marker rides the live scroll fraction (activity.scrollRow) and
 * the active row's progress bar (--p) fills through that checkpoint's span.
 */
export function CheckpointTimeline({
  terminalId,
  paging,
  titleMode,
  activeBlock,
  markerFrac
}: {
  terminalId: string
  paging: TurnPaging
  titleMode: TitleMode
  /** Checkpoint index of the transcript block in view; null at the live tail. */
  activeBlock?: number | null
  /** Exact marker fraction (block pos / trace total) from the transcript. */
  markerFrac?: number
}): React.JSX.Element | null {
  const records = paging.records ?? []
  const [open, setOpen] = useState(false)
  /** Checkpoint index whose actions are revealed via phone long-press. */
  const [acting, setActing] = useState<number | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (pressTimer.current) clearTimeout(pressTimer.current)
    }
  }, [])

  // Touch collapse: onMouseLeave never fires on a touch device, so a fanned
  // list opened by tap has no other way to close (the mini goes pointer-events:
  // none while open). A pointerdown outside the rail collapses it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setOpen(false)
        setActing(null)
        setSavingIndex(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

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

  // "You are here" marker (trace-sourced): the transcript reports the exact
  // fraction (block global position / trace total). Fall back to the selected
  // checkpoint's position among loaded records only when no live fraction has
  // been reported yet. 0 = oldest block (rail top), 1 = live bottom.
  const here = activeBlock ?? paging.viewing?.index ?? null
  const hereFrac =
    markerFrac !== undefined
      ? markerFrac
      : here !== null && records.length > 0
        ? Math.max(0, records.findIndex((r) => r.index === here)) / records.length
        : 1

  // The active row fills its progress bar (you are at this block). Intra-block
  // scroll fraction is a future refinement (TranscriptView would report it).
  const progressFor = (record: TurnRecord): number => (record.index === here ? 100 : 0)

  return (
    <div
      ref={railRef}
      className={`cr-ckpt-rail${open ? ' open' : ''}`}
      onMouseLeave={() => {
        clearPress()
        closeActions()
      }}
    >
      {/* resting: line + count + you-are-here + live. Tapping opens on phone. */}
      <div className="cr-ckpt-mini" onClick={() => setOpen((v) => !v)}>
        <div className="cr-ckpt-line" />
        <div className="cr-ckpt-count">
          <span className="n">{records.length}</span>
          <span className="l">CP</span>
        </div>
        <div
          className="cr-ckpt-here"
          style={{ top: `calc(16px + ${hereFrac} * (100% - 32px))` }}
        />
        <div className="cr-ckpt-livedot" />
      </div>

      {/* fanned: the full checkpoint list, oldest → newest, LIVE last */}
      <div className="cr-ckpt-full">
        <div className="cr-ckpt-head">
          <span className="cr-ckpt-head-t">CHECKPOINTS</span>
          <span className="cr-ckpt-head-c">LIVE · {records.length}</span>
        </div>
        <div className="cr-ckpt-list" role="list" aria-label="Checkpoints">
          {records.map((record) => {
            const isActive = record.index === here
            const isActing = acting === record.index
            return (
              <div
                key={record.index}
                role="listitem"
                className={`cr-ckpt-row${isActive ? ' active' : ''}${isActing ? ' acting' : ''}`}
                aria-label={`Checkpoint ${record.index}`}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={() => onPointerDown(record.index)}
                onPointerUp={clearPress}
                onClick={() => {
                  if (isActing) return
                  paging.goto(record.index)
                  // Collapse the fan after a touch tap (no mouseleave fires).
                  setOpen(false)
                }}
              >
                <span className="cr-ckpt-row-actions" onMouseDown={stop} onClick={stop}>
                  {savingIndex === record.index ? (
                    <SaveRoleInline terminalId={terminalId} record={record} onDone={closeActions} />
                  ) : (
                    <>
                      {hasRoleFromCheckpoint() && (
                        <button
                          className="cr-ckpt-action"
                          onClick={() => setSavingIndex(record.index)}
                        >
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
                <span className="cr-ckpt-row-label">
                  <span className="cr-ckpt-row-idx">T{record.index}</span>
                  <span className="cr-ckpt-row-title">{checkpointTitle(record, titleMode)}</span>
                </span>
                <span className="cr-ckpt-dot">
                  <i />
                </span>
                <span
                  className="cr-ckpt-prog"
                  style={isActive ? ({ ['--p']: progressFor(record) } as React.CSSProperties) : undefined}
                />
              </div>
            )
          })}
          <div
            className={`cr-ckpt-row live${paging.viewing === null ? ' active' : ''}`}
            role="listitem"
            aria-label="Live"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              paging.live()
              setOpen(false)
            }}
          >
            <span className="cr-ckpt-row-label">
              <span className="cr-ckpt-row-idx">LIVE</span>
              <span className="cr-ckpt-row-title">running now</span>
            </span>
            <span className="cr-ckpt-dot">
              <i />
            </span>
          </div>
        </div>
      </div>
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
