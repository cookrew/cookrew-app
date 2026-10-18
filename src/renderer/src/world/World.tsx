// THE WORLD — the third view, beside Canvas and Board.
//
// Canvas is where the work sits, Board is the list of it, and this is the
// fleet seen from outside: every workspace an island floating in an avenue
// that recedes into fog, every agent a tower on its island, and a shaft of
// light over anyone waiting on a person.
//
// Three rules carried over from the canvas views, because they were right:
//   - THE SCENE CARRIES STATE, THE GLASS CARRIES WORDS. Nothing is rendered as
//     3D text. Labels are upright HTML projected onto the canvas.
//   - QUIET BY DEFAULT. The only thing that moves is a beacon over an agent
//     that wants you, and when nobody is waiting the frame loop stops.
//   - THE THIRD AXIS CARRIES DATA. Distance is dormancy, island size is crew,
//     tower height is turns (fleet.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import './world.css'
import type { Edge, Node } from '@xyflow/react'
import { cookrew } from '../api'
import type { BoardRow } from '../../../shared/board'
import type { WorkspaceMeta } from '../../../shared/model'
import {
  PHASE_WORD,
  fleetTotals,
  readFleet,
  towerHeight,
  type WorldAgent,
  type WorldPlace
} from './fleet'
import { buildFleet, createWorld, project } from './scene'

export interface WorldViewProps {
  /** The ACTIVE workspace's cards — the only ones whose equipment is known. */
  nodes: Node[]
  edges: Edge[]
  /** Open a real card on the canvas. */
  onPick: (nodeId: string) => void
  /** Switching is the user's call, so this is offered as a button, never run. */
  onEnterWorkspace: (workspaceId: string) => void
}

interface Kit {
  id: string
  kind: 'note' | 'browser'
  name: string
}

/** Agent → the notes and browsers wired to it, for the active workspace. */
function readEquipment(nodes: readonly Node[], edges: readonly Edge[]): Map<string, Kit[]> {
  const kinds = new Map<string, 'terminal' | 'note' | 'browser'>()
  const named = new Map<string, string>()
  for (const node of nodes) {
    const kind =
      node.type === 'terminal' || node.type === 'note' || node.type === 'browser' ? node.type : null
    if (kind === null) continue
    kinds.set(node.id, kind)
    const raw = node.data as { node?: Record<string, unknown> } & Record<string, unknown>
    const data = raw.node ?? raw
    const custom = typeof data.customName === 'string' ? data.customName : null
    named.set(node.id, custom ?? (typeof data.name === 'string' ? data.name : node.id))
  }
  const out = new Map<string, Kit[]>()
  const taken = new Set<string>()
  for (const edge of edges) {
    const a = kinds.get(edge.source)
    const b = kinds.get(edge.target)
    if (a === undefined || b === undefined) continue
    const pair =
      a === 'terminal' && b !== 'terminal'
        ? ([edge.source, edge.target] as const)
        : b === 'terminal' && a !== 'terminal'
          ? ([edge.target, edge.source] as const)
          : null
    if (pair === null || taken.has(pair[1])) continue
    taken.add(pair[1])
    const kit: Kit = {
      id: pair[1],
      kind: kinds.get(pair[1]) === 'note' ? 'note' : 'browser',
      name: named.get(pair[1]) ?? pair[1]
    }
    const list = out.get(pair[0])
    if (list) list.push(kit)
    else out.set(pair[0], [kit])
  }
  return out
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}

/** The camera's two destinations and the damping between them. */
interface Shot {
  focus: THREE.Vector3
  dist: number
  yaw: number
  pitch: number
}
const WORLD_SHOT: Shot = {
  focus: new THREE.Vector3(0, 0, -260),
  dist: 620,
  yaw: 0,
  pitch: 0.34
}

export function WorldView({
  nodes,
  edges,
  onPick,
  onEnterWorkspace
}: WorldViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rows, setRows] = useState<BoardRow[]>([])
  const [spaces, setSpaces] = useState<WorkspaceMeta[]>([])
  const [activeId, setActiveId] = useState('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [here, setHere] = useState<string | null>(null)
  const [who, setWho] = useState<string | null>(null)
  const [labels, setLabels] = useState<Array<{ id: string; kind: 'place' | 'agent'; x: number; y: number; depth: number }>>([])

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
    void api
      .listBoard?.()
      .then((board) => {
        if (!alive || !board) return
        setRows(board.rows)
        setActiveId(board.activeWorkspaceId)
      })
      .catch(() => undefined)
    // A board that stays open pushes on every change; without it the world is
    // simply the snapshot it opened with, which is honest and still useful.
    const off = api.subscribeBoard?.((board) => {
      if (!alive) return
      setRows(board.rows)
      setActiveId(board.activeWorkspaceId)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const places = useMemo(
    () => readFleet(rows, spaces, activeId, Date.now()),
    [rows, spaces, activeId]
  )
  const equipment = useMemo(() => readEquipment(nodes, edges), [nodes, edges])
  const totals = useMemo(() => fleetTotals(places), [places])
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places])
  const place = here === null ? null : (byId.get(here) ?? null)
  const agent: WorldAgent | null =
    who === null ? null : (places.flatMap((p) => p.agents).find((a) => a.id === who) ?? null)
  const agentPlace =
    who === null ? null : (places.find((p) => p.agents.some((a) => a.id === who)) ?? null)

  /* ---------- the GPU side ---------- */
  const world = useRef<ReturnType<typeof createWorld> | null>(null)
  const fleet = useRef<ReturnType<typeof buildFleet> | null>(null)
  const shot = useRef<Shot>({ ...WORLD_SHOT, focus: WORLD_SHOT.focus.clone() })
  const aim = useRef<Shot>({ ...WORLD_SHOT, focus: WORLD_SHOT.focus.clone() })
  const frame = useRef(0)
  const clock = useRef(0)

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
      fleet.current?.dispose()
      world.current?.dispose()
      world.current = null
      fleet.current = null
    }
  }, [])

  useEffect(() => {
    if (world.current && size.w > 0) world.current.resize(size.w, size.h)
  }, [size])

  // Rebuilt when the fleet's SHAPE changes, not on every board push: a row's
  // clock ticking must not drop and re-add a hundred meshes.
  const shapeKey = places
    .map((p) => `${p.id}:${p.agents.map((a) => `${a.id}:${a.phase}:${a.turnCount}`).join(',')}`)
    .join('|')
  useEffect(() => {
    const handles = world.current
    if (!handles || places.length === 0) return
    fleet.current?.dispose()
    if (fleet.current) handles.scene.remove(fleet.current.group)
    const built = buildFleet(places)
    fleet.current = built
    handles.scene.add(built.group)
    kick()
    // shapeKey IS the read of `places` this effect depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey])

  /* ---------- the frame loop, which stops when nothing moves ---------- */
  const still = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches)
  const settled = useRef(false)
  const tick = useCallback(
    (now: number) => {
      const handles = world.current
      if (!handles) return
      const dt = clock.current === 0 ? 1 / 60 : Math.min((now - clock.current) / 1000, 1 / 20)
      clock.current = now
      const s = shot.current
      const a = aim.current
      const k = still.current ? 1 : 1 - Math.exp(-dt / 0.22)
      s.focus.lerp(a.focus, k)
      s.dist += (a.dist - s.dist) * k
      s.yaw += (a.yaw - s.yaw) * k
      s.pitch += (a.pitch - s.pitch) * k
      const near =
        s.focus.distanceToSquared(a.focus) < 0.4 &&
        Math.abs(s.dist - a.dist) < 0.5 &&
        Math.abs(s.yaw - a.yaw) < 0.002 &&
        Math.abs(s.pitch - a.pitch) < 0.002
      handles.camera.position.set(
        s.focus.x + Math.sin(s.yaw) * Math.cos(s.pitch) * s.dist,
        s.focus.y + Math.sin(s.pitch) * s.dist,
        s.focus.z + Math.cos(s.yaw) * Math.cos(s.pitch) * s.dist
      )
      handles.camera.lookAt(s.focus)
      fleet.current?.tick(now / 1000)
      handles.renderer.render(handles.scene, handles.camera)

      // The glass follows the camera, so labels are recomputed with the frame.
      const marks: Array<{ id: string; kind: 'place' | 'agent'; x: number; y: number; depth: number }> = []
      const point = new THREE.Vector3()
      for (const p of places) {
        if (here !== null && p.id !== here) continue
        if (here === null) {
          // Above the TALLEST tower, not a fixed height: on a busy island the
          // name was buried in its own crew. And anchored at the island's FAR
          // edge rather than its centre — the back of a crowd projects highest
          // on screen, so a centre anchor still lands inside the forest. The
          // edge is taken from the camera's own direction, so it stays the far
          // one however the view is orbited.
          const crown = p.agents.reduce((t, ag) => Math.max(t, towerHeight(ag.turnCount)), 0)
          const dx = p.at.x - handles.camera.position.x
          const dz = p.at.z - handles.camera.position.z
          const away = Math.hypot(dx, dz) || 1
          point.set(
            p.at.x + (dx / away) * p.radius,
            p.at.y + 26 + crown,
            p.at.z + (dz / away) * p.radius
          )
          const at = project(point, handles.camera, size.w, size.h)
          if (at) marks.push({ id: p.id, kind: 'place', ...at })
        } else {
          for (const ag of p.agents) {
            point.set(
              p.at.x + ag.at.x * (p.radius - 10),
              p.at.y + 12 + Math.log1p(ag.turnCount) * 9 + 10,
              p.at.z + ag.at.z * (p.radius - 10)
            )
            const at = project(point, handles.camera, size.w, size.h)
            if (at) marks.push({ id: ag.id, kind: 'agent', ...at })
          }
        }
      }
      // DE-COLLIDE. Thirty-three names over one island, or ten workspace tags
      // at the far end of the avenue, land on top of each other and the view
      // becomes unreadable exactly where it is densest. Nearest wins: a label
      // is dropped when its box overlaps one already placed, which is the
      // same rule a map label engine uses and cheap at this count.
      marks.sort((p, q) => p.depth - q.depth)
      const kept: typeof marks = []
      const boxes: Array<[number, number, number, number]> = []
      for (const mark of marks) {
        const w = mark.kind === 'place' ? 150 : 74
        const h = mark.kind === 'place' ? 36 : 20
        const box: [number, number, number, number] = [
          mark.x - w / 2,
          mark.y - h,
          mark.x + w / 2,
          mark.y
        ]
        const clash = boxes.some(
          (o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]
        )
        if (clash) continue
        boxes.push(box)
        kept.push(mark)
      }
      setLabels(kept)

      // Keep rendering while the camera is moving or a beacon is pulsing.
      const pulsing = !still.current && totals.waiting > 0
      settled.current = near && !pulsing
      frame.current = settled.current ? 0 : requestAnimationFrame(tick)
    },
    [places, here, size.w, size.h, totals.waiting]
  )
  const kick = useCallback(() => {
    if (frame.current === 0) {
      clock.current = 0
      frame.current = requestAnimationFrame(tick)
    }
  }, [tick])
  useEffect(() => {
    kick()
    return () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [kick])

  /* ---------- flying ---------- */
  const flyTo = useCallback((target: WorldPlace | null) => {
    const a = aim.current
    if (target === null) {
      a.focus.copy(WORLD_SHOT.focus)
      a.dist = WORLD_SHOT.dist
      a.yaw = WORLD_SHOT.yaw
      a.pitch = WORLD_SHOT.pitch
    } else {
      a.focus.set(target.at.x, target.at.y + 22, target.at.z)
      a.dist = target.radius * 2.5 + 48
      a.yaw = 0.45
      a.pitch = 0.5
    }
  }, [])
  const enter = useCallback(
    (id: string | null) => {
      setHere(id)
      setWho(null)
      flyTo(id === null ? null : (byId.get(id) ?? null))
      kick()
    },
    [byId, flyTo, kick]
  )

  /* ---------- pointer: drag to look, wheel to close in, click to pick ---------- */
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; moved: number } | null>(null)
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, yaw: aim.current.yaw, pitch: aim.current.pitch, moved: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current
      if (d === null) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      d.moved = Math.max(d.moved, Math.hypot(dx, dy))
      aim.current.yaw = d.yaw - dx * 0.005
      aim.current.pitch = Math.max(0.06, Math.min(1.2, d.pitch + dy * 0.004))
      kick()
    },
    [kick]
  )
  const endDrag = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* the pointer had already gone */
    }
    setTimeout(() => {
      drag.current = null
    }, 0)
  }, [])
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      aim.current.dist = Math.max(90, Math.min(1800, aim.current.dist * (1 + e.deltaY * 0.0012)))
      kick()
    },
    [kick]
  )
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if ((drag.current?.moved ?? 0) > 5) return
      const handles = world.current
      const built = fleet.current
      if (!handles || !built) return
      const box = e.currentTarget.getBoundingClientRect()
      const ray = new THREE.Raycaster()
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - box.left) / box.width) * 2 - 1,
          -((e.clientY - box.top) / box.height) * 2 + 1
        ),
        handles.camera
      )
      const hit = ray.intersectObjects(built.pickables, false)[0]
      if (!hit) {
        setWho(null)
        return
      }
      const agentId = built.agentOf.get(hit.object.id)
      const placeId = built.placeOf.get(hit.object.id)
      if (agentId !== undefined) {
        if (here !== placeId && placeId !== undefined) enter(placeId)
        setWho(agentId)
        return
      }
      if (placeId !== undefined) enter(placeId)
    },
    [enter, here]
  )

  /* ---------- the one interrupt ---------- */
  const nextWaiting = useCallback(() => {
    const queue = places.flatMap((p) => p.agents.filter((a) => a.phase === 'waiting').map((a) => ({ p, a })))
    if (queue.length === 0) return
    const at = queue.findIndex((q) => q.a.id === who)
    const next = queue[(at + 1) % queue.length]
    enter(next.p.id)
    setWho(next.a.id)
  }, [places, who, enter])

  const kit = agent === null ? [] : (equipment.get(agent.id) ?? [])
  const inActive = agentPlace?.active === true

  return (
    <div className="cr-world" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="cr-world-gl"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onClick={onClick}
      />

      {/* THE GLASS — every word in this view, upright. */}
      <div className="cr-world-glass" aria-hidden="true">
        {labels.map((mark) => {
          if (mark.kind === 'place') {
            const p = byId.get(mark.id)
            if (!p) return null
            // Fade with distance like everything else: a far island's name is
            // as dim as the island, which is the point of the fog.
            const dim = Math.max(0.15, 1 - mark.depth * 1.08)
            return (
              <div
                key={mark.id}
                className={`cr-world-tag${p.active ? ' active' : ''}${p.waiting > 0 ? ' waiting' : ''}`}
                style={{ left: `${mark.x}px`, top: `${mark.y}px`, opacity: dim }}
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
          {totals.places} 个工作区 · {totals.agents} agents · {totals.working} 在干活
        </span>
        {here !== null ? (
          <button type="button" onClick={() => enter(null)}>
            ← 回到世界
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
            {agent.orch ? ' · orch' : ''} · {agent.turnCount} 回合 ·{' '}
            {ago(Date.now() - agent.lastActivityAt)}
          </p>
          {agent.title ? <p className="task">{agent.title}</p> : null}
          {inActive ? (
            <>
              <p className="kit-head">
                装备 · {kit.filter((k) => k.kind === 'note').length} 便签 ·{' '}
                {kit.filter((k) => k.kind === 'browser').length} 浏览器
              </p>
              <div className="kit">
                {kit.slice(0, 10).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`chip ${item.kind}`}
                    title={item.name}
                    onClick={() => onPick(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
                {kit.length > 10 ? <span className="more">+{kit.length - 10}</span> : null}
              </div>
              <button type="button" className="go" onClick={() => onPick(agent.id)}>
                在画布上打开 →
              </button>
            </>
          ) : (
            <>
              <p className="note">
                这个 agent 在「{agentPlace?.name}」。装备要切过去才看得到——切换会停掉当前工作区的终端，所以这一步由你决定。
              </p>
              <button
                type="button"
                className="go"
                onClick={() => agentPlace && onEnterWorkspace(agentPlace.id)}
              >
                切到「{agentPlace?.name}」→
              </button>
            </>
          )}
        </aside>
      ) : null}

      <p className="cr-world-hint">
        拖动环视 · 滚轮进退 · 点岛进入 · 点塔看 agent
      </p>
    </div>
  )
}
