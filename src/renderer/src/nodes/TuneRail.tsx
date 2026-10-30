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
import type { CardRouteState } from '../../../shared/route'
import { routeDialLines, shortRoute } from '../../../shared/route-view'

/**
 * R2 · THE THIRD DIAL. Model and effort come from the harness's own record;
 * the route comes from the gateway (CardRouteState) — what the card asked
 * for, what answered this turn and what it cost. Same chip, same list, two
 * clicks to change: open, pick. Null when the card may not have one (a
 * served session, a bridge without routing).
 */
export interface RouteDialProps {
  state: CardRouteState | null
  /** direct first, then groups, then models (route-view.routeChoices). */
  choices: string[]
  open: boolean
  onOpen: (open: boolean) => void
  onPick: (route: string) => void
  /** A harness that cannot be routed this round (pi): the chip says so and has no list. */
  notRoutable?: string | null
}

export interface TuneRailProps {
  view: TuneRailView
  open: TuneKnob | null
  onOpen: (knob: TuneKnob | null) => void
  onTurn: (knob: TuneKnob, value: string) => void
  error: string | null
  /** Clicking the rail must not pull focus out of the live pane. */
  onMouseDown?: (e: React.MouseEvent) => void
  route?: RouteDialProps | null
  /**
   * Only these typed knobs (default: every one the view has). The top bar asks
   * for one switch — `['model']`, or `[]` with the route dial — rather than
   * the whole rail (zoom-bar.ts).
   */
  knobs?: readonly TuneKnob[]
  /** Drawn on the top bar: a row of chips whose lists drop DOWN. */
  bar?: boolean
}

export function TuneRail({
  view,
  open,
  onOpen,
  onTurn,
  error,
  onMouseDown,
  route,
  knobs,
  bar = false
}: TuneRailProps): React.JSX.Element {
  const locked = view.locked
  const shown = view.dials.filter((dial) => dial.knob !== 'route' && (knobs === undefined || knobs.includes(dial.knob)))
  const label = bar ? (route ? 'Route' : 'Model') : route ? 'Model, effort and route' : 'Model and effort'
  return (
    <div className={`cr-tune-rail${bar ? ' bar' : ''}`} role="group" aria-label={label}>
      {/* The generic dials are the TYPED knobs. The route knob main lists in
          `knobs` is drawn by RouteDial below from CardRouteState — never as a
          generic dial, which would read the session file for a route. */}
      {shown.map((dial) => (
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
      {route && <RouteDial route={route} locked={locked} onMouseDown={onMouseDown} />}
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

function RouteDial({
  route,
  locked,
  onMouseDown
}: {
  route: RouteDialProps
  locked: string | null
  onMouseDown?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const lines = route.notRoutable ? { value: 'direct', turn: null, note: route.notRoutable, flag: null as null } : routeDialLines(route.state)
  const reading = route.state === null && !route.notRoutable ? 'not read yet' : lines.value
  const canOpen = !route.notRoutable
  return (
    <div className={`cr-tune-dial${route.open ? ' open' : ''}`} data-knob="route">
      <button
        type="button"
        className={`cr-tune-chip${lines.flag === 'offline' ? ' refused' : lines.flag === 'restart' ? ' pending' : ''}`}
        aria-expanded={route.open}
        aria-label={`Route: ${reading}`}
        title={[`Route: ${reading}`, lines.turn, lines.note].filter(Boolean).join(' · ')}
        onMouseDown={onMouseDown}
        onClick={() => canOpen && route.onOpen(!route.open)}
      >
        <span className="cr-tune-k">RTE</span>
        <span className="cr-tune-v">{route.state === null && !route.notRoutable ? '\u2014' : shortRoute(lines.value)}</span>
        {lines.turn !== null && <span className="cr-tune-flag cr-tune-turn">{lines.turn.replace('this turn → ', '→ ')}</span>}
        {lines.note !== null && <span className="cr-tune-flag">{lines.note}</span>}
      </button>
      {route.open && canOpen && (
        <div className="cr-tune-list" role="listbox" aria-label="Route">
          {route.choices.map((value) => {
            const current = route.state !== null && route.state.route === value
            return (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={current}
                className={`cr-tune-row ${current ? 'current' : 'plain'}${value.startsWith('group/') ? ' group' : ''}`}
                disabled={locked !== null}
                onMouseDown={onMouseDown}
                onClick={() => route.onPick(value)}
              >
                {value}
              </button>
            )
          })}
          <div className="cr-tune-note">groups first · a pick applies on the card's next restart</div>
        </div>
      )}
    </div>
  )
}
