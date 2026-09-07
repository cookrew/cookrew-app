// ONE CHECKPOINT ROW, AS MARKUP (one-stream T3).
//
// Extracted from CheckpointTimeline for two reasons, neither of them tidiness.
//
//   IT IS THE ONLY PART OF THE RAIL A STATIC RENDER CAN REACH. The fan is
//   opened by a scrub and the focused tab by a scroll, so both live behind
//   component state that renderToStaticMarkup never sets — which meant the
//   three things T3 adds to a row (the ↶ of a rolled-back position, the
//   compaction rule, the mark-sourced title) had no test that looked at the
//   markup at all. They do now.
//
//   THE FOCUSED ROW AND A LAID ROW MUST BE THE SAME ELEMENT. F6 is about a
//   focused row sitting exactly on the marker; the surest way to keep that
//   true is that the focused row and every other row are literally the same
//   component with the same class list, differing only in the `style` the
//   parent hands them. Two near-identical JSX blocks is how that drifts.
//
// PRESENTATION ONLY. Every decision — which row is active, what the label
// says, whether the actions are revealed — is the parent's, passed in.

import type { CheckpointRow } from './stream/stream-rows'

export function CheckpointRowView({
  row,
  label,
  active,
  acting,
  loading,
  titleShift,
  titleRef,
  actions,
  style,
  onPressStart,
  onPressEnd,
  onSelect
}: {
  row: CheckpointRow
  /** The row's text under the active title mode — the parent owns the rule. */
  label: string
  active: boolean
  acting: boolean
  loading: boolean
  /** Measured overflow of the focused title, in px (F5b marquee). */
  titleShift: number
  titleRef?: React.Ref<HTMLSpanElement>
  /** The revealed SAVE ROLE / FORK / REWIND strip, or null. */
  actions: React.JSX.Element | null
  style?: React.CSSProperties
  onPressStart: () => void
  onPressEnd: () => void
  onSelect: () => void
}): React.JSX.Element {
  return (
    <div
      role="listitem"
      className={`cr-ckpt-row${active ? ' active' : ''}${acting ? ' acting' : ''}${
        loading ? ' loading' : ''
      }${row.rolledBack ? ' rolled-back' : ''}`}
      style={style}
      aria-label={
        row.rolledBack ? `Checkpoint ${row.index}, rolled back` : `Checkpoint ${row.index}`
      }
      aria-busy={loading || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={onPressStart}
      onPointerUp={onPressEnd}
      onPointerLeave={onPressEnd}
      onPointerCancel={onPressEnd}
      onClick={onSelect}
    >
      {/* A COMPACTION IS A PROPERTY OF THE ROW AFTER IT, and it draws as one:
          a thin rule above this checkpoint saying the context was squeezed
          here. Derived from the row itself — markersOfIndex uses the same
          fact for the bar tick — which is what let the second fetch,
          /trace/markers, go away entirely. */}
      {row.compacted && (
        <span className="cr-ckpt-compacted" role="separator" aria-label="Compacted here">
          compacted
        </span>
      )}
      {actions}
      <span className="cr-ckpt-row-label">
        <span className="cr-ckpt-row-idx">T{row.index}</span>
        {/* A ROLLED-BACK CHECKPOINT IS DIMMED, NOT GONE. The rewind note is
            appended and the position stays addressable, so this row stays
            SELECTABLE: anything anchored to it — a pin, a Sous title, a fork
            — still resolves, which is exactly what rebuilding the reader's
            cache on a /rewind used to destroy. */}
        {row.rolledBack && (
          <span className="cr-ckpt-rolled" title="rolled back by a rewind" aria-hidden="true">
            ↶
          </span>
        )}
        {/* F5b two-element marquee: the OUTER span clips, the INNER moves. One
            element cannot do both — the clip is what makes the overflow
            measurable in the first place. Only the focused row marquees; the
            rest keep their ellipsis. */}
        <span
          className="cr-ckpt-row-title"
          ref={titleRef}
          style={
            active && titleShift > 0
              ? ({ ['--marquee-shift']: `${-titleShift}px` } as React.CSSProperties)
              : undefined
          }
        >
          <span className={`cr-ckpt-title-text${active && titleShift > 0 ? ' marquee' : ''}`}>
            {loading ? 'loading…' : label}
          </span>
        </span>
      </span>
      <span className="cr-ckpt-dot">
        <i />
      </span>
      <span
        className="cr-ckpt-prog"
        style={active ? ({ ['--p']: 100 } as React.CSSProperties) : undefined}
      />
    </div>
  )
}
