// THE THREE CARDS — the part of the anatomy canvas that never changes.
//
// A container (containers.tsx) decides what the room looks like and where the
// floor slots are. It decides NOTHING about the cards. Every card:
//
//   - stands on a floor slot of exactly CELL x CELL, at z = 0, and needs no
//     wall, no shelf and no fixture behind it, so the same card drops into a
//     workbench, a control room or a circuit board unchanged;
//   - is told its centre and the projection, and nothing else about the scene;
//   - reads as its kind from the silhouette alone, before any colour or text
//     resolves: the agent stands up, the browser is half as tall, the note is
//     a pad on the floor. That is the one thing that has to survive a cell
//     shrinking to forty pixels.
//
// Colour follows the real cards on the flat canvas, because this is the same
// board seen another way: the agent is the dark terminal, the note is the
// amber pad, the browser is cream with an ink frame.

import { brandMark } from '../nodes/AgentAvatar'
import type { AgentSpriteKind } from '../nodes/AgentSprite'
import type { TurnPhase } from '../../../shared/turn'
import { Dots, FaceText, Line, Solid } from './draw'
import {
  haloOf,
  insetPlan,
  iso,
  lineOnTop,
  pathOf,
  planOutline,
  ring,
  sideSeam,
  slabOf,
  topMatrix,
  type Plan,
  type Point3,
  type Projection
} from './iso-kit'

/** The floor footprint every card gets, whatever its kind. */
export const CELL = 26

/**
 * Standing height per kind: the silhouette IS the kind.
 *
 * The ceiling is geometry, not taste. A card drawn h tall rises h*cos(e) up
 * the screen while the row behind it sits only pitch*sin(a)*sin(e) higher, so
 * anything taller than pitch*sin(a)*tan(e) — about 16 at the default camera —
 * covers the nameplate of the card behind it. These clear it at every camera
 * the view can choose, and still read as three distinct heights.
 */
export const CARD_HEIGHT = { terminal: 12.5, browser: 7, note: 2.8 } as const

export type AnatomyCardKind = keyof typeof CARD_HEIGHT

export interface AnatomyCard {
  id: string
  kind: AnatomyCardKind
  /** Agent name, note title or browser title — whatever the flat card shows. */
  name: string
  /** Agents only: which mark to stamp on the lid. */
  harness?: AgentSpriteKind
  /** Agents only. The app's four phases and no fifth: see TurnPhase. */
  phase?: TurnPhase
  /** Agents only: the model + effort tag, e.g. "opus high". Null when unrecorded. */
  tag?: string | null
  orch?: boolean
}

/** Dark lid, so the harness mark is stamped in cream rather than near-black. */
const MARK_INK = '#f3efe4'
const MARK_BOX = 26

const planAt = (x: number, y: number, inset: number, r: number): Plan => ({
  x: x - CELL / 2 + inset,
  y: y - CELL / 2 + inset,
  w: CELL - inset * 2,
  d: CELL - inset * 2,
  r
})

const quad = (points: Point3[], P: Projection): string =>
  pathOf(
    points.map((p) => iso(p, P)),
    true
  )

/**
 * How much room the label has. Below `nameplate` a cell is too small for text
 * and the card goes icon-only; the caller works this out once per layout from
 * the cell's size on screen, so every card in a view agrees.
 */
export interface AnatomyDetail {
  nameplate: boolean
  tag: boolean
}

export function AnatomyCardSolid({
  card,
  x,
  y,
  P,
  detail
}: {
  card: AnatomyCard
  x: number
  y: number
  P: Projection
  detail: AnatomyDetail
}): React.JSX.Element {
  const body =
    card.kind === 'terminal'
      ? agentBody(card, x, y, P, detail)
      : card.kind === 'browser'
        ? browserBody(card, x, y, P)
        : noteBody(card, x, y, P)
  return (
    <g
      // The phase is NOT on this group on purpose: the solids are memoised and
      // an agent's phase changes several times a second while it works. The lamp
      // housing below is static and AnatomyStatus draws the lit lens over it.
      className={`an-card an-${card.kind}`}
      data-node={card.id}
      data-kind={card.kind}
    >
      {body}
      {detail.nameplate ? nameplate(card, x, y, P) : null}
    </g>
  )
}

/* ---------- agent: the tall one, a terminal standing on the floor ---------- */
function agentBody(
  card: AnatomyCard,
  x: number,
  y: number,
  P: Projection,
  detail: AnatomyDetail
): React.JSX.Element {
  const plan = planAt(x, y, 1, 1.6)
  const h = CARD_HEIGHT.terminal
  const front = plan.y + plan.d
  const lid = h
  // A lit screen band on the face that looks at the viewer: the one place the
  // card says it is alive, and the only coloured thing on an idle board.
  const screen: Point3[] = [
    [plan.x + 2.6, front, 2.6],
    [plan.x + plan.w - 2.6, front, 2.6],
    [plan.x + plan.w - 2.6, front, lid - 2.6],
    [plan.x + 2.6, front, lid - 2.6]
  ]
  const rows = [0, 1, 2].map((i) => {
    const z = lid - 4 - i * 2.2
    const len = [11, 6.5, 9][i] * ((plan.w - 6) / 22)
    return pathOf([iso([plan.x + 4, front, z], P), iso([plan.x + 4 + len, front, z], P)])
  })
  const mark = card.harness ?? 'shell'
  const scale = 10 / MARK_BOX
  return (
    <>
      <path className="iso-halo" d={haloOf(plan, 0, h, P)} />
      <Solid
        paths={slabOf(plan, 0, h, P, 3, 0.6)}
        tone="hi"
        crease="lo"
        className="an-skin"
        inner={<Line d={sideSeam(plan, 3.2, P, 3)} tone="lo" />}
      />
      <path className="an-screen" d={quad(screen, P)} />
      {rows.map((d, i) => (
        <path key={i} className="an-scanline" data-row={i} d={d} />
      ))}
      <g className="an-mark" transform={topMatrix([x - 5, y - 5], lid, P)}>
        <g transform={`scale(${scale.toFixed(3)})`}>{brandMark(mark, MARK_INK)}</g>
      </g>
      <Line d={ring(plan.x + 3.6, plan.y + 3.6, 1.9, lid, P, 14)} tone="lo" className="an-lamp" />
      {card.orch ? (
        <FaceText transform={topMatrix([x + 2, y + 9.4], lid, P)} size={2.6} tone="mid">
          ORCH
        </FaceText>
      ) : null}
      {detail.tag && card.tag ? (
        <FaceText transform={topMatrix([x - 9.5, y + 9.4], lid, P)} size={2.6} tone="mid">
          {clip(card.tag, 12)}
        </FaceText>
      ) : null}
    </>
  )
}

/* ---------- browser: a window, half the agent's height ---------- */
function browserBody(card: AnatomyCard, x: number, y: number, P: Projection): React.JSX.Element {
  const plan = planAt(x, y, 2, 1)
  const h = CARD_HEIGHT.browser
  const bar = plan.y + 4.4
  return (
    <>
      <path className="iso-halo" d={haloOf(plan, 0, h, P)} />
      <Solid
        paths={slabOf(plan, 0, h, P, 2, 0.4)}
        tone="hi"
        crease="lo"
        className="an-skin"
        inner={<Line d={sideSeam(plan, h - 2, P, 2)} tone="lo" />}
      />
      {/* The lid IS the window: a title bar with its three dots and an
          address field, which is how a browser card reads on the flat canvas. */}
      <Line d={lineOnTop([plan.x + 0.8, bar], [plan.x + plan.w - 0.8, bar], h, P)} tone="lo" />
      <Dots
        points={[0, 1, 2].map((i) => iso([plan.x + 2 + i * 1.9, plan.y + 2.2, h], P))}
        size={0.5}
        tone="mid"
      />
      <Line
        d={planOutline(
          { x: plan.x + 7.4, y: plan.y + 1.3, w: plan.w - 8.6, d: 1.9, r: 0.8 },
          h,
          P,
          2
        )}
        tone="lo"
      />
      <Line
        d={planOutline(
          { x: plan.x + 2, y: bar - plan.y + plan.y + 1.6, w: plan.w - 4, d: plan.d - 7.6, r: 0.5 },
          h,
          P,
          2
        )}
        tone="faint"
      />
    </>
  )
}

/* ---------- note: a pad lying on the floor ---------- */
function noteBody(card: AnatomyCard, x: number, y: number, P: Projection): React.JSX.Element {
  const plan = planAt(x, y, 3, 0.6)
  const h = CARD_HEIGHT.note
  const ear = 4.4
  return (
    <>
      <path className="iso-halo" d={haloOf(plan, 0, h, P)} />
      <Solid
        paths={slabOf(plan, 0, h, P, 2, 0.3)}
        tone="hi"
        crease="lo"
        className="an-skin"
        // Page edges down the side: a pad of paper, not a slab.
        inner={
          <>
            <Line d={sideSeam(plan, h * 0.38, P, 2)} tone="faint" />
            <Line d={sideSeam(plan, h * 0.68, P, 2)} tone="faint" />
          </>
        }
      />
      <Line
        d={
          lineOnTop([plan.x + 2.4, plan.y + 5], [plan.x + plan.w - 3, plan.y + 5], h, P) +
          lineOnTop([plan.x + 2.4, plan.y + 8.6], [plan.x + plan.w - 6, plan.y + 8.6], h, P)
        }
        tone="faint"
        free
      />
      {/* The dog-eared corner: the one line that says paper at any size. */}
      <Line
        d={pathOf([
          iso([plan.x + plan.w - ear, plan.y + plan.d, h], P),
          iso([plan.x + plan.w - ear, plan.y + plan.d - ear, h], P),
          iso([plan.x + plan.w, plan.y + plan.d - ear, h], P)
        ])}
        tone="lo"
      />
    </>
  )
}

/* ---------- the nameplate, identical for all three ---------- */
function nameplate(card: AnatomyCard, x: number, y: number, P: Projection): React.JSX.Element {
  // Name only. The model tag used to share this plate and the two ran into
  // each other on any name longer than a word; it sits on the agent's lid now.
  const plate: Plan = { x: x - CELL / 2 + 1, y: y + CELL / 2 - 4.8, w: CELL - 2, d: 4.4, r: 0.6 }
  return (
    <g className="an-plate">
      <Solid paths={slabOf(plate, 0, 0.5, P, 2)} tone="lo" crease="none" className="an-plate-slab" />
      <FaceText transform={topMatrix([plate.x + 1.4, plate.y + 3.1], 0.5, P)} size={3} tone="hi">
        {clip(card.name, 13)}
      </FaceText>
    </g>
  )
}

/** The halo under a card, reused by the container to shade empty slots. */
export const slotHalo = (x: number, y: number, P: Projection): string =>
  haloOf(insetPlan(planAt(x, y, 1, 1.6), 1), 0, 0.4, P)

export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

/** Centre of an agent's lamp, so the live lens lands exactly on its housing. */
export function lampAt(x: number, y: number, P: Projection): [number, number] {
  const plan = planAt(x, y, 1, 1.6)
  return iso([plan.x + 3.6, plan.y + 3.6, CARD_HEIGHT.terminal], P)
}
