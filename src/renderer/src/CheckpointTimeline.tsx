import { useEffect, useMemo, useRef, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { type TitleMode } from './checkpoint-sync'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import {
  checkpointRowTitle,
  createHoldReveal,
  focusedCheckpoint,
  railGesture,
  railPointerFraction,
  scrubPreviewRow,
  type CheckpointRow
} from './transcript'

/** Marker inset (matches .cr-ckpt-here top: calc(16px + …)) for scrub mapping. */
const RAIL_INSET = 16
/** Px of pointer travel before a press on the rail becomes a scrub, not a tap. */
const SCRUB_THRESHOLD = 4
/** Press-and-hold a tab/row this long (~2s) to reveal its SAVE ROLE / FORK
 *  actions. Same gesture for mouse and touch — desktop == mobile. */
const HOLD_REVEAL_MS = 1500

/**
 * Checkpoint timeline on the terminal context view.
 *
 * ONE unified model — desktop == mobile, only the input device differs (mouse
 * click vs single touch):
 *  - REST: a thin rail — line + here-marker (stuck at the current position) +
 *    count + live dot.
 *  - SCROLL the transcript → the here-marker moves along the line to the focused
 *    checkpoint and the context follows; DRAG the line/marker → scrubs the
 *    transcript to that checkpoint. A single-checkpoint TAB shows the focused
 *    title while scrolling/scrubbing.
 *  - CLICK / TAP the rail → the full select list opens and STICKS (persistent —
 *    not a hover-fan); dismiss by a click/tap OUTSIDE. It opens anchored on the
 *    focused checkpoint (scrolled to centre; neighbors above + below).
 *  - In the list: tap/click a row → jump; press-and-HOLD a row/tab (~2s) → its
 *    SAVE ROLE / FORK actions.
 *
 * Rows span the WHOLE trace (unified-scroll item 3): identities below the record
 * cap render trace-only (fork works, role-save needs the record). Fresco owns the
 * `.cr-ckpt-*` visuals and makes them IDENTICAL for both interaction modes.
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
  /** STATE B: the full list is open (only via an explicit mini tap). */
  const [open, setOpen] = useState(false)
  /** True while a rail scrub drag is active — drives the .dragging affordance. */
  const [scrubbing, setScrubbing] = useState(false)
  /** STATE A: the checkpoint the single tab tracks (focused chapter) + its frac. */
  const [focused, setFocused] = useState<{ index: number; frac: number } | null>(null)
  /** The tab/row whose SAVE ROLE / FORK actions are revealed (held ~2s). */
  const [acting, setActing] = useState<number | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Rail scrub gesture: a press that travels past SCRUB_THRESHOLD becomes a
  // scrollbar drag; a press that stays put is a tap that opens the fan.
  const scrub = useRef<{ startY: number; moved: boolean }>({ startY: 0, moved: false })
  // Set when a HOLD fires (reveals actions) so the following click is swallowed.
  const held = useRef(false)
  const hold = useMemo(
    () =>
      createHoldReveal((index) => {
        setActing(index)
        held.current = true
      }, HOLD_REVEAL_MS),
    []
  )
  useEffect(() => () => hold.cancel(), [hold])

  // STATE A: track the focused checkpoint for the tab (not while scrubbing — the
  // scrub sets it directly). Null at the live tail → no tab.
  useEffect(() => {
    if (scrubbing) return
    const row = focusedCheckpoint(rows, activeIndex ?? null)
    setFocused(row ? { index: row.index, frac: markerFrac ?? 1 } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, markerFrac, scrubbing])

  // Collapse State B, or the tab's revealed actions, on a pointerdown OUTSIDE the
  // rail (touch has no mouseleave). The tab lives inside the rail, so tapping it
  // never self-closes.
  useEffect(() => {
    if (!open && acting === null) return
    const onDown = (e: PointerEvent): void => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setOpen(false)
        setActing(null)
        setSavingIndex(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, acting])

  // STATE B opens ANCHORED on the focus: scroll the active row to the middle so
  // its neighbors fill above and below — it IS the same full list, just
  // positioned at the focused checkpoint (not reset to T1).
  // Anchor on `focused` (the drag/scroll focus) so a rail-drag DRIVES the list —
  // it re-centres on the checkpoint under the drag — falling back to activeIndex.
  useEffect(() => {
    if (!open) return
    const anchor = focused?.index ?? activeIndex ?? null
    const node =
      anchor != null
        ? listRef.current?.querySelector<HTMLElement>(`[data-checkpoint="${anchor}"]`)
        : null
    node?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focused?.index, activeIndex])

  if (rows.length === 0) return null

  const closeActions = (): void => {
    setActing(null)
    setSavingIndex(null)
  }
  // HOLD to reveal actions — same gesture for mouse and touch. A short release is
  // a plain tap; `held` swallows the click that fires after a completed hold.
  const startHold = (index: number): void => {
    held.current = false
    hold.start(index)
  }
  const endHold = (): void => hold.cancel()
  const onTap = (tap: () => void): void => {
    if (held.current) {
      held.current = false
      return
    }
    tap()
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

  // Unified rail gesture: press-and-DRAG the line/marker → scrub the transcript;
  // a press that never travels is a plain click/tap → open the stick list. Same
  // for mouse and touch.
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
    const frac = railPointerFraction(e.clientY, rect.top, rect.height, RAIL_INSET)
    // DRAG scrubs the transcript to the dragged checkpoint (marker + context
    // follow); the tab tracks the focus. A drag does NOT open the list.
    onScrub(frac)
    const row = scrubPreviewRow(rows, frac)
    setFocused(row ? { index: row.index, frac } : null)
  }
  const onRailPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setScrubbing(false)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }
  // A plain click/tap (no travel) opens the stick list; a drag is swallowed.
  const onRailClick = (): void => {
    const moved = scrub.current.moved
    scrub.current.moved = false
    if (railGesture(moved) === 'open') setOpen(true)
  }

  const here = activeIndex ?? null
  const hereFrac =
    markerFrac !== undefined
      ? markerFrac
      : here !== null && rows.length > 0
        ? Math.max(0, rows.findIndex((r) => r.index === here)) / rows.length
        : 1

  const rowLabel = (row: CheckpointRow): string => checkpointRowTitle(row, titleMode)
  const focusedRow = focused ? (rows.find((r) => r.index === focused.index) ?? null) : null

  const rowActions = (row: CheckpointRow, index: number): React.JSX.Element => (
    <span className="cr-ckpt-row-actions" onMouseDown={stop} onClick={stop}>
      {savingIndex === index && row.record ? (
        <SaveRoleInline terminalId={terminalId} record={row.record} onDone={closeActions} />
      ) : (
        <>
          {row.record !== null && hasRoleFromCheckpoint() && (
            <button className="cr-ckpt-action" onClick={() => setSavingIndex(index)}>
              <CrIcon name="agent" /> ROLE
            </button>
          )}
          <button
            className="cr-ckpt-action"
            disabled={forkingIndex !== null}
            onClick={() => fork(index)}
          >
            <CrIcon name="fork" /> {forkingIndex === index ? '…' : 'FORK'}
          </button>
        </>
      )}
    </span>
  )

  return (
    <div
      ref={railRef}
      className={`cr-ckpt-rail${open ? ' open' : ''}${scrubbing ? ' dragging' : ''}${
        loadingIndex != null ? ' loading' : ''
      }`}
    >
      {/* resting: line + count + you-are-here + live. Drag scrubs; a plain tap
          opens the full list (State B). */}
      <div
        ref={miniRef}
        className="cr-ckpt-mini"
        onPointerDown={onRailPointerDown}
        onPointerMove={onRailPointerMove}
        onPointerUp={onRailPointerUp}
        onPointerCancel={onRailPointerUp}
        onClick={onRailClick}
      >
        <div className="cr-ckpt-line" />
        <div className="cr-ckpt-count">
          <span className="n">{rows.length}</span>
          <span className="l">CP</span>
        </div>
        <div className="cr-ckpt-here" style={{ top: `calc(16px + ${hereFrac} * (100% - 32px))` }} />
        <div className="cr-ckpt-livedot" />
      </div>

      {/* single-checkpoint tab tracking the focused chapter (both platforms).
          Fresco's contract — a REAL `.cr-ckpt-row` lifted onto a floating panel
          (`.cr-ckpt-scrub-preview`), inheriting the exact row look. Hold →
          `.acting` reveals SAVE ROLE / FORK; click/tap → open the stick list. */}
      {!open && focused && focusedRow && (
        <div
          className="cr-ckpt-scrub-preview"
          style={{ top: `calc(16px + ${focused.frac} * (100% - 32px))` }}
          onPointerDown={() => startHold(focused.index)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          onClick={() => onTap(() => setOpen(true))}
        >
          <div className={`cr-ckpt-row active${acting === focused.index ? ' acting' : ''}`}>
            {rowActions(focusedRow, focused.index)}
            <span className="cr-ckpt-row-label">
              <span className="cr-ckpt-row-idx">T{focused.index}</span>
              <span className="cr-ckpt-row-title">{rowLabel(focusedRow)}</span>
            </span>
            <span className="cr-ckpt-dot">
              <i />
            </span>
          </div>
        </div>
      )}

      {/* STATE B: the full checkpoint list (same as desktop), opened anchored on
          the focused checkpoint. Tap a row → jump; hold → its actions. */}
      <div className="cr-ckpt-full">
        <div className="cr-ckpt-head">
          <span className="cr-ckpt-head-t">CHECKPOINTS</span>
          <span className="cr-ckpt-head-c">LIVE · {rows.length}</span>
        </div>
        <div ref={listRef} className="cr-ckpt-list" role="list" aria-label="Checkpoints">
          {rows.map((row) => {
            const isActive = row.index === here
            const isActing = acting === row.index
            const isLoading = loadingIndex === row.index
            return (
              <div
                key={row.index}
                role="listitem"
                data-checkpoint={row.index}
                className={`cr-ckpt-row${isActive ? ' active' : ''}${isActing ? ' acting' : ''}${
                  isLoading ? ' loading' : ''
                }`}
                aria-label={`Checkpoint ${row.index}`}
                aria-busy={isLoading || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={() => startHold(row.index)}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onPointerCancel={endHold}
                onClick={() => onTap(() => onGoto(row.index))}
              >
                {rowActions(row, row.index)}
                <span className="cr-ckpt-row-label">
                  <span className="cr-ckpt-row-idx">T{row.index}</span>
                  <span className="cr-ckpt-row-title">{isLoading ? 'loading…' : rowLabel(row)}</span>
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
            onClick={() =>
              onTap(() => {
                onLive()
                setOpen(false)
              })
            }
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
