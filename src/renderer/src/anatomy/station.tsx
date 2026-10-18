// THE AGENT STATION — one agent, and everything it made, in one slot.
//
// The first cut gave a note and a browser the same floor slot an agent got.
// On the owner's board that is 33 agents against 214 deliverables, so 86% of
// the picture was tiles that look alike, cannot act, and never need anyone —
// and the agents were lost in them. A deliverable is EVIDENCE, not an actor:
// it belongs to the agent that made it.
//
// So a slot holds one agent and the agent's own output beside it, and the
// board is 34 units instead of 247. Each unit gets about eight times the area,
// which is the whole trick: that area is what pays for the one line saying
// what the agent just said.
//
// Two bins rather than one object per deliverable, on purpose. An agent with
// 63 browsers would otherwise rebuild the hairball inside its own slot. The
// bin's height reads the count (log-ish, capped), the exact number is on the
// glass, and the individual cards are one tap away in the panel.
//
// Height is the attention axis: everything rests flat, and the one agent that
// needs a person raises a mast. Nothing else in the scene moves.

import { brandMark } from '../nodes/AgentAvatar'
import type { AgentSpriteKind } from '../nodes/AgentSprite'
import type { TurnPhase } from '../../../shared/turn'
import { Line, Solid } from './draw'
import {
  haloOf,
  iso,
  lineOnTop,
  pathOf,
  planOutline,
  ring,
  sideSeam,
  slabOf,
  topMatrix,
  type Flat,
  type Plan,
  type Point3,
  type Projection
} from './iso-kit'

/** The floor slot one station stands on. */
export const STATION_CELL = 46

const PLINTH_H = 1.6
const DESK = { x: -20, y: -21, w: 26, d: 20, r: 2 }
const DESK_H = 14
const BIN_NOTE: Plan = { x: -20, y: 3, w: 17, d: 15, r: 1 }
const BIN_BROWSER: Plan = { x: 1, y: 3, w: 17, d: 15, r: 1 }
const MAST = { x: -7, y: -12 }
const MAST_H = 17

/** Dark lid: the mark is stamped in cream, not the coin's near-black. */
const MARK_INK = '#f3efe4'
const MARK_BOX = 26

export interface StationAgent {
  id: string
  name: string
  harness: AgentSpriteKind
  phase: TurnPhase
  orch: boolean
  notes: number
  browsers: number
}

const shift = (plan: Plan, x: number, y: number): Plan => ({ ...plan, x: plan.x + x, y: plan.y + y })
const quad = (points: Point3[], P: Projection): string =>
  pathOf(
    points.map((p) => iso(p, P)),
    true
  )

/**
 * How tall a bin of `n` stands. Flat at zero so an empty bin is visibly empty,
 * then log-ish so one deliverable and sixty-three are both legible without the
 * tall one leaving the slot.
 */
const binTiers = (n: number): number => (n === 0 ? 0 : Math.min(6, Math.ceil(Math.log2(n + 1))))

/** Where the station's label hangs on the glass: just above the desk's lid. */
export function stationLabelAt(x: number, y: number, P: Projection): Flat {
  return iso([x + DESK.x + DESK.w / 2, y + DESK.y + 2, PLINTH_H + DESK_H + 3], P)
}

/** The flag's tip, for the HITL pill to point at. */
export function stationFlagAt(x: number, y: number, P: Projection): Flat {
  return iso([x + MAST.x, y + MAST.y, PLINTH_H + DESK_H + MAST_H], P)
}

export function AnatomyStation({
  agent,
  x,
  y,
  P,
  selected
}: {
  agent: StationAgent
  x: number
  y: number
  P: Projection
  selected: boolean
}): React.JSX.Element {
  const desk = shift(DESK, x, y)
  const notes = shift(BIN_NOTE, x, y)
  const browsers = shift(BIN_BROWSER, x, y)
  const plinth: Plan = {
    x: x - STATION_CELL / 2 + 1,
    y: y - STATION_CELL / 2 + 1,
    w: STATION_CELL - 2,
    d: STATION_CELL - 2,
    r: 3
  }
  const lid = PLINTH_H + DESK_H
  const front = desk.y + desk.d
  const waiting = agent.phase === 'waiting'

  // The lit band on the face that looks at the viewer: the one coloured thing
  // on a calm board, and the same band the flat terminal card shows.
  const screen: Point3[] = [
    [desk.x + 3, front, PLINTH_H + 3],
    [desk.x + desk.w - 3, front, PLINTH_H + 3],
    [desk.x + desk.w - 3, front, lid - 3],
    [desk.x + 3, front, lid - 3]
  ]
  const rows = [0, 1, 2].map((i) => {
    const z = lid - 4.4 - i * 2.4
    const len = [15, 9, 12][i]
    return pathOf([iso([desk.x + 5, front, z], P), iso([desk.x + 5 + len, front, z], P)])
  })
  const markScale = 11 / MARK_BOX

  return (
    <g
      className={`an-station st-${agent.phase}${selected ? ' sel' : ''}${agent.orch ? ' orch' : ''}`}
      data-unit={agent.id}
    >
      <path className="iso-halo" d={haloOf(plinth, 0, PLINTH_H, P)} />
      <Solid paths={slabOf(plinth, 0, PLINTH_H, P, 4, 0.4)} tone="lo" crease="none" className="an-plinth" />
      <Line d={planOutline({ ...plinth, x: plinth.x + 1.5, y: plinth.y + 1.5, w: plinth.w - 3, d: plinth.d - 3 }, PLINTH_H, P, 4)} tone="faint" />

      {/* the two bins, in front of the desk so the taller desk is never hidden */}
      <Bin plan={notes} n={agent.notes} kind="note" P={P} agent={agent.id} />
      <Bin plan={browsers} n={agent.browsers} kind="browser" P={P} agent={agent.id} />

      {/* the desk itself */}
      <Solid
        paths={slabOf(desk, PLINTH_H, DESK_H, P, 3, 0.6)}
        tone="hi"
        crease="lo"
        className="an-desk"
        inner={<Line d={sideSeam(desk, PLINTH_H + 3, P, 3)} tone="lo" />}
      />
      <path className="an-screen" d={quad(screen, P)} />
      {rows.map((d, i) => (
        <path key={i} className="an-scanline" data-row={i} d={d} />
      ))}
      <g className="an-mark" transform={topMatrix([x + DESK.x + 14, y + DESK.y + 4], lid, P)}>
        <g transform={`scale(${markScale.toFixed(3)})`}>{brandMark(agent.harness, MARK_INK)}</g>
      </g>
      {/* the lamp. The lens takes its colour from the station's phase class, so
          it says exactly what the flat card's status coin says. */}
      <Line d={ring(desk.x + 4.5, desk.y + 4.5, 2.6, lid, P, 16)} tone="lo" className="an-lamp" />
      <circle
        className="an-lens"
        cx={iso([desk.x + 4.5, desk.y + 4.5, lid], P)[0].toFixed(1)}
        cy={iso([desk.x + 4.5, desk.y + 4.5, lid], P)[1].toFixed(1)}
        r={Math.max(2.4, Math.abs(iso([desk.x + 2, desk.y + 4.5, lid], P)[0] - iso([desk.x + 4.5, desk.y + 4.5, lid], P)[0]))}
      />

      {/* the mast. Nothing at all unless this agent is waiting on a person —
          height is the attention axis, so the one that needs you stands up. */}
      {waiting ? (
        <g className="an-mast">
          <Solid
            paths={slabOf({ x: x + MAST.x - 0.6, y: y + MAST.y - 0.6, w: 1.2, d: 1.2, r: 0 }, lid, MAST_H, P, 1)}
            tone="mid"
            crease="none"
          />
          <path
            className="an-flag"
            d={quad(
              [
                [x + MAST.x, y + MAST.y, lid + MAST_H],
                [x + MAST.x + 13, y + MAST.y, lid + MAST_H - 2.6],
                [x + MAST.x, y + MAST.y, lid + MAST_H - 6.4]
              ],
              P
            )}
          />
        </g>
      ) : null}
      {agent.orch ? (
        <Line d={lineOnTop([desk.x + 2, desk.y + desk.d - 2], [desk.x + desk.w - 2, desk.y + desk.d - 2], lid, P)} tone="mid" className="an-orch-rule" />
      ) : null}
    </g>
  )
}

/**
 * A bin of deliverables. One object whatever the count, because sixty-three
 * browsers drawn one by one is the hairball again, one slot smaller.
 */
function Bin({
  plan,
  n,
  kind,
  P,
  agent
}: {
  plan: Plan
  n: number
  kind: 'note' | 'browser'
  P: Projection
  agent: string
}): React.JSX.Element {
  const tiers = binTiers(n)
  const h = kind === 'note' ? 0.8 + tiers * 1.5 : 1.2 + tiers * 2
  if (n === 0) {
    // An empty bay, not a missing one: the slot keeps its shape either way.
    return <Line d={planOutline(plan, PLINTH_H, P, 2)} tone="faint" className={`an-bin an-${kind} empty`} />
  }
  const leaves = Array.from({ length: Math.min(tiers, 5) }, (_, i) =>
    sideSeam(plan, PLINTH_H + (h * (i + 1)) / (Math.min(tiers, 5) + 1), P, 2)
  ).join('')
  return (
    <g className={`an-bin an-${kind}`} data-bin={kind} data-owner={agent}>
      <Solid
        paths={slabOf(plan, PLINTH_H, h, P, 2, 0.3)}
        tone="hi"
        crease="lo"
        className="an-bin-skin"
        inner={<Line d={leaves} tone="faint" />}
      />
      {kind === 'browser' ? (
        <Line
          d={
            lineOnTop([plan.x + 1, plan.y + 4], [plan.x + plan.w - 1, plan.y + 4], PLINTH_H + h, P) +
            planOutline({ x: plan.x + 1.5, y: plan.y + 5.5, w: plan.w - 3, d: plan.d - 7, r: 0.4 }, PLINTH_H + h, P, 2)
          }
          tone="lo"
        />
      ) : (
        <Line
          d={
            lineOnTop([plan.x + 2.5, plan.y + 4.5], [plan.x + plan.w - 3, plan.y + 4.5], PLINTH_H + h, P) +
            lineOnTop([plan.x + 2.5, plan.y + 8], [plan.x + plan.w - 6, plan.y + 8], PLINTH_H + h, P)
          }
          tone="faint"
          free
        />
      )}
    </g>
  )
}
