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
  type CheckpointRow,
  type TraceMarkerRow
} from './transcript'

/** Marker inset (matches .cr-ckpt-here top: calc(16px + …)) for scrub mapping. */
const RAIL_INSET = 16
/** Px of pointer travel before a press on the rail becomes a scrub, not a tap. */
const SCRUB_THRESHOLD = 4
/** Press-and-hold a tab/row this long (~2s) to reveal its SAVE ROLE / FORK
 *  actions. Same gesture for mouse and touch — desktop == mobile. */
const HOLD_REVEAL_MS = 1500

/** M4: a two-tap REWIND arm expires after this long (walk-away safety — the
 *  chip reverts to REWIND instead of staying one tap from a rewind). */
const REWIND_ARM_MS = 8000
/** M3: an inline rewind refusal lingers this long, then dismisses itself. */
const REWIND_ERROR_MS = 6000
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
  markers,
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
  /** Boundary markers (◆ compact / ⇥ clear) interleaved between rows. */
  markers?: TraceMarkerRow[]
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
  /** REWIND two-tap arm: first tap arms "SURE?" (in-place rewind is the one
   * destructive-ish rail action), second tap executes. */
  const [rewindArmed, setRewindArmed] = useState<number | null>(null)
  const [rewindingIndex, setRewindingIndex] = useState<number | null>(null)
  /** M3: a refused rewind, surfaced INLINE on the row (never window.alert — a
   * native modal freezes the whole Electron UI). Scoped by row index. */
  const [rewindError, setRewindError] = useState<{ index: number; reason: string } | null>(null)
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

  // M4: rewindArmed is a checkpoint ORDINAL — when the rows shift (new
  // checkpoints arrive), the same ordinal now names a DIFFERENT checkpoint,
  // so the two-tap "SURE?" would fire on a row the user never armed. Disarm
  // (and drop any surfaced refusal) on any rows-identity change.
  const rowsSignature = rows.map((r) => `${r.index}:${r.record?.uuid ?? ''}`).join('|')
  useEffect(() => {
    setRewindArmed(null)
    setRewindError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSignature])

  // M4: an arm also expires — walk away mid-confirmation and the chip reverts
  // to REWIND rather than staying one tap from a destructive action.
  useEffect(() => {
    if (rewindArmed === null) return
    const timeout = setTimeout(() => setRewindArmed(null), REWIND_ARM_MS)
    return () => clearTimeout(timeout)
  }, [rewindArmed])

  // M3: a surfaced refusal auto-dismisses (closing the row's action strip).
  useEffect(() => {
    if (rewindError === null) return
    const timeout = setTimeout(() => {
      setRewindError(null)
      setActing(null)
    }, REWIND_ERROR_MS)
    return () => clearTimeout(timeout)
  }, [rewindError])

  if (rows.length === 0) return null

  const closeActions = (): void => {
    setActing(null)
    setSavingIndex(null)
    setRewindArmed(null) // M4: never keep an arm across dismissed actions
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

  // In-place rewind: the executor kills, rebinds to a truncated copy, and
  // respawns the SAME node (undo lives server-side on the node's restoreStack).
  const rewind = (index: number): void => {
    if (rewindingIndex !== null) return
    if (rewindArmed !== index) {
      setRewindError(null)
      setRewindArmed(index)
      return
    }
    const restore = cookrew().restoreCheckpoint
    if (typeof restore !== 'function') return
    setRewindingIndex(index)
    void restore(terminalId, index)
      .then((result) => {
        if (result.ok) {
          closeActions()
        } else {
          // M3: no window.alert — the refusal rides the row's action strip
          // inline (actions stay open) and auto-dismisses.
          setRewindError({ index, reason: result.reason ?? 'Rewind refused.' })
        }
      })
      .catch((error: unknown) => {
        setRewindError({ index, reason: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        setRewindArmed(null)
        setRewindingIndex(null)
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
      {rewindError?.index === index && (
        <span className="cr-ckpt-rewind-error" role="alert">
          {rewindError.reason}
        </span>
      )}
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
          {typeof cookrew().restoreCheckpoint === 'function' && (
            <button
              className={`cr-ckpt-action rewind${rewindArmed === index ? ' armed' : ''}`}
              disabled={rewindingIndex !== null}
              onClick={() => rewind(index)}
            >
              {rewindingIndex === index ? '…' : rewindArmed === index ? 'SURE?' : '⟲ REWIND'}
            </button>
          )}
        </>
      )}
    </span>
  )

  // Boundary dividers (◆ compact / ⇥ clear) sit BETWEEN checkpoint rows, keyed
  // to the row they follow — a compact reads as "context was squeezed here",
  // a clear as "the session restarted here (earlier endpoints still reachable
  // via lineage)". Rendered inline in the fan so phone + desktop share them.
  const boundaryRows = (afterIndex: number): React.JSX.Element[] =>
    (markers ?? [])
      .filter((m) => m.afterIndex === afterIndex)
      .map((m, i) => (
        <div
          key={`boundary-${m.kind}-${afterIndex}-${i}`}
          className={`cr-ckpt-boundary ${m.kind}`}
          role="separator"
          aria-label={
            m.kind === 'compact'
              ? 'Compacted here'
              : m.kind === 'rewind'
                ? `Rewound to T${m.toIndex}`
                : 'Session cleared here'
          }
        >
          {m.kind === 'compact'
            ? `◆ compact${m.preTokens !== undefined && m.postTokens !== undefined ? ` · ${fmtTokens(m.preTokens)} → ${fmtTokens(m.postTokens)}` : ''}`
            : m.kind === 'rewind'
              ? `⟲ rewind · T${m.toIndex}`
              : `⇥ clear · earlier endpoints via lineage`}
        </div>
      ))

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
        {/* Boundary ticks ON the rail line — compact/clear/rewind positions visible
            at first sight. Fraction uses the rail's IDENTITY extent: the last row's
            index (or 1 when empty), not the array length, so a marker after the last
            checkpoint doesn't clamp to the bottom. */}
        {(markers ?? []).map((m, i) => {
          const maxIndex = rows.length > 0 ? rows[rows.length - 1].index : 1
          const frac = Math.min(1, Math.max(0, m.afterIndex / maxIndex))
          return (
            <div
              key={`tick-${m.kind}-${m.afterIndex}-${i}`}
              className={`cr-ckpt-tick ${m.kind}`}
              style={{ top: railAnchorTop(frac) }}
              title={
                m.kind === 'compact'
                  ? `compact here${m.preTokens !== undefined && m.postTokens !== undefined ? ` · ${fmtTokens(m.preTokens)} → ${fmtTokens(m.postTokens)}` : ''}`
                  : m.kind === 'rewind'
                    ? `rewound to T${m.toIndex} here`
                    : 'session cleared here — earlier endpoints via lineage'
              }
            />
          )
        })}
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
            {fan && (
              <div className="cr-ckpt-fan-up">
                {fan.above.map((r) => (
                  <span key={r.index} style={{ display: 'contents' }}>
                    {renderRow(r)}
                    {boundaryRows(r.index)}
                  </span>
                ))}
              </div>
            )}
            {renderRow(focusedRow)}
            {boundaryRows(focusedRow.index)}
            {fan && (
              <div className="cr-ckpt-fan-down">
                {fan.below.map((r) => (
                  <span key={r.index} style={{ display: 'contents' }}>
                    {renderRow(r)}
                    {boundaryRows(r.index)}
                  </span>
                ))}
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

/** 999600 → "999.6k", 11200000 → "11.2M" — compact marker compression readout. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
