import { useEffect, useMemo, useRef, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { type TitleMode } from './checkpoint-sync'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import {
  checkpointRowTitle,
  createHoldReveal,
  fanLayout,
  neighborWindow,
  railAnchorTop,
  railPointerFraction,
  scrollFocusState,
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
/** Neighbor rows rendered ABOVE and BELOW the focused one in the fan; generous
 *  so it fills the view — Fresco clips the overflow at the boundary. */
const NEIGHBOR_RADIUS = 12

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
  /** True while a rail scrub drag is active — drives the .dragging affordance. */
  const [scrubbing, setScrubbing] = useState(false)
  /** The FOCUSED checkpoint (scroll/scrub) the list highlights + centres on. */
  const [focused, setFocused] = useState<{ index: number; frac: number } | null>(null)
  /** The row whose SAVE ROLE / FORK actions are revealed (held ~2s). */
  const [acting, setActing] = useState<number | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [forkingIndex, setForkingIndex] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLDivElement>(null)
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

  // SCROLL → FOCUS: track the focused checkpoint (+ its PRECISE identity fraction
  // in markerFrac) from the identity in view — not while scrubbing (the scrub
  // sets it directly). Null at the live tail → the tab hides. The fraction is the
  // ONE position source of truth for both the here-marker and the tab.
  useEffect(() => {
    if (scrubbing) return
    const { focusedIndex } = scrollFocusState(rows, activeIndex ?? null)
    setFocused(focusedIndex !== null ? { index: focusedIndex, frac: markerFrac ?? 1 } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, markerFrac, scrubbing])

  // Dismiss a row's revealed actions on a pointerdown OUTSIDE the rail (the tab
  // is scroll-driven, not click-opened, so it needs no dismissal itself).
  useEffect(() => {
    if (acting === null) return
    const onDown = (e: PointerEvent): void => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setActing(null)
        setSavingIndex(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [acting])

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

  // Drag the line/marker → scrub the transcript. The line/marker stays draggable
  // even while the list is shown (it's the always-present scroll indicator).
  const onRailPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onScrub) return
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
    // DRAG the line/marker → scrub the transcript to the dragged checkpoint; the
    // focus (list highlight + re-centre) follows.
    onScrub(frac)
    const row = scrubPreviewRow(rows, frac)
    setFocused(row ? { index: row.index, frac } : null)
  }
  const onRailPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setScrubbing(false)
    scrub.current.moved = false
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const here = focused?.index ?? null
  const hereFrac =
    markerFrac !== undefined
      ? markerFrac
      : here !== null && rows.length > 0
        ? Math.max(0, rows.findIndex((r) => r.index === here)) / rows.length
        : 1

  const rowLabel = (row: CheckpointRow): string => checkpointRowTitle(row, titleMode)

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

  // One row of the extended tab — the same `.cr-ckpt-row` markup, tap → jump,
  // hold → actions. The focused row is `.active` and sits AT the marker.
  const renderRow = (row: CheckpointRow): React.JSX.Element => {
    const isActive = row.index === here
    const isActing = acting === row.index
    const isLoading = loadingIndex === row.index
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
  }

  const focusedRow = focused ? (rows.find((r) => r.index === focused.index) ?? null) : null
  // TWO ZONES: scrolling the transcript shows the SINGLE tag (focused row only);
  // scrolling/dragging the rail (scrubbing) FANS the full list around it.
  const fanned = scrubbing && focused !== null && focusedRow !== null
  const windowRows = fanned ? neighborWindow(rows, focused!.index, NEIGHBOR_RADIUS) : []
  const fan = fanned ? fanLayout(windowRows, focused!.index) : null
  // Show LIVE at the bottom of the fan only when it reaches the newest checkpoint.
  const showLive =
    fanned && windowRows.length > 0 && windowRows[windowRows.length - 1].index === rows[rows.length - 1].index
  // ONE position source (refinement 1): the marker AND the focused tab/row use
  // the SAME fraction → same Y. At the live tail (no focus) the marker rides its
  // own live fraction.
  const anchorFrac = focused ? focused.frac : hereFrac

  return (
    <div
      ref={railRef}
      // The rail stays NARROW always (never `.open`-widened); the tag/fan is a
      // floating panel, so the mini's hit-area is only the line/marker strip and
      // never steals transcript drags (HIGH-2). `.fanned` = a rail scrub drives
      // the full fan; a plain transcript scroll shows only the single tag.
      className={`cr-ckpt-rail${fanned ? ' fanned' : ''}${scrubbing ? ' dragging' : ''}${
        loadingIndex != null ? ' loading' : ''
      }`}
    >
      {/* always-present line + count + here-marker (rides the PRECISE identity
          fraction) + live dot; the line/marker is the scroll indicator + scrub
          handle. */}
      <div
        ref={miniRef}
        className="cr-ckpt-mini"
        onPointerDown={onRailPointerDown}
        onPointerMove={onRailPointerMove}
        onPointerUp={onRailPointerUp}
        onPointerCancel={onRailPointerUp}
      >
        <div className="cr-ckpt-line" />
        <div className="cr-ckpt-count">
          <span className="n">{rows.length}</span>
          <span className="l">CP</span>
        </div>
        <div className="cr-ckpt-here" style={{ top: railAnchorTop(anchorFrac) }} />
        <div className="cr-ckpt-livedot" />
      </div>

      {/* The tab, anchored at the focused row's PRECISE fraction — the SAME
          source as the here-marker, so the focused row is ALWAYS on the marker's
          horizontal line (refinement 1). Transcript scroll → just the focused row
          (single tag); rail scrub → the FAN: neighbors above + below the anchored
          focus (refinements 3–4). Above/below clip at the view boundary without
          moving the focus off the marker (refinement 2). Fresco lays out the fan
          (focus at anchor, fan-up above, fan-down below, clipped). */}
      {focused && focusedRow && (
        <div
          className="cr-ckpt-scrub-preview"
          style={{ top: railAnchorTop(focused.frac) }}
          role="list"
          aria-label="Checkpoints"
        >
          {/* The FOCUS row is the anchor — its center sits on the marker Y (via
              .cr-ckpt-fan-focus). fan-up/down are ABSOLUTE (out of flow) so they
              never shift the focus off the marker, whatever the neighbor counts
              (HIGH-1). They grow up/down and clip at the view boundary. */}
          <div className="cr-ckpt-fan-focus">
            {fan && <div className="cr-ckpt-fan-up">{fan.above.map(renderRow)}</div>}
            {renderRow(focusedRow)}
            {fan && (
              <div className="cr-ckpt-fan-down">
                {fan.below.map(renderRow)}
                {showLive && (
                  <div
                    className={`cr-ckpt-row live${here === null ? ' active' : ''}`}
                    role="listitem"
                    aria-label="Live"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onTap(() => onLive())}
                  >
                    <span className="cr-ckpt-row-label">
                      <span className="cr-ckpt-row-idx">LIVE</span>
                      <span className="cr-ckpt-row-title">running now</span>
                    </span>
                    <span className="cr-ckpt-dot">
                      <i />
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
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
