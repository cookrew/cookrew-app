// The anatomy canvas: the whole board as one isometric figure, sized to the
// stage and never panned.
//
// THREE RULES, and everything here follows from them.
//
// 1. A SLOT IS AN AGENT. A note and a browser are evidence of work, not
//    workers: they cannot act and they never need anybody, so they live in
//    their agent's station (station.tsx) instead of taking a slot each. On
//    the owner's board that is 247 tiles down to 34 units, and the area that
//    buys is what pays for rule 2.
//
// 2. THE SCENE CARRIES STATE, THE GLASS CARRIES WORDS. Objects are drawn in
//    the isometric scene; every word is upright HTML on top of it. Text laid
//    on a projected face is hard to read at this size in any language and
//    hopeless in Chinese, and it was the first version's worst fault.
//
// 3. HEIGHT IS THE ATTENTION AXIS. The board rests flat and still. The one
//    agent waiting on a person raises a mast, and a single pill names how
//    many there are. Nothing else moves, and when nobody is waiting the pill
//    is not rendered at all — a calm board has to look calm.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './anatomy.css'
import type { Edge, Node } from '@xyflow/react'
import { useActivitiesSnapshot } from '../activity-thumb-store'
import { useTuningsSnapshot } from '../tuning-store'
import { spriteForPreset, type AgentSpriteKind } from '../nodes/AgentSprite'
import { tuningTag } from '../../../shared/agent-tuning'
import type { TerminalActivity, TurnPhase } from '../../../shared/turn'
import { AnatomyStation, stationLabelAt, type StationAgent } from './station'
import { CONTAINERS, containerOf, floorOf } from './containers'
import {
  PITCH,
  gridBounds,
  orderAgents,
  planGrid,
  roundedPath,
  routeCables,
  slotCentre,
  type AnatomyOrientation
} from './layout'
import { depthOf, fitProjection, iso, type Flat, type Projection } from './iso-kit'

const CONTAINER_KEY = 'cookrew-anatomy-container'
const ORIENTATION_KEY = 'cookrew-anatomy-orientation'

export interface AnatomyCanvasProps {
  nodes: Node[]
  edges: Edge[]
  title: string
  selectedId: string | null
  /** Hand a card back to the flat canvas: focus it, open it, zoom to it. */
  onPick: (id: string) => void
}

interface Deliverable {
  id: string
  kind: 'note' | 'browser'
  name: string
}
interface BoardAgent {
  id: string
  name: string
  harness: AgentSpriteKind
  orch: boolean
  notes: Deliverable[]
  browsers: Deliverable[]
  peers: string[]
}
interface Board {
  agents: BoardAgent[]
  links: Array<readonly [string, string]>
  unowned: number
}

/** Read the board out of what ReactFlow was handed. Nothing here writes. */
function readBoard(nodes: readonly Node[], edges: readonly Edge[]): Board {
  const kinds = new Map<string, 'terminal' | 'note' | 'browser'>()
  const agents = new Map<string, BoardAgent>()
  const items = new Map<string, Deliverable>()
  for (const node of nodes) {
    const kind =
      node.type === 'terminal' || node.type === 'note' || node.type === 'browser' ? node.type : null
    if (kind === null) continue
    kinds.set(node.id, kind)
    // ReactFlow carries the CanvasNode under `data.node`, with some fields
    // also spread alongside it. Read the nested one or every name is an id.
    const raw = node.data as { node?: Record<string, unknown> } & Record<string, unknown>
    const data = raw.node ?? raw
    const custom = typeof data.customName === 'string' ? data.customName : null
    const name = custom ?? (typeof data.name === 'string' ? data.name : node.id)
    if (kind === 'terminal') {
      const preset = typeof data.preset === 'string' ? data.preset : ''
      agents.set(node.id, {
        id: node.id,
        name,
        harness: spriteForPreset(preset),
        orch: data.orch === true,
        notes: [],
        browsers: [],
        peers: []
      })
    } else {
      items.set(node.id, { id: node.id, kind, name })
    }
  }
  const owned = new Set<string>()
  const links: Array<readonly [string, string]> = []
  for (const edge of edges) {
    const a = kinds.get(edge.source)
    const b = kinds.get(edge.target)
    if (a === undefined || b === undefined) continue
    if (a === 'terminal' && b === 'terminal') {
      links.push([edge.source, edge.target] as const)
      agents.get(edge.source)?.peers.push(edge.target)
      agents.get(edge.target)?.peers.push(edge.source)
      continue
    }
    // An agent owns the card it is wired to; the first wire wins, as it does
    // in every other reading of this board.
    const pair: Array<[string, string]> =
      a === 'terminal'
        ? [[edge.source, edge.target]]
        : b === 'terminal'
          ? [[edge.target, edge.source]]
          : []
    for (const [agentId, itemId] of pair) {
      const item = items.get(itemId)
      const agent = agents.get(agentId)
      if (!item || !agent || owned.has(itemId)) continue
      owned.add(itemId)
      if (item.kind === 'note') agent.notes.push(item)
      else agent.browsers.push(item)
    }
  }
  return {
    agents: [...agents.values()],
    links,
    unowned: [...items.keys()].filter((id) => !owned.has(id)).length
  }
}

/* ---------- what an agent is doing, from the app's own live store ---------- */
const PHASE_WORD: Record<TurnPhase, string> = {
  idle: '空闲',
  thinking: '在干活',
  waiting: '在等你',
  replied: '刚回复'
}
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
/**
 * The single line a station shows without being asked. While a turn runs that
 * is what the agent is doing; the rest of the time it is the last thing it
 * said — which is what a person actually wants off a glance.
 */
function latestOf(activity: TerminalActivity | undefined): string {
  if (activity === undefined) return ''
  if (activity.phase === 'thinking') {
    return oneLine(activity.glance?.status ?? activity.glance?.message ?? activity.title ?? '')
  }
  return oneLine(activity.reply ?? activity.glance?.message ?? activity.title ?? '')
}
/** The fuller text for the panel: the reply itself, not a status line. */
function replyOf(activity: TerminalActivity | undefined): string {
  if (activity === undefined) return ''
  return (activity.reply ?? activity.glance?.message ?? '').trim()
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
  const [pinned, setPinned] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const orientation: AnatomyOrientation =
    override ?? (w > 0 && w / h < 0.85 ? 'portrait' : 'landscape')

  const container = containerOf(containerId)
  const board = useMemo(() => readBoard(nodes, edges), [nodes, edges])
  const activities = useActivitiesSnapshot()
  const tunings = useTuningsSnapshot()

  const view = useMemo(() => {
    if (w < 40 || h < 40 || board.agents.length === 0) return null
    const grid = planGrid(board.agents.length, w / h, orientation)
    const placed = orderAgents(
      board.agents.map((a) => a.id),
      board.links,
      grid.cols,
      grid.rows
    )
    const floor = floorOf(grid)
    const P: Projection = fitProjection([...gridBounds(grid), ...container.extent(floor, grid)], w, h, {
      pad: 8,
      azimuth: grid.azimuth,
      elevation: grid.elevation
    })
    const indexOf = new Map<string, number>()
    placed.forEach((id, i) => {
      if (id !== '') indexOf.set(id, i)
    })
    const byId = new Map(board.agents.map((a) => [a.id, a]))
    const seats = placed.flatMap((id, i) => {
      const agent = byId.get(id)
      if (!agent) return []
      const { x, y } = slotCentre(i, grid)
      return [{ agent, x, y, depth: depthOf([x, y, 0], P), label: stationLabelAt(x, y, P) }]
    })
    seats.sort((a, b) => a.depth - b.depth)
    const a = iso([0, 0, 0], P)
    const b = iso([PITCH, 0, 0], P)
    const cellPx = Math.hypot(b[0] - a[0], b[1] - a[1])
    const cables = routeCables(board.links, (id) => indexOf.get(id), grid).map((cable) => ({
      ...cable,
      d: roundedPath(
        cable.points.map((p) => iso([p[0], p[1], 0.6], P)),
        6
      )
    }))
    return { grid, P, seats, cables, floor, cellPx }
  }, [board, w, h, orientation, container])

  /**
   * The figure is redrawn when the BOARD or a PHASE changes, not when an
   * activity object does. A running turn replaces its activity several times
   * a second and the geometry has nothing to say about any of it; only the
   * four phases change what is drawn (the lamp, and the mast on waiting).
   */
  const phaseKey = board.agents.map((a) => `${a.id}:${activities[a.id]?.phase ?? 'idle'}`).join('|')
  const figure = useMemo(() => {
    if (view === null) return null
    const phaseOf = (id: string): TurnPhase => activities[id]?.phase ?? 'idle'
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
        <g className="an-stations">
          {view.seats.map((seat) => {
            const agent: StationAgent = {
              id: seat.agent.id,
              name: seat.agent.name,
              harness: seat.agent.harness,
              phase: phaseOf(seat.agent.id),
              orch: seat.agent.orch,
              notes: seat.agent.notes.length,
              browsers: seat.agent.browsers.length
            }
            return (
              <AnatomyStation
                key={agent.id}
                agent={agent}
                x={seat.x}
                y={seat.y}
                P={view.P}
                selected={selectedId === agent.id}
              />
            )
          })}
        </g>
      </>
    )
    // phaseKey IS the read of `activities` this memo depends on: depending on
    // the object itself would redraw every solid several times a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, container, title, phaseKey, selectedId])

  const waiting = board.agents.filter((a) => activities[a.id]?.phase === 'waiting')
  const shown = pinned ?? hovered
  const shownAgent = shown === null ? null : (board.agents.find((a) => a.id === shown) ?? null)

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

  const unitUnder = (target: EventTarget | null): string | null =>
    (target as Element | null)?.closest('[data-unit]')?.getAttribute('data-unit') ?? null
  const onClick = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
    const id = unitUnder(event.target)
    setPinned((prev) => (id === null ? null : prev === id ? null : id))
  }, [])
  const onMove = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
    setHovered(unitUnder(event.target))
  }, [])

  // The pill walks the waiting agents, so nobody has to scan for them.
  const nextWaiting = useCallback(() => {
    if (waiting.length === 0) return
    const at = waiting.findIndex((a) => a.id === pinned)
    setPinned(waiting[(at + 1) % waiting.length].id)
  }, [waiting, pinned])

  const panelAt: Flat | null =
    shownAgent === null ? null : (view?.seats.find((s) => s.agent.id === shownAgent.id)?.label ?? null)

  return (
    <div className="an-host" ref={hostRef} data-orientation={orientation}>
      {view === null ? null : (
        <>
          <svg
            className="iso-svg an-svg"
            viewBox={`0 0 ${w} ${h}`}
            role="application"
            aria-label={`${title}: ${board.agents.length} agents as an anatomy figure`}
            onClick={onClick}
            onMouseMove={onMove}
            onMouseLeave={() => setHovered(null)}
          >
            {figure}
          </svg>
          {/* THE GLASS. Every word on this view is here, upright. */}
          <div className="an-glass" aria-hidden="true">
            {view.seats.map((seat) => {
              const activity = activities[seat.agent.id]
              const phase = activity?.phase ?? 'idle'
              const tag = tuningTag(tunings[seat.agent.id] ?? null)
              // On a phone every slot is about sixty pixels across and
              // thirty-four names land on top of each other. The ones with
              // something to say keep their label; the settled ones are a
              // lamp and a shape, which is all a glance needs from them.
              if (view.cellPx < 78 && phase === 'idle' && shown !== seat.agent.id) return null
              return (
                <div
                  key={seat.agent.id}
                  className={`an-label st-${phase}${shown === seat.agent.id ? ' on' : ''}${phase === 'idle' ? ' quiet' : ''}`}
                  style={{
                    left: `${seat.label[0].toFixed(1)}px`,
                    top: `${seat.label[1].toFixed(1)}px`,
                    maxWidth: `${Math.max(90, view.cellPx * 0.98).toFixed(0)}px`
                  }}
                >
                  <b>
                    {seat.agent.name}
                    {tag ? <i>{tag}</i> : null}
                  </b>
                  {/* A line only when there is something new to say. `idle`
                      means nothing has happened since you last looked, and a
                      board where thirty-four agents all talk at once is the
                      noise this view exists to remove. Its last word is still
                      one hover away in the panel. */}
                  {phase === 'idle' ? null : <span>{latestOf(activity) || PHASE_WORD[phase]}</span>}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* The only interrupt on this view, and it is absent when nobody waits. */}
      {waiting.length > 0 ? (
        <button type="button" className="an-hitl" onClick={nextWaiting}>
          <i />
          {waiting.length} 个 agent 在等你
          <u>下一个 →</u>
        </button>
      ) : null}

      {shownAgent !== null && panelAt !== null ? (
        <AgentPanel
          agent={shownAgent}
          activity={activities[shownAgent.id]}
          tag={tuningTag(tunings[shownAgent.id] ?? null)}
          at={panelAt}
          stage={{ w, h }}
          pinned={pinned === shownAgent.id}
          onOpen={onPick}
          onClose={() => setPinned(null)}
        />
      ) : null}

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

      <p className="an-foot">
        {board.agents.length} agents · {board.agents.reduce((n, a) => n + a.notes.length, 0)} notes ·{' '}
        {board.agents.reduce((n, a) => n + a.browsers.length, 0)} browsers
        {board.unowned > 0 ? ` · ${board.unowned} unowned` : ''}
      </p>
    </div>
  )
}

/**
 * The summary, on demand. Hovering shows it, a click pins it; it never
 * appears on its own, because a panel that opens by itself is the one thing
 * this view is meant not to do.
 */
function AgentPanel({
  agent,
  activity,
  tag,
  at,
  stage,
  pinned,
  onOpen,
  onClose
}: {
  agent: BoardAgent
  activity: TerminalActivity | undefined
  tag: string | null
  at: Flat
  stage: { w: number; h: number }
  pinned: boolean
  onOpen: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const W = 320
  const phase = activity?.phase ?? 'idle'
  const reply = replyOf(activity)
  const task = (activity?.prompt ?? activity?.title ?? '').trim()
  // Clamped to the stage: a panel half off the screen is a panel nobody reads.
  const left = Math.min(Math.max(8, at[0] - W / 2), Math.max(8, stage.w - W - 8))
  const below = at[1] < stage.h * 0.45
  const deliverables = [...agent.notes, ...agent.browsers]
  return (
    <aside
      className={`an-panel st-${phase}${pinned ? ' pinned' : ''}`}
      style={{
        left: `${left.toFixed(0)}px`,
        top: below ? `${(at[1] + 18).toFixed(0)}px` : 'auto',
        bottom: below ? 'auto' : `${Math.max(8, stage.h - at[1] + 14).toFixed(0)}px`,
        width: `${W}px`
      }}
    >
      <header>
        <b>{agent.name}</b>
        <span className={`an-phase st-${phase}`}>{PHASE_WORD[phase]}</span>
        {pinned ? (
          <button type="button" className="an-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        ) : null}
      </header>
      <p className="an-meta">
        {agent.harness}
        {tag ? ` · ${tag}` : ''}
        {agent.orch ? ' · orch' : ''}
        {agent.peers.length > 0 ? ` · 常找 ${agent.peers.length} 个` : ''}
      </p>
      {task ? (
        <p className="an-task">
          <em>任务</em>
          {task}
        </p>
      ) : null}
      <p className="an-reply">
        <em>{phase === 'thinking' ? '正在做' : '最新回复'}</em>
        {reply || (phase === 'thinking' ? (activity?.glance?.status ?? '…') : '还没有回复')}
      </p>
      {deliverables.length > 0 ? (
        <div className="an-chips">
          {deliverables.slice(0, 8).map((d) => (
            <button
              key={d.id}
              type="button"
              className={`an-chip an-${d.kind}`}
              onClick={() => onOpen(d.id)}
              title={d.name}
            >
              {d.name}
            </button>
          ))}
          {deliverables.length > 8 ? (
            <span className="an-more">+{deliverables.length - 8}</span>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="an-open" onClick={() => onOpen(agent.id)}>
        打开这张卡片 →
      </button>
    </aside>
  )
}
