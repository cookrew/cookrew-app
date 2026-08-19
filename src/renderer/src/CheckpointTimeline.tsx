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
/** RAIL_INSET: the marker inset (matches .cr-ckpt-here top: calc(16px + …)),
 *  used here for scrub mapping. Imported rather than redeclared so the density
 *  rule and the scrub mapping cannot drift — they describe the same 16px. */
import { fillRows, RAIL_INSET } from './rail-fill'

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

/** F1: movement stops for this long and the tag fades out. */
const IDLE_AFTER_MS = 1700

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
  /** F1: true once movement has stopped for IDLE_AFTER_MS. The tag stays
   *  MOUNTED and fades via CSS — unmounting it pops, which is the thing the
   *  gate distinguishes. Cleared by any scroll, scrub or approach. */
  const [idle, setIdle] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLDivElement>(null)
  /** Measured overflow of the focused title, in px, or 0 when it fits (F5b). */
  const [titleShift, setTitleShift] = useState(0)
  /** Live height of the rail — how many rows the full-range reveal can lay. */
  const [railHeight, setRailHeight] = useState(0)
  /** Bumped by pointer activity; restarts the F1 idle timer. */
  const [wakeCount, setWakeCount] = useState(0)
  const lastWake = useRef(0)
  const titleRef = useRef<HTMLSpanElement>(null)
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

  // F1 — IDLE FADE. Any change of focus or scrub position is "movement", so the
  // timer restarts here and the tag comes back; 1.7s of stillness fades it out.
  // The tag is never unmounted for this: an unmount is a pop, not a fade, and
  // the gate reads opacity.
  useEffect(() => {
    setIdle(false)
    const timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [focused?.index, focused?.frac, scrubbing, wakeCount])

  // F3 — how many rows fit is a function of the bar's real height, so measure
  // it rather than assume: the phone overlay and the desktop sidebar are very
  // different heights, and reading railRef during render is a frame stale.
  // Keyed on rows.length, not []: the component returns null until the first
  // checkpoints arrive, so on the empty first render there is no element to
  // measure and a mount-once effect would leave the height at 0 forever —
  // which quietly collapses the reveal to its two end rows.
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    const measure = (): void => setRailHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [rows.length])

  // F5b — measure the focused title and hand the overflow to CSS. The OUTER
  // span is the clip (overflow:hidden, or scrollWidth-clientWidth reads 0); the
  // inner .cr-ckpt-title-text is the mover. Measured after paint, per focus.
  useEffect(() => {
    const outer = titleRef.current
    if (!outer) {
      setTitleShift(0)
      return
    }
    const overflow = outer.scrollWidth - outer.clientWidth
    setTitleShift(overflow > 0 ? overflow : 0)
  }, [focused?.index, titleMode, rows])

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

  /** F1: pointer activity restarts the idle timer, at most ~4×/second. */
  const wake = (): void => {
    const now = Date.now()
    if (now - lastWake.current < 250) return
    lastWake.current = now
    setWakeCount((n) => n + 1)
  }

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
  /**
   * The marker's own fraction, used ONLY when nothing is focused.
   *
   * There used to be a middle branch here computing a fraction by row lookup,
   * and R19 item 3 corrected its `Math.max(0, -1) → 0` (an unknown identity
   * anchored onto T1). Review round 1 found the branch UNREACHABLE, and that
   * is right: `here` derives from `focused`, and `anchorFrac` reads hereFrac
   * only in the `focused === null` arm — where `here` is necessarily null. So
   * the whole expression always collapsed to this.
   *
   * Deleted rather than kept for safety. An untested unreachable fix for
   * marker anchoring is exactly the class of thing F6 exists to catch, and a
   * dead branch that looks live invites the next reader to trust it. The real
   * "unknown identity" hazard was the boundary ticks clamping an unplaceable
   * marker onto an end of the bar — a live site, fixed in R19 item 2 by
   * omitting it instead.
   */
  const hereFrac = markerFrac ?? 1

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
  const renderRow = (row: CheckpointRow, style?: React.CSSProperties): React.JSX.Element => {
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
        style={style}
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
          {/* F5b two-element marquee: the OUTER span clips, the INNER moves.
              One element cannot do both — the clip is what makes the overflow
              measurable in the first place. Only the focused row marquees;
              the rest keep their ellipsis. */}
          <span
            className="cr-ckpt-row-title"
            ref={isActive ? titleRef : undefined}
            style={
              isActive && titleShift > 0
                ? ({ ['--marquee-shift']: `${-titleShift}px` } as React.CSSProperties)
                : undefined
            }
          >
            <span
              className={`cr-ckpt-title-text${isActive && titleShift > 0 ? ' marquee' : ''}`}
            >
              {isLoading ? 'loading…' : rowLabel(row)}
            </span>
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
  }

  const focusedRow = focused ? (rows.find((r) => r.index === focused.index) ?? null) : null
  // TWO ZONES: scrolling the transcript shows the SINGLE tag (focused row only);
  // scrolling/dragging the rail (scrubbing) FANS the full list around it.
  const fanned = scrubbing && focused !== null && focusedRow !== null
  const windowRows = fanned ? neighborWindow(rows, focused!.index, NEIGHBOR_RADIUS) : []
  const fan = fanned ? fanLayout(windowRows, focused!.index) : null
  /**
   * F3 — the reveal is the FULL range, laid along the bar: T1 at the top, the
   * newest at the bottom, as many rows between as fit without overlapping. The
   * old ±12 fan measured 25 rows out of 122 spanning 169% of the bar, so it
   * overflowed both ends and contained neither.
   *
   * The focused row is NOT in here. It stays where it was, pinned to the
   * marker's own fraction — F6 is the gate that has regressed before, and the
   * safest way to keep it green is to not touch what anchors it.
   */
  const laid = fanned ? fillRows(rows, railHeight, focused!.index) : []
  // Show LIVE at the bottom of the fan only when it reaches the newest checkpoint.
  const showLive =
    fanned && windowRows.length > 0 && windowRows[windowRows.length - 1].index === rows[rows.length - 1].index
  // ONE position source (refinement 1): the marker AND the focused tab/row use
  // the SAME fraction → same Y. At the live tail (no focus) the marker rides its
  // own live fraction.
  const anchorFrac = focused ? focused.frac : hereFrac

  /**
   * Fade only when the rail is genuinely unattended.
   *
   * The bare `idle` flag broke touch outright. HOLD_REVEAL_MS is 1500 and the
   * idle timer is 1700, so a long-press revealed a row's ROLE / FORK / REWIND
   * actions and 200ms later the whole tag went to opacity 0 AND
   * pointer-events: none — and on touch nothing wakes it, because there is no
   * post-lift pointermove. The actions were visible for a fifth of a second and
   * then inert: revealed, unreadable, untappable.
   *
   * A paused scrub had the same problem — hold the thumb still mid-drag and the
   * thing being dragged fades out from under the finger.
   *
   * So: never while a row's actions are open, never mid-scrub.
   */
  const showIdle = idle && acting === null && !scrubbing

  return (
    <div
      ref={railRef}
      // The rail stays NARROW always (never `.open`-widened); the tag/fan is a
      // floating panel, so the mini's hit-area is only the line/marker strip and
      // never steals transcript drags (HIGH-2). `.fanned` = a rail scrub drives
      // the full fan; a plain transcript scroll shows only the single tag.
      className={`cr-ckpt-rail${fanned ? ' fanned' : ''}${scrubbing ? ' dragging' : ''}${
        loadingIndex != null ? ' loading' : ''
      }${showIdle ? ' idle' : ''}`}
      // F1 — approaching or moving over the rail is movement: it wakes the tag
      // and restarts the timer, so resting on the rail keeps the tag alive.
      // Throttled, because a raw pointermove would re-render on every pixel.
      onPointerEnter={wake}
      onPointerMove={wake}
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
          // Drawn-row space (R17/R19), not turn-number space. AFTER row `at` is
          // the boundary at the END of its span, so (at + 1) / n — which still
          // puts a marker after the last checkpoint at 1.0, where the old
          // formula put it. A marker whose checkpoint is not drawn is OMITTED:
          // clamping put it on an end of the bar it has no claim to.
          const at = rows.findIndex((r) => r.index === m.afterIndex)
          if (at < 0) return null
          const frac = (at + 1) / rows.length
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
      {/* F3 — the full-range reveal, laid ALONG the bar. Every row sits at its
          own fraction of T1→newest, so the reveal genuinely represents the whole
          conversation instead of a window around the focus. Pointer-through by
          default (HIGH-2 register in agent-roster.css); the rows opt back in. */}
      {fanned && laid.length > 0 && (
        <div className="cr-ckpt-list" role="list" aria-label="All checkpoints">
          {laid.map(({ row, fraction }) =>
            renderRow(row, { top: railAnchorTop(fraction) })
          )}
        </div>
      )}

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
            {renderRow(focusedRow)}
            {/*
              MED-4, DECLARED not restored: inline dividers stay on the focused
              row alone. They were an in-FLOW element sitting between two rows,
              and the full-range list has no flow to sit in — every row is
              absolutely positioned at its own fraction, so a divider "after"
              one would land on top of the next.
              The information is not lost. Every boundary draws as a
              .cr-ckpt-tick ON the bar, at (at + 1) / n in the same drawn-row
              space (R19), computed over the FULL row set rather than the ~19
              laid — so a boundary is visible whether or not its checkpoint was
              sampled, which the old inline dividers could not manage either.
            */}
            {boundaryRows(focusedRow.index)}
            {fan && (
              <div className="cr-ckpt-fan-down">
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
