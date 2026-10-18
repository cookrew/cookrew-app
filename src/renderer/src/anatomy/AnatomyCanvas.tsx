// The anatomy canvas: the whole board as one isometric figure, sized to the
// stage and never panned.
//
// It is a VIEW of the same nodes and edges ReactFlow is given, so nothing here
// writes: a tap hands the id back to App, which focuses the real card. The
// board's cards keep their own design (cards.tsx) in whichever container the
// viewer picked (containers.tsx).
//
// Two layers, split on how often they change:
//   - the figure: furniture, cables and card solids, memoised on geometry, so
//     a turn starting somewhere does not redraw two hundred solids;
//   - the status overlay: one lit lens per agent, redrawn on every activity
//     event, which is cheap because it is one circle per agent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './anatomy.css'
import type { Edge, Node } from '@xyflow/react'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useTuningsSnapshot } from '../tuning-store'
import { spriteForPreset } from '../nodes/AgentSprite'
import { tuningTag } from '../../../shared/agent-tuning'
import type { TurnPhase } from '../../../shared/turn'
import { AnatomyCardSolid, clip, lampAt, type AnatomyCard, type AnatomyDetail } from './cards'
import { CONTAINERS, containerOf, floorOf } from './containers'
import {
  PITCH,
  orderCards,
  planGrid,
  roundedPath,
  routeCables,
  slotCentre,
  gridBounds,
  type AnatomyOrientation
} from './layout'
import { depthOf, fitProjection, iso, type Projection } from './iso-kit'

const CONTAINER_KEY = 'cookrew-anatomy-container'
const ORIENTATION_KEY = 'cookrew-anatomy-orientation'

export interface AnatomyCanvasProps {
  nodes: Node[]
  edges: Edge[]
  title: string
  selectedId: string | null
  /** Hand the card back to the flat canvas: focus it, open it, zoom to it. */
  onPick: (id: string) => void
}

interface BoardModel {
  cards: AnatomyCard[]
  owners: Map<string, string | null>
  links: Array<readonly [string, string]>
}

/** Read the board out of what ReactFlow was handed. Nothing here writes. */
function readBoard(nodes: readonly Node[], edges: readonly Edge[]): BoardModel {
  const kinds = new Map<string, 'terminal' | 'note' | 'browser'>()
  const cards: AnatomyCard[] = []
  for (const node of nodes) {
    const kind = node.type === 'terminal' || node.type === 'note' || node.type === 'browser' ? node.type : null
    if (kind === null) continue
    kinds.set(node.id, kind)
    // ReactFlow carries the CanvasNode under `data.node` (the card components
    // read it the same way) with some fields also spread alongside it. Read
    // the nested one and fall back, or every name here is an id.
    const raw = node.data as { node?: Record<string, unknown> } & Record<string, unknown>
    const data = raw.node ?? raw
    const custom = typeof data.customName === 'string' ? data.customName : null
    const name = custom ?? (typeof data.name === 'string' ? data.name : node.id)
    const preset = typeof data.preset === 'string' ? data.preset : ''
    cards.push({
      id: node.id,
      kind,
      name,
      harness: kind === 'terminal' ? spriteForPreset(preset) : undefined,
      orch: kind === 'terminal' && data.orch === true
    })
  }
  const owners = new Map<string, string | null>(cards.map((c) => [c.id, null]))
  const links: Array<readonly [string, string]> = []
  for (const edge of edges) {
    const a = kinds.get(edge.source)
    const b = kinds.get(edge.target)
    if (a === undefined || b === undefined) continue
    if (a === 'terminal' && b === 'terminal') {
      links.push([edge.source, edge.target] as const)
      continue
    }
    // An agent owns the card it is wired to; the first wire wins, as it does
    // in every other reading of this board.
    if (a === 'terminal' && owners.get(edge.target) === null) owners.set(edge.target, edge.source)
    if (b === 'terminal' && owners.get(edge.source) === null) owners.set(edge.source, edge.target)
  }
  return { cards, owners, links }
}

function useStageSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect
      setSize((prev) =>
        Math.abs(prev.w - box.width) < 1 && Math.abs(prev.h - box.height) < 1
          ? prev
          : { w: box.width, h: box.height }
      )
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeStored = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* a locked-down webview still gets the default */
  }
}

export function AnatomyCanvas({
  nodes,
  edges,
  title,
  selectedId,
  onPick
}: AnatomyCanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const { w, h } = useStageSize(hostRef)
  const [containerId, setContainerId] = useState<string>(() => readStored(CONTAINER_KEY) ?? 'bench')
  // Mac opens landscape because its stage is always wider than tall; the
  // stored pick only exists once someone has overridden the shape by hand.
  const [override, setOverride] = useState<AnatomyOrientation | null>(() => {
    const stored = readStored(ORIENTATION_KEY)
    return stored === 'landscape' || stored === 'portrait' ? stored : null
  })
  const orientation: AnatomyOrientation = override ?? (w > 0 && w / h < 0.85 ? 'portrait' : 'landscape')

  const container = containerOf(containerId)
  const board = useMemo(() => readBoard(nodes, edges), [nodes, edges])
  const activities = useActivitiesSnapshot()
  const tunings = useTuningsSnapshot()

  const view = useMemo(() => {
    if (w < 40 || h < 40) return null
    const order = orderCards(
      board.cards.map((c) => ({ id: c.id, kind: c.kind, owner: board.owners.get(c.id) ?? null })),
      // The column count is chosen with the camera, so the ordering is done
      // twice: once to learn how many slots are needed, then for real.
      planGrid(board.cards.length, w / h, orientation).cols
    )
    const grid = planGrid(Math.max(order.length, board.cards.length), w / h, orientation)
    const placed = orderCards(
      board.cards.map((c) => ({ id: c.id, kind: c.kind, owner: board.owners.get(c.id) ?? null })),
      grid.cols
    )
    const floor = floorOf(grid)
    const P: Projection = fitProjection(
      [...gridBounds(grid), ...container.extent(floor, grid)],
      w,
      h,
      { pad: 8, azimuth: grid.azimuth, elevation: grid.elevation }
    )
    const indexOf = new Map<string, number>()
    placed.forEach((id, i) => {
      if (id !== '') indexOf.set(id, i)
    })
    const byId = new Map(board.cards.map((c) => [c.id, c]))
    const seats = placed.flatMap((id, i) => {
      const card = byId.get(id)
      if (!card) return []
      const { x, y } = slotCentre(i, grid)
      const tagged: AnatomyCard =
        card.kind === 'terminal' ? { ...card, tag: tuningTag(tunings[card.id] ?? null) } : card
      return [{ card: tagged, x, y, depth: depthOf([x, y, 0], P) }]
    })
    seats.sort((a, b) => a.depth - b.depth)
    const a = iso([0, 0, 0], P)
    const b = iso([PITCH, 0, 0], P)
    const cellPx = Math.hypot(b[0] - a[0], b[1] - a[1])
    const detail: AnatomyDetail = { nameplate: cellPx >= 54, tag: cellPx >= 94 }
    const cables = routeCables(board.links, (id) => indexOf.get(id), grid).map((cable) => ({
      ...cable,
      d: roundedPath(
        cable.points.map((p) => iso([p[0], p[1], 0.6], P)),
        6
      )
    }))
    return { grid, P, seats, cables, detail, floor, cellPx }
  }, [board, w, h, orientation, tunings, container])

  const pickContainer = useCallback((id: string) => {
    setContainerId(id)
    writeStored(CONTAINER_KEY, id)
  }, [])
  const flip = useCallback(() => {
    setOverride((prev) => {
      const next: AnatomyOrientation = prev === 'portrait' ? 'landscape' : 'portrait'
      writeStored(ORIENTATION_KEY, next)
      return next
    })
  }, [])

  const onClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const hit = (event.target as Element).closest('[data-node]')
      const id = hit?.getAttribute('data-node')
      if (id) onPick(id)
    },
    [onPick]
  )

  const figure = useMemo(() => {
    if (view === null) return null
    return (
      <>
        <g className="an-furniture">
          {container.furniture({ grid: view.grid, P: view.P, floor: view.floor, title })}
        </g>
        <g className="an-cables">
          {view.cables.map((cable) => (
            <g key={`${cable.a}-${cable.b}`} className="an-cable" data-a={cable.a} data-b={cable.b}>
              <path className="an-cable-out" d={cable.d} />
              <path className="an-cable-in" d={cable.d} />
            </g>
          ))}
        </g>
        <g className="an-cards">
          {view.seats.map((seat) => (
            <AnatomyCardSolid
              key={seat.card.id}
              card={seat.card}
              x={seat.x}
              y={seat.y}
              P={view.P}
              detail={view.detail}
            />
          ))}
        </g>
      </>
    )
  }, [view, container, title])

  return (
    <div className="an-host" ref={hostRef} data-orientation={orientation}>
      {view === null ? null : (
        <svg
          className="iso-svg an-svg"
          viewBox={`0 0 ${w} ${h}`}
          role="application"
          aria-label={`${title}: ${board.cards.length} cards as an anatomy figure`}
          onClick={onClick}
        >
          {figure}
          <g className="an-status" aria-hidden="true">
            {view.seats.map((seat) => {
              if (seat.card.kind !== 'terminal') return null
              // `?? 'idle'` is TerminalNode's own line (nodes/TerminalNode.tsx).
              // This read used to default to an invented 'off', and on the live
              // board 31 of 33 agents had no activity record yet — so the figure
              // showed a fleet of dark lamps while the flat cards right beside
              // it showed the same agents green. A view of the same board has
              // to make the same claim about it.
              const phase: TurnPhase = activities[seat.card.id]?.phase ?? 'idle'
              const [lx, ly] = lampAt(seat.x, seat.y, view.P)
              return (
                <circle
                  key={seat.card.id}
                  className={`an-lens st-${phase}`}
                  cx={lx.toFixed(1)}
                  cy={ly.toFixed(1)}
                  r={Math.max(2.2, view.cellPx * 0.05)}
                />
              )
            })}
          </g>
          {selectedId === null ? null : (
            <g className="an-pick">
              {view.seats
                .filter((seat) => seat.card.id === selectedId)
                .map((seat) => {
                  const [cx, cy] = iso([seat.x, seat.y, 0], view.P)
                  return (
                    <circle
                      key={seat.card.id}
                      cx={cx.toFixed(1)}
                      cy={cy.toFixed(1)}
                      r={Math.max(10, view.cellPx * 0.52)}
                    />
                  )
                })}
            </g>
          )}
        </svg>
      )}
      <div className="an-controls" role="group" aria-label="Anatomy view">
        {CONTAINERS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={c.id === container.id}
            onClick={() => pickContainer(c.id)}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className="an-flip"
          onClick={flip}
          title={`Shape: ${orientation}. Tap for ${orientation === 'landscape' ? 'portrait' : 'landscape'}.`}
          aria-label={`Shape: ${orientation}`}
        >
          {orientation === 'landscape' ? '↔' : '↕'}
        </button>
      </div>
      {view !== null && view.detail.nameplate ? null : (
        <p className="an-dense">
          {clip(title, 20)} · {board.cards.length} cards · names hidden at this density
        </p>
      )}
    </div>
  )
}
