// THE WORLD — the third view, beside Canvas and Board.
//
// Canvas is where the work sits, Board is the list of it, and this is the
// fleet seen from outside: a DOCK of every workspace, laid out in a fixed grid
// to be chosen from, and a FLIGHT into the one chosen, where the agents stand
// as towers with their notes and browsers around them on cables.
//
// Three rules carried over from the canvas views, because they were right:
//   - THE SCENE CARRIES STATE, THE GLASS CARRIES WORDS. Nothing is rendered as
//     3D text. Labels are upright HTML projected onto the canvas.
//   - QUIET BY DEFAULT. The camera never drifts: it stands over the dock until
//     you pick, flies, and stands again. The only thing that moves on its own
//     is a beacon over an agent that wants you, and with nobody waiting the
//     frame loop stops.
//   - THE THIRD AXIS CARRIES DATA. Island size is crew, tower height is turns
//     (fleet.ts). The dock's ORDER carries the rest: the workspace you are in
//     first, then by how recently each was touched.
//
// The flight is a container transform on a van Wijk path (dock.ts): the tile
// you chose grows into the place you are in while the others shrink into the
// floor, and the equipment grows out of the island on the last stretch.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import './world.css'
import type { Edge, Node } from '@xyflow/react'
import { cookrew } from '../api'
import type { BoardRow } from '../../../shared/board'
import type { WorkspaceMeta } from '../../../shared/model'
import {
  EMPTY_CARDS,
  equipmentOf,
  type WorkspaceCard,
  type WorkspaceCards
} from '../../../shared/workspace-cards'
import {
  PHASE_WORD,
  fleetTotals,
  mergeRows,
  readFleet,
  towerHeight,
  type WorldAgent,
  type WorldPlace
} from './fleet'
import { dockDistance, flightMs, planDock, zoomPath, type ZoomPath } from './dock'
import { buildEquipment, buildFleet, createWorld, project } from './scene'

export interface WorldViewProps {
  /** The ACTIVE workspace's cards — the fallback when the bridge cannot peek. */
  nodes: Node[]
  edges: Edge[]
  /** Open a real card on the canvas. */
  onPick: (nodeId: string) => void
  /** Switching is the user's call, so this is offered as a button, never run. */
  onEnterWorkspace: (workspaceId: string) => void
}

/** The active canvas's cards in the peek route's shape, for an older bridge. */
function cardsFromCanvas(id: string, nodes: readonly Node[], edges: readonly Edge[]): WorkspaceCards {
  const cards: WorkspaceCard[] = []
  for (const node of nodes) {
    const kind =
      node.type === 'terminal' || node.type === 'note' || node.type === 'browser' ? node.type : null
    if (kind === null) continue
    const raw = node.data as { node?: Record<string, unknown> } & Record<string, unknown>
    const data = raw.node ?? raw
    const custom = typeof data.customName === 'string' ? data.customName : null
    cards.push({
      id: node.id,
      kind,
      name: custom ?? (typeof data.name === 'string' ? data.name : node.id),
      x: node.position.x,
      y: node.position.y,
      w: node.measured?.width ?? 320,
      h: node.measured?.height ?? 220
    })
  }
  const here = new Set(cards.map((c) => c.id))
  return {
    id,
    cards,
    links: edges.filter((e) => here.has(e.source) && here.has(e.target)).map((e) => ({ a: e.source, b: e.target }))
  }
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}

/** A camera stance: where it looks, how far it stands, how steeply. */
interface Shot {
  focus: THREE.Vector3
  dist: number
  pitch: number
}
const FOV = 52
/** The dock is read like a map: steep, square to the grid. */
const DOCK_PITCH = 0.98
/** Inside a place the camera comes down to see the towers as towers. */
const PLACE_PITCH = 0.52

interface Flight {
  from: Shot
  to: Shot
  path: ZoomPath
  span: number
  start: number
  ms: number
  /** The place being entered, or null when returning to the dock. */
  target: string | null
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

type Mark =
  | { id: string; kind: 'place' | 'agent'; x: number; y: number; depth: number }
  | { id: string; kind: 'card'; card: 'note' | 'browser'; x: number; y: number; depth: number }

export function WorldView({ nodes, edges, onPick, onEnterWorkspace }: WorldViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rows, setRows] = useState<BoardRow[]>([])
  const [spaces, setSpaces] = useState<WorkspaceMeta[]>([])
  const [activeId, setActiveId] = useState('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [here, setHere] = useState<string | null>(null)
  const [who, setWho] = useState<string | null>(null)
  const [cards, setCards] = useState<WorkspaceCards>(EMPTY_CARDS)
  const [flying, setFlying] = useState<string | null | false>(false)
  const [labels, setLabels] = useState<Mark[]>([])

  /* ---------- the fleet, live ---------- */
  useEffect(() => {
    const api = cookrew()
    let alive = true
    void api
      .listWorkspaces?.()
      .then((list) => {
        if (!alive || !list) return
        setSpaces(list.workspaces)
        setActiveId(list.activeId)
      })
      .catch(() => undefined)
    // '7d' is the widest window the board offers, and the world wants every
    // place it can get. The push carries the DEFAULT window, so it is merged,
    // never swapped in (mergeRows).
    void api
      .listBoard?.('7d')
      .then((board) => {
        if (!alive || !board) return
        setRows((prev) => mergeRows(prev, board.rows))
        setActiveId(board.activeWorkspaceId)
      })
      .catch(() => undefined)
    const off = api.subscribeBoard?.((board) => {
      if (!alive) return
      setRows((prev) => mergeRows(prev, board.rows))
      setActiveId(board.activeWorkspaceId)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const aspect = size.h > 0 ? size.w / size.h : 1.6
  // The fleet's ORDER comes from the avenue (active first, then recency); its
  // PLACES come from the dock, a fixed grid shaped like the screen.
  const places = useMemo(() => {
    const ordered = readFleet(rows, spaces, activeId, Date.now())
    const plan = planDock(ordered, aspect)
    const at = new Map(plan.tiles.map((t) => [t.id, t.at]))
    return ordered.map((p) => ({ ...p, at: at.get(p.id) ?? p.at }))
  }, [rows, spaces, activeId, aspect])
  const plan = useMemo(() => planDock(places, aspect), [places, aspect])
  const totals = useMemo(() => fleetTotals(places), [places])
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places])
  const place = here === null ? null : (byId.get(here) ?? null)
  const agent: WorldAgent | null =
    who === null ? null : (places.flatMap((p) => p.agents).find((a) => a.id === who) ?? null)
  const agentPlace =
    who === null ? null : (places.find((p) => p.agents.some((a) => a.id === who)) ?? null)

  /* ---------- the cards of the place you are in ---------- */
  useEffect(() => {
    if (here === null) {
      setCards(EMPTY_CARDS)
      return
    }
    let alive = true
    const api = cookrew()
    const peek = api.workspaceCards
    if (peek) {
      void peek(here)
        .then((got) => {
          if (alive && got) setCards(got)
        })
        .catch(() => {
          if (alive && here === activeId) setCards(cardsFromCanvas(here, nodes, edges))
        })
    } else if (here === activeId) {
      setCards(cardsFromCanvas(here, nodes, edges))
    } else {
      setCards({ ...EMPTY_CARDS, id: here })
    }
    return () => {
      alive = false
    }
    // The active canvas's nodes change constantly; the cards are re-read on
    // entering, not on every drag of a card elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, activeId])
  const kit = useMemo(() => equipmentOf(cards), [cards])
  const loose = useMemo(() => {
    const owned = new Set([...kit.values()].flat().map((c) => c.id))
    return cards.cards.filter((c) => c.kind !== 'terminal' && !owned.has(c.id))
  }, [cards, kit])
  const cardById = useMemo(() => new Map(cards.cards.map((c) => [c.id, c])), [cards])

  /* ---------- the GPU side ---------- */
  const world = useRef<ReturnType<typeof createWorld> | null>(null)
  const fleet = useRef<ReturnType<typeof buildFleet> | null>(null)
  const gear = useRef<ReturnType<typeof buildEquipment> | null>(null)
  const shot = useRef<Shot>({ focus: new THREE.Vector3(0, 8, 0), dist: 600, pitch: DOCK_PITCH })
  const flight = useRef<Flight | null>(null)
  const frame = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    world.current = createWorld(canvas)
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect
      setSize({ w: Math.round(box.width), h: Math.round(box.height) })
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      gear.current?.dispose()
      fleet.current?.dispose()
      world.current?.dispose()
      world.current = null
      fleet.current = null
      gear.current = null
    }
  }, [])

  useEffect(() => {
    if (world.current && size.w > 0) world.current.resize(size.w, size.h)
  }, [size])

  const dockShot = useCallback((): Shot => {
    return {
      focus: new THREE.Vector3(0, 8, 0),
      dist: dockDistance(plan, aspect, FOV, DOCK_PITCH),
      pitch: DOCK_PITCH
    }
  }, [plan, aspect])
  const placeShot = useCallback((p: WorldPlace): Shot => {
    return {
      focus: new THREE.Vector3(p.at.x, p.at.y + 14, p.at.z),
      dist: p.radius * 2.4 + 70,
      pitch: PLACE_PITCH
    }
  }, [])

  // Rebuilt when the fleet's SHAPE changes, not on every board push.
  const shapeKey = places
    .map((p) => `${p.id}@${p.at.x.toFixed(0)},${p.at.z.toFixed(0)}:${p.agents.map((a) => `${a.id}:${a.phase}:${a.turnCount}`).join(',')}`)
    .join('|')
  useEffect(() => {
    const handles = world.current
    if (!handles || places.length === 0) return
    gear.current?.dispose()
    if (gear.current) handles.scene.remove(gear.current.group)
    gear.current = null
    fleet.current?.dispose()
    if (fleet.current) handles.scene.remove(fleet.current.group)
    const built = buildFleet(places)
    fleet.current = built
    handles.scene.add(built.group)
    // Standing in a place already: keep the other islands shrunk.
    if (here !== null && !flight.current) {
      for (const [id, island] of built.islandOf) if (id !== here) island.scale.setScalar(0.35)
    }
    if (flight.current === null) {
      const s = here === null ? dockShot() : placeShot(byId.get(here) ?? places[0])
      shot.current = s
    }
    kick()
    // shapeKey IS the read of `places` this effect depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey])

  // The equipment of the place you are in, built when its cards arrive.
  useEffect(() => {
    const handles = world.current
    const built = fleet.current
    if (!handles || !built) return
    gear.current?.dispose()
    if (gear.current) handles.scene.remove(gear.current.group)
    gear.current = null
    if (here === null || cards.id !== here) return
    const p = byId.get(here)
    if (!p) return
    const made = buildEquipment(p, built.towerAt, kit, loose)
    // Grown by the flight's last stretch, or already there when standing.
    made.group.scale.setScalar(flight.current ? 0.001 : 1)
    handles.scene.add(made.group)
    gear.current = made
    kick()
    // shapeKey too: a board push rebuilds the fleet (the effect above), and
    // the rebuild disposes the equipment, which must then be stood up again
    // or the island you are standing on empties while you look at it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, kit, loose, here, shapeKey])

  /* ---------- the frame loop, which stops when nothing moves ---------- */
  const still = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches)
  const tick = useCallback(
    (now: number) => {
      const handles = world.current
      if (!handles) return
      const built = fleet.current
      const f = flight.current
      let moving = false
      if (f) {
        const raw = Math.min(1, (now - f.start) / f.ms)
        const t = still.current ? 1 : smooth(raw)
        const { u, w } = f.path.at(t)
        const along = f.span > 0 ? u / f.span : t
        shot.current = {
          focus: f.from.focus.clone().lerp(f.to.focus, along),
          dist: w,
          pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * t
        }
        if (built) {
          // The container transform: the chosen tile keeps its size while
          // the rest sink to a third, or rise back when returning.
          const others = f.target === null ? 0.35 + 0.65 * t : 1 - 0.65 * t
          for (const [id, island] of built.islandOf) {
            island.scale.setScalar(id === f.target ? 1 : others)
          }
        }
        if (gear.current) {
          const grow = f.target === null ? Math.max(0.001, 1 - t / 0.35) : Math.max(0.001, (t - 0.6) / 0.4)
          gear.current.group.scale.setScalar(Math.min(1, grow))
        }
        moving = raw < 1
        if (!moving) {
          flight.current = null
          setFlying(false)
          if (f.target === null && gear.current) {
            handles.scene.remove(gear.current.group)
            gear.current.dispose()
            gear.current = null
          }
        }
      }
      const s = shot.current
      handles.camera.position.set(
        s.focus.x,
        s.focus.y + Math.sin(s.pitch) * s.dist,
        s.focus.z + Math.cos(s.pitch) * s.dist
      )
      handles.camera.lookAt(s.focus)
      built?.tick(now / 1000)
      handles.renderer.render(handles.scene, handles.camera)

      // THE GLASS follows the camera, so labels are recomputed with the frame.
      const marks: Mark[] = []
      const point = new THREE.Vector3()
      const shown = f?.target ?? here
      for (const p of places) {
        if (shown === null) {
          // Above the tallest tower, anchored at the island's far edge: the
          // back of a crowd projects highest, so a centre anchor lands inside
          // the forest.
          const crown = p.agents.reduce((t, ag) => Math.max(t, towerHeight(ag.turnCount)), 0)
          const dx = p.at.x - handles.camera.position.x
          const dz = p.at.z - handles.camera.position.z
          const away = Math.hypot(dx, dz) || 1
          point.set(p.at.x + (dx / away) * p.radius, p.at.y + 18 + crown, p.at.z + (dz / away) * p.radius)
          const at = project(point, handles.camera, size.w, size.h)
          if (at) marks.push({ id: p.id, kind: 'place', ...at })
        } else if (p.id === shown) {
          for (const ag of p.agents) {
            point.set(
              p.at.x + ag.at.x * (p.radius - 10),
              p.at.y + 12 + Math.log1p(ag.turnCount) * 9 + 10,
              p.at.z + ag.at.z * (p.radius - 10)
            )
            const at = project(point, handles.camera, size.w, size.h)
            if (at) marks.push({ id: ag.id, kind: 'agent', ...at })
          }
          if (gear.current) {
            for (const [cardId, c] of gear.current.cardAt) {
              const card = cardById.get(cardId)
              if (!card || card.kind === 'terminal') continue
              point.set(p.at.x + c.x, p.at.y + c.y, p.at.z + c.z)
              const at = project(point, handles.camera, size.w, size.h)
              if (at) marks.push({ id: cardId, kind: 'card', card: card.kind, ...at })
            }
          }
        }
      }
      // De-collide, nearest first, agents before cards: the name of a tower
      // matters more than the name of its tablet.
      const rank = { place: 0, agent: 0, card: 1 }
      marks.sort((p, q) => rank[p.kind] - rank[q.kind] || p.depth - q.depth)
      const kept: Mark[] = []
      const boxes: Array<[number, number, number, number]> = []
      for (const mark of marks) {
        const w = mark.kind === 'place' ? 150 : mark.kind === 'agent' ? 74 : 90
        const h = mark.kind === 'place' ? 36 : 18
        const box: [number, number, number, number] = [mark.x - w / 2, mark.y - h, mark.x + w / 2, mark.y]
        if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue
        boxes.push(box)
        kept.push(mark)
      }
      setLabels(kept)

      const pulsing = !still.current && totals.waiting > 0
      frame.current = moving || pulsing ? requestAnimationFrame(tick) : 0
    },
    [places, here, size.w, size.h, totals.waiting, cardById]
  )
  const kick = useCallback(() => {
    if (frame.current === 0) frame.current = requestAnimationFrame(tick)
  }, [tick])
  useEffect(() => {
    kick()
    return () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [kick])

  /* ---------- flying ---------- */
  const fly = useCallback(
    (to: Shot, target: string | null) => {
      const from = shot.current
      const span = from.focus.distanceTo(to.focus)
      const path = zoomPath(span, from.dist, to.dist)
      flight.current = {
        from,
        to,
        path,
        span,
        start: performance.now(),
        ms: still.current ? 1 : flightMs(path.S),
        target
      }
      setFlying(target)
      kick()
    },
    [kick]
  )
  const enter = useCallback(
    (id: string | null) => {
      const p = id === null ? null : (byId.get(id) ?? null)
      if (id !== null && !p) return
      setHere(id)
      setWho(null)
      fly(p === null ? dockShot() : placeShot(p), id)
    },
    [byId, dockShot, placeShot, fly]
  )

  // Esc is the way out: the panel first, then the place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (who !== null) setWho(null)
      else if (here !== null) enter(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [who, here, enter])

  /* ---------- pointer: wheel to close in, click to pick ---------- */
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (here === null || flight.current) return
      const s = shot.current
      shot.current = { ...s, dist: Math.max(60, Math.min(900, s.dist * (1 + e.deltaY * 0.0012))) }
      kick()
    },
    [here, kick]
  )
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const handles = world.current
      const built = fleet.current
      if (!handles || !built || flight.current) return
      const box = e.currentTarget.getBoundingClientRect()
      const ray = new THREE.Raycaster()
      ray.setFromCamera(
        new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1),
        handles.camera
      )
      const hit = ray.intersectObjects([...built.pickables, ...(gear.current?.pickables ?? [])], false)[0]
      if (!hit) {
        setWho(null)
        return
      }
      const cardId = gear.current?.cardOf.get(hit.object.id)
      if (cardId !== undefined) {
        if (here === activeId) onPick(cardId)
        else {
          const owner = [...kit.entries()].find(([, items]) => items.some((c) => c.id === cardId))?.[0]
          if (owner) setWho(owner)
        }
        return
      }
      const agentId = built.agentOf.get(hit.object.id)
      const placeId = built.placeOf.get(hit.object.id)
      if (agentId !== undefined) {
        if (here !== placeId && placeId !== undefined) enter(placeId)
        setWho(agentId)
        return
      }
      if (placeId !== undefined && here === null) enter(placeId)
    },
    [enter, here, activeId, onPick, kit]
  )

  /* ---------- the one interrupt ---------- */
  const nextWaiting = useCallback(() => {
    const queue = places.flatMap((p) => p.agents.filter((a) => a.phase === 'waiting').map((a) => ({ p, a })))
    if (queue.length === 0) return
    const at = queue.findIndex((q) => q.a.id === who)
    const next = queue[(at + 1) % queue.length]
    if (here !== next.p.id) enter(next.p.id)
    setWho(next.a.id)
  }, [places, who, here, enter])

  const agentKit = agent === null ? [] : (kit.get(agent.id) ?? [])
  const inActive = agentPlace?.id === activeId

  return (
    <div className={`cr-world${flying !== false ? ' flying' : ''}`} ref={hostRef}>
      <canvas ref={canvasRef} className="cr-world-gl" onWheel={onWheel} onClick={onClick} style={{ cursor: 'default' }} />

      {/* THE GLASS — every word in this view, upright. */}
      <div className="cr-world-glass" aria-hidden="true">
        {labels.map((mark) => {
          if (mark.kind === 'place') {
            const p = byId.get(mark.id)
            if (!p) return null
            const chosen = flying === p.id
            return (
              <div
                key={mark.id}
                className={`cr-world-tag${p.active ? ' active' : ''}${p.waiting > 0 ? ' waiting' : ''}${chosen ? ' chosen' : ''}`}
                style={{ left: `${mark.x}px`, top: `${mark.y}px` }}
                onClick={() => enter(p.id)}
              >
                <b>
                  {p.icon} {p.name}
                </b>
                <span>
                  {p.agents.length} agents
                  {p.waiting > 0 ? ` · ${p.waiting} 在等你` : ''}
                  {p.lastActivityAt > 0 ? ` · ${ago(Date.now() - p.lastActivityAt)}` : ' · 空'}
                </span>
              </div>
            )
          }
          if (mark.kind === 'card') {
            const card = cardById.get(mark.id)
            if (!card) return null
            return (
              <div key={mark.id} className={`cr-world-card ${mark.card}`} style={{ left: `${mark.x}px`, top: `${mark.y}px` }}>
                {card.name}
              </div>
            )
          }
          const found = place?.agents.find((a) => a.id === mark.id)
          if (!found) return null
          return (
            <div
              key={mark.id}
              className={`cr-world-pin st-${found.phase}${who === found.id ? ' on' : ''}`}
              style={{ left: `${mark.x}px`, top: `${mark.y}px` }}
            >
              {found.name}
            </div>
          )
        })}
      </div>

      <header className="cr-world-hud">
        <b>{here === null ? '全部工作区' : (place?.name ?? '')}</b>
        <span>
          {here === null
            ? `${totals.places} 个工作区 · ${totals.agents} agents · ${totals.working} 在干活`
            : `${place?.agents.length ?? 0} agents · ${cards.cards.filter((c) => c.kind === 'note').length} 便签 · ${cards.cards.filter((c) => c.kind === 'browser').length} 浏览器`}
        </span>
        {here !== null ? (
          <button type="button" onClick={() => enter(null)}>
            ← 回到全部<kbd>esc</kbd>
          </button>
        ) : null}
      </header>

      {totals.waiting > 0 ? (
        <button type="button" className="cr-world-hitl" onClick={nextWaiting}>
          <i />
          {totals.waiting} 个 agent 在等你
          <u>飞过去 →</u>
        </button>
      ) : null}

      {agent !== null ? (
        <aside className={`cr-world-panel st-${agent.phase}`}>
          <header>
            <b>{agent.name}</b>
            <span>{PHASE_WORD[agent.phase]}</span>
            <button type="button" onClick={() => setWho(null)} aria-label="Close">
              ✕
            </button>
          </header>
          <p className="meta">
            {agent.harness}
            {agent.orch ? ' · orch' : ''} · {agent.turnCount} 回合 · {ago(Date.now() - agent.lastActivityAt)}
          </p>
          {agent.title ? <p className="task">{agent.title}</p> : null}
          <p className="kit-head">
            装备 · {agentKit.filter((k) => k.kind === 'note').length} 便签 ·{' '}
            {agentKit.filter((k) => k.kind === 'browser').length} 浏览器
          </p>
          <div className="kit">
            {agentKit.slice(0, 10).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${item.kind}`}
                title={item.name}
                onClick={() => (inActive ? onPick(item.id) : agentPlace && onEnterWorkspace(agentPlace.id))}
              >
                {item.name}
              </button>
            ))}
            {agentKit.length > 10 ? <span className="more">+{agentKit.length - 10}</span> : null}
          </div>
          {inActive ? (
            <button type="button" className="go" onClick={() => onPick(agent.id)}>
              在画布上打开 →
            </button>
          ) : (
            <>
              <p className="note">
                这个 agent 在「{agentPlace?.name}」。打开它的卡片要切过去——切换会停掉当前工作区的终端，所以这一步由你决定。
              </p>
              <button type="button" className="go" onClick={() => agentPlace && onEnterWorkspace(agentPlace.id)}>
                切到「{agentPlace?.name}」→
              </button>
            </>
          )}
        </aside>
      ) : null}

      <p className="cr-world-hint">
        {here === null ? '点一个工作区进入 · 点塔看 agent' : '滚轮进退 · 点塔看 agent · 点卡片打开 · esc 返回'}
      </p>
    </div>
  )
}
