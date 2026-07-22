import { useEffect, useRef, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import { railPointerFraction, type CheckpointRow } from './transcript'

const LONG_PRESS_MS = 450
/** Marker inset (matches .cr-ckpt-here top: calc(16px + …)) for scrub mapping. */
const RAIL_INSET = 16
/** Px of pointer travel before a press on the rail becomes a scrub, not a tap. */
const SCRUB_THRESHOLD = 4

/**
 * Checkpoint timeline on the terminal context view (checkpoint-ux item 4, v5)
 * — replaces BOTH the arrow pager and the "fork from a checkpoint" modal.
 *
 * At rest it's a thin line + the checkpoint count + a "you are here" marker +
 * a LIVE dot (`.cr-ckpt-mini`). Hovering the rail (desktop, CSS) or tapping it
 * (phone → `.open`) fans it into the full list (`.cr-ckpt-full`): oldest on
 * top, LIVE at the bottom, dots pinned right, titles fanning left. PRESS a row
 * → onGoto scrolls the context there; hover a row (desktop) / long-press
 * (phone → `.acting`) reveals inline SAVE ROLE + FORK AGENT.
 *
 * Rows span the WHOLE trace (unified-scroll item 3): identities below the record
 * cap render trace-only (no record → select + fork, but no role-save). A row
 * whose trace block is still fetching for a jump shows loading (item 4).
 *
 * Markup follows Fresco's `.cr-ckpt-*` contract; Fresco owns the visuals, this
 * owns the press / long-press / save / fork logic + the active mapping.
 */
export function CheckpointTimeline({
  terminalId,
  rows,
  titleMode,
  activeIndex,
  loadingIndex,
  markerFrac,
  onGoto,
  onLive,
  onScrub
}: {
  terminalId: string
  /** Full-range selectable checkpoints (records ∪ trace listing), ascending. */
  rows: CheckpointRow[]
  titleMode: TitleMode
  /** Checkpoint identity in view; null at the live tail. */
  activeIndex?: number | null
  /** Checkpoint whose trace block is fetching for a jump — shows loading. */
  loadingIndex?: number | null
  /** Exact marker fraction (true position over the combined trace+tail extent). */
  markerFrac?: number
  /** Select a checkpoint by IDENTITY (works for trace-only sub-cap rows too). */
  onGoto: (index: number) => void
  /** Return to the live tail. */
  onLive: () => void
  /**
   * Rail-as-scrollbar scrub (item 4): dragging the mini rail scrubs the ONE
   * combined scroll space to this fraction (0 = oldest trace, 1 = live bottom).
   */
  onScrub?: (fraction: number) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  /** True while a rail scrub drag is active — drives the .dragging affordance. */
  const [scrubbing, setScrubbing] = useState(false)
  /** Checkpoint index whose actions are revealed via phone long-press. */
  const [acting, setActing] = useState<number | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLDivElement>(null)
  // Rail scrub gesture: a press that travels past SCRUB_THRESHOLD becomes a
  // scrollbar drag; a press that stays put is a tap that opens the fan.
  const scrub = useRef<{ startY: number; moved: boolean }>({ startY: 0, moved: false })

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

  if (rows.length === 0) return null

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

  const fork = (index: number): void => {
    if (forkingIndex !== null) return
    setForkingIndex(index)
    void cookrew()
      .forkTerminal(terminalId, index)
      .catch((error) => console.error('Fork failed:', error))
      .finally(() => {
        setForkingIndex(null)
        closeActions()
      })
  }

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  // Rail-as-scrollbar drag (item 4): press-and-drag the mini rail to scrub the
  // combined trace+tail scroll space. Pointer capture keeps the drag alive past
  // the rail edges; a press that never travels stays a tap (opens the fan).
  const onRailPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onScrub || open) return
    scrub.current = { startY: e.clientY, moved: false }
    setScrubbing(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onRailPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onScrub || !miniRef.current) return
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    if (!scrub.current.moved && Math.abs(e.clientY - scrub.current.startY) < SCRUB_THRESHOLD) return
    scrub.current.moved = true
    const rect = miniRef.current.getBoundingClientRect()
    onScrub(railPointerFraction(e.clientY, rect.top, rect.height, RAIL_INSET))
  }
  const onRailPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setScrubbing(false)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }
  // Swallow the click that follows a scrub drag so it doesn't toggle the fan.
  const onRailClick = (): void => {
    if (scrub.current.moved) {
      scrub.current.moved = false
      return
    }
    setOpen((v) => !v)
  }

  // "You are here" marker (item 4): the transcript reports the TRUE position
  // over the combined trace+tail extent (scrollTop / scrollable height), so the
  // marker tracks the one scroll space continuously. Fall back to the selected
  // checkpoint's position among the rows only when no live fraction has been
  // reported yet. 0 = oldest block (rail top), 1 = live bottom.
  const here = activeIndex ?? null
  const hereFrac =
    markerFrac !== undefined
      ? markerFrac
      : here !== null && rows.length > 0
        ? Math.max(0, rows.findIndex((r) => r.index === here)) / rows.length
        : 1

  const rowLabel = (row: CheckpointRow): string =>
    row.record ? checkpointTitle(row.record, titleMode) : row.traceTitle || `T${row.index}`

  return (
    <div
      ref={railRef}
      className={`cr-ckpt-rail${open ? ' open' : ''}${scrubbing ? ' dragging' : ''}${
        loadingIndex != null ? ' loading' : ''
      }`}
      onMouseLeave={() => {
        clearPress()
        closeActions()
      }}
    >
      {/* resting: line + count + you-are-here + live. Drag scrubs the combined
          scroll space (item 4); a plain tap opens the fan (phone). */}
      <div
        ref={miniRef}
        className="cr-ckpt-mini"
        onPointerDown={onRailPointerDown}
        onPointerMove={onRailPointerMove}
        onPointerUp={onRailPointerUp}
        onClick={onRailClick}
      >
        <div className="cr-ckpt-line" />
        <div className="cr-ckpt-count">
          <span className="n">{rows.length}</span>
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
          <span className="cr-ckpt-head-c">LIVE · {rows.length}</span>
        </div>
        <div className="cr-ckpt-list" role="list" aria-label="Checkpoints">
          {rows.map((row) => {
            const isActive = row.index === here
            const isActing = acting === row.index
            const isLoading = loadingIndex === row.index
            const canSaveRole = row.record !== null && hasRoleFromCheckpoint()
            return (
              <div
                key={row.index}
                role="listitem"
                className={`cr-ckpt-row${isActive ? ' active' : ''}${isActing ? ' acting' : ''}${
                  isLoading ? ' loading' : ''
                }`}
                aria-label={`Checkpoint ${row.index}`}
                aria-busy={isLoading || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={() => onPointerDown(row.index)}
                onPointerUp={clearPress}
                onClick={() => {
                  if (isActing) return
                  onGoto(row.index)
                  // Collapse the fan after a touch tap (no mouseleave fires).
                  setOpen(false)
                }}
              >
                <span className="cr-ckpt-row-actions" onMouseDown={stop} onClick={stop}>
                  {savingIndex === row.index && row.record ? (
                    <SaveRoleInline terminalId={terminalId} record={row.record} onDone={closeActions} />
                  ) : (
                    <>
                      {canSaveRole && (
                        <button className="cr-ckpt-action" onClick={() => setSavingIndex(row.index)}>
                          <CrIcon name="agent" /> ROLE
                        </button>
                      )}
                      <button
                        className="cr-ckpt-action"
                        disabled={forkingIndex !== null}
                        onClick={() => fork(row.index)}
                      >
                        <CrIcon name="fork" /> {forkingIndex === row.index ? '…' : 'FORK'}
                      </button>
                    </>
                  )}
                </span>
                <span className="cr-ckpt-row-label">
                  <span className="cr-ckpt-row-idx">T{row.index}</span>
                  <span className="cr-ckpt-row-title">
                    {isLoading ? 'loading…' : rowLabel(row)}
                  </span>
                </span>
                <span className="cr-ckpt-dot">
                  <i />
                </span>
                <span
                  className="cr-ckpt-prog"
                  style={isActive ? ({ ['--p']: 100 } as React.CSSProperties) : undefined}
                />
              </div>
            )
          })}
          <div
            className={`cr-ckpt-row live${here === null ? ' active' : ''}`}
            role="listitem"
            aria-label="Live"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onLive()
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
