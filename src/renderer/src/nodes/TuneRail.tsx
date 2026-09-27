// THE LEFT RAIL of a zoomed terminal: the agent's two dials.
//
// It is the mirror of the checkpoint rail on the right, and the pairing is the
// point. The right rail is WHEN — the turns this conversation has had. The
// left rail is HOW — the model answering and the effort it answers at. Both
// are edge strips on the same surface, both stay legible while you read the
// transcript between them, and neither one is a menu you have to go looking
// for in a header.
//
// This file DECIDES NOTHING. Every state on screen — which row is current,
// which was asked for, whether an ask is still pending or was refused, whether
// the dials may be turned at all — is computed by tuneRailView in
// shared/agent-tuning and asserted in tests without a DOM.

import {
  chipText,
  type TuneDial,
  type TuneKnob,
  type TuneRailView
} from '../../../shared/agent-tuning'

export interface TuneRailProps {
  view: TuneRailView
  open: TuneKnob | null
  onOpen: (knob: TuneKnob | null) => void
  onTurn: (knob: TuneKnob, value: string) => void
  error: string | null
  /** Clicking the rail must not pull focus out of the live pane. */
  onMouseDown?: (e: React.MouseEvent) => void
}

export function TuneRail({
  view,
  open,
  onOpen,
  onTurn,
  error,
  onMouseDown
}: TuneRailProps): React.JSX.Element {
  const locked = view.locked
  return (
    <div className="cr-tune-rail" role="group" aria-label="Model and effort">
      {view.dials.map((dial) => (
        <Dial
          key={dial.knob}
          dial={dial}
          open={open === dial.knob}
          locked={locked}
          caveat={view.caveat}
          onOpen={onOpen}
          onTurn={onTurn}
          onMouseDown={onMouseDown}
        />
      ))}
      {/* The reason sits UNDER the dials whether or not there are any: a
          harness without dials has only this line, and it is the whole point
          of drawing a rail for it. */}
      {locked !== null && <div className="cr-tune-locked">{locked}</div>}
      {error !== null && (
        <div className="cr-tune-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

function Dial({
  dial,
  open,
  locked,
  caveat,
  onOpen,
  onTurn,
  onMouseDown
}: {
  dial: TuneDial
  open: boolean
  locked: string | null
  caveat: string | null
  onOpen: (knob: TuneKnob | null) => void
  onTurn: (knob: TuneKnob, value: string) => void
  onMouseDown?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  // The accessible name carries the FULL reading, not the clipped chip text:
  // a 46px strip is where an id gets shortened, and a screen reader is not
  // reading a 46px strip.
  const reading = dial.reading ?? 'not recorded yet'
  return (
    <div className={`cr-tune-dial${open ? ' open' : ''}`} data-knob={dial.knob}>
      <button
        type="button"
        className={`cr-tune-chip${dial.outcome !== null ? ` ${dial.outcome}` : ''}`}
        aria-expanded={open}
        aria-label={`${dial.title}: ${reading}`}
        title={`${dial.title}: ${reading}`}
        onMouseDown={onMouseDown}
        onClick={() => onOpen(open ? null : dial.knob)}
      >
        <span className="cr-tune-k">{dial.label}</span>
        <span className="cr-tune-v">{chipText(dial)}</span>
        {dial.outcome !== null && (
          <span className="cr-tune-flag">
            {dial.outcome === 'pending' ? `→ ${dial.asked}` : `! ${dial.asked}`}
          </span>
        )}
      </button>
      {open && (
        <div className="cr-tune-list" role="listbox" aria-label={dial.title}>
          {dial.rows.map((row) => (
            <button
              key={row.value}
              type="button"
              role="option"
              aria-selected={row.state === 'current'}
              className={`cr-tune-row ${row.state}`}
              // Rows stay VISIBLE while locked and merely refuse the click.
              // Hiding them would take the readout away at exactly the moment
              // someone zoomed in to check it.
              disabled={locked !== null}
              onMouseDown={onMouseDown}
              onClick={() => onTurn(dial.knob, row.value)}
            >
              {row.value}
            </button>
          ))}
          {dial.note !== null && <div className="cr-tune-note">{dial.note}</div>}
          {/* The caveat sits at the moment of PICKING, not in the rail at
              rest: it is a fact about the click that is about to happen. */}
          {caveat !== null && <div className="cr-tune-caveat">{caveat}</div>}
        </div>
      )}
    </div>
  )
}
