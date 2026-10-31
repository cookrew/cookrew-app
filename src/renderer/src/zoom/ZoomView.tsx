import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceList, WorkspaceState } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { cookrew } from '../api'
import { useCrewRows } from '../stage/crew-rows'
import { thumbWants } from '../pets/thumb-wants'
import { Counts, AgentNode, ItemNode, LinkNode, MachineNode, MarkNode, type Bind } from './ZoomParts'
import { InkRing, InkTie } from './InkAvatar'
import { buildZoomModel } from './zoom-model'
import { deviceOf, machinesAt, MACHINE_CARD } from './zoom-layout'
import { SWS, type FrameEls } from './zoom-frame'
import { useZoom, zoomStore } from './zoom-store'
import { useZoomMotion } from './use-zoom-motion'
import { nearestStop, RANGE, STOPS, STOP_NAMES, stepOut } from './zoom-path'
import { useZoomFleet } from './use-zoom-fleet'
import './zoom.css'

/**
 * The real navigator, from devices through workspaces and crew to the real
 * full views underneath. React owns the live data and the elements, the
 * frame engine owns their transforms. No second terminal/browser is made
 * for the animation: the full view behind the shell is the real one.
 */
export function ZoomView({ workspace, workspaceId, attachIndex, children }: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  attachIndex: AttachmentIndex
  children: React.ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const registry = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const bind = useCallback<Bind>((key) => {
    let fn = refs.current.get(key)
    if (!fn) {
      fn = (el) => {
        if (el) registry.current.set(key, el)
        else registry.current.delete(key)
      }
      refs.current.set(key, fn)
    }
    return fn
  }, [])
  const zoom = useZoom()
  const { live, quiet } = useCrewRows(workspace)
  const rows = useMemo(() => [...live, ...quiet], [live, quiet])
  const fleet = useZoomFleet()
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [nameAsked, setNameAsked] = useState<string | null>(null)
  const localMachine = fleet.machines.find((m) => m.local)
  const fleetWorkspaces = localMachine?.workspaces ?? []
  // The fleet's name is the one the phone can know: remote-api has no machineName().
  const machine = (nameAsked ?? localMachine?.name ?? 'This desktop').replace(/\.local$/i, '')
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  useEffect(() => {
    let alive = true
    void cookrew().listWorkspaces().then((l) => alive && setList(l)).catch((e) => alive && setError(`Cannot read workspaces: ${String(e)}`))
    const off = cookrew().onWorkspaceList((l) => setList(l))
    void cookrew().machineName?.().then((s) => alive && s && setNameAsked(s.replace(/\.local$/i, ''))).catch(() => undefined)
    return () => { alive = false; off() }
  }, [])
  useLayoutEffect(() => {
    if (!root.current) return
    const update = (): void => {
      const el = root.current
      if (el) setSize((old) => old.w === el.clientWidth && old.h === el.clientHeight ? old : { w: el.clientWidth, h: el.clientHeight })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(root.current)
    return () => ro.disconnect()
  }, [])
  const model = useMemo(() => buildZoomModel({
    nodes: workspace?.nodes ?? [], connections: workspace?.connections ?? [], rows, attachIndex,
    workspaces: fleetWorkspaces.length ? fleetWorkspaces.map((w) => ({ id: w.id, name: w.name, dir: '', dirs: [], icon: w.icon ?? '🗂' })) : (list?.workspaces ?? []), activeId: workspaceId ?? list?.activeId ?? 'local', name: workspace?.name ?? 'Workspace',
    machines: fleet.machines.map((m) => ({ id: m.id, name: m.name, local: m.local, online: m.online, detail: m.detail, workspaces: m.workspaces.map((w) => ({ id: w.id, name: w.name, agents: w.agents.map((a) => ({ harness: a.harness, phase: a.phase })), counts: w.counts })) }))
  }), [workspace?.nodes, workspace?.connections, workspace?.name, workspaceId, rows, attachIndex, list, fleetWorkspaces, fleet.machines])
  const modelRef = useRef(model)
  modelRef.current = model
  const collect = useCallback((): FrameEls | null => {
    const all = registry.current
    const get = (k: string): HTMLElement | null => all.get(k) ?? null
    const base = ['devices', 'device', 'scene', 'panel', 'wash', 'ring', 'label', 'newCap', 'machine'] as const
    if (base.some((k) => !get(k))) return null
    const agents: FrameEls['agents'] = new Map()
    const links: FrameEls['links'] = new Map()
    const items: FrameEls['items'] = new Map()
    const ties: FrameEls['ties'] = new Map()
    const marks: FrameEls['marks'] = new Map()
    for (const a of modelRef.current.agents) {
      const node = get(`agent:${a.id}`)
      const av = get(`agent-av:${a.id}`)
      const nm = get(`agent-nm:${a.id}`)
      const st = get(`agent-st:${a.id}`)
      const cnt = get(`agent-cnt:${a.id}`)
      const body = get(`agent-body:${a.id}`)
      const reply = get(`agent-reply:${a.id}`)
      const card = get(`agent-card:${a.id}`)
      const cardl = get(`agent-cardl:${a.id}`)
      if (!node || !av || !nm || !st || !cnt || !body || !reply || !card || !cardl) continue
      agents.set(a.id, { node, av, nm, st, cnt, body, reply, card, cardl, emp: get(`agent-emp:${a.id}`), dot: get(`agent-dot:${a.id}`), nmW: nm.offsetWidth, stW: st.offsetWidth, cntW: cnt.offsetWidth })
    }
    for (const l of modelRef.current.frame.links) {
      const node = get(`link:${l.key}`), th = get(`link-th:${l.key}`), coin = get(`link-coin:${l.key}`)
      if (node && th && coin) links.set(l.key, { node, th, coin, badge: get(`link-badge:${l.key}`) })
    }
    for (const i of modelRef.current.items) {
      const node = get(`item:${i.id}`), ttl = get(`item-ttl:${i.id}`)
      if (node && ttl) items.set(i.id, { node, ttl })
    }
    for (const t of modelRef.current.frame.ties) { const el = get(`tie:${t.key}`); if (el) ties.set(t.key, el) }
    for (const m of modelRef.current.marks) { const el = get(`mark:${m.id}`); if (el) marks.set(m.id, el) }
    return { devices: get('devices')!, device: get('device')!, scene: get('scene')!, panel: get('panel')!, wash: get('wash')!, ring: get('ring')!, label: get('label')!, labelW: get('label')!.offsetWidth, newCap: get('newCap')!, machine: get('machine')!, agents, links, items, ties, marks }
  }, [])
  const motion = useZoomMotion(model.frame, collect, root)
  useLayoutEffect(() => { motion.wake() }, [model, size, motion.wake])
  // NO WHEEL ZOOM (owner, 2026-10-31): the wheel is the page's, and in a list it
  // scrolls that list. Zoom in and out are clicks (motion.agent / motion.item for
  // in, the background and the back button for out), plus the stops and Esc.
  const stepBack = useCallback(() => {
    const z = zoomStore.get()
    const next = stepOut(z.dir, z.v)
    if (next !== z.v) motion.go(next, z.dir)
  }, [motion.go])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if ((e.target as Element | null)?.closest('input, textarea, [contenteditable="true"], .xterm')) return
      e.preventDefault()
      stepBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepBack])
  // A press that turned into a pinch or a drag is not the click that steps out.
  const moved = useRef(false)
  const swallowClick = useRef(false)
  useEffect(() => {
    thumbWants.claim('zoom', model.items.filter((i) => i.kind === 'browser').slice(0, 12).map((i) => i.id))
    return () => thumbWants.release('zoom')
  }, [model.items])
  const agentOf = useMemo(() => new Map(model.agents.map((a) => [a.id, a])), [model.agents])
  const itemOf = useMemo(() => new Map(model.items.map((i) => [i.id, i])), [model.items])
  const device = useMemo(() => deviceOf(model.frame.workspaces, size.w < 760), [model.frame.workspaces, size.w])
  const activeSlot = device.at[model.frame.active] ?? { x: 0, y: 0 }
  // Static placement on the device: the real active workspace is rendered by the scene layer.
  useLayoutEffect(() => {
    for (const m of model.marks) {
      const el = registry.current.get(`mark:${m.id}`)
      const at = device.at[m.id]
      if (el && at) el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${SWS})`
    }
    const machineEl = registry.current.get('machine')
    if (machineEl) {
      const sw = device.box.w * 0.5, sh = device.box.h * 0.5
      machineEl.style.width = `${sw + 28}px`
      machineEl.style.height = `${sh + 28}px`
      machineEl.style.transform = `translate(${-sw / 2 - 14}px, ${-sh / 2 - 14}px)`
    }
    // The account's other machines: rows under this Mac's screen, inside the devices camera.
    const others = model.machines.filter((m) => !m.local)
    const places = machinesAt(others.length, device.box, device.box.w < 700)
    others.forEach((m, i) => {
      const el = registry.current.get(`machinecard:${m.id}`)
      const at = places.at[i]
      if (el && at) el.style.transform = `translate(${at.x - MACHINE_CARD.w / 2}px, ${at.y - MACHINE_CARD.h / 2}px)`
    })
  }, [device, model.marks, model.machines])
  const switchWorkspace = useCallback(async (id: string) => {
    setError(null)
    try {
      await cookrew().switchWorkspace(id)
      zoomStore.focusAgent(null)
      zoomStore.focusItem(null)
      zoomStore.go(1, 'agents')
    } catch (e) { setError(`Cannot open workspace: ${String(e)}`) }
  }, [])
  const newest = model.items.find((i) => model.frame.links.some((l) => l.key === model.frame.newest && l.item === i.id))
  const stops = STOPS[zoom.dir]
  const names = STOP_NAMES[zoom.dir]
  const selectedStop = nearestStop(zoom.dir, zoom.v)
  // Pinch only changes the scene; the full terminal keeps its own native scroll.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; v: number } | null>(null)
  const distance = (): number => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  return (
    <div className="zv-root" ref={root} data-testid="zoom-navigator">
      <div className="zv-full" aria-hidden={!zoom.full}>
        {/* Its own boundary: the real full view is a lazy chunk, and waiting for it must never blank the navigator. */}
        <Suspense fallback={null}>{zoom.full ? children : null}</Suspense>
      </div>
      <div className="zv-overview"
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          moved.current = false
          if (pointers.current.size === 2) {
            pinch.current = { distance: distance(), v: zoomStore.get().v }
            moved.current = true
          }
        }}
        onPointerMove={(e) => {
          const at = pointers.current.get(e.pointerId)
          if (!at) return
          if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 6) moved.current = true
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const p = pinch.current
          if (p && pointers.current.size === 2 && p.distance > 0) motion.go(p.v + Math.log2(distance() / p.distance) * 1.1)
        }}
        onPointerUp={(e) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null }}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); pinch.current = null; moved.current = true }}
        onClick={(e) => {
          // Nothing was pressed, or the press was a pinch or a drag: not a step out.
          if (swallowClick.current) { swallowClick.current = false; return }
          if (moved.current || pinch.current !== null) return
          // A node, a card, a button, a field: its own click, which zooms in.
          if ((e.target as Element).closest('button, input, textarea, form, a, [role="button"], .zv-m, .zv-card, .zv-ip, .zv-lk, .zv-mark, .zv-machine, .zv-machinecard, .zv-workspace-hit')) return
          stepBack()
        }}>
        <div className="zv-devices" ref={bind('devices')}>
          {model.machines.filter((m) => !m.local).map((m) => (
            <MachineNode key={m.id} machine={m} bind={bind} onOpen={() => setError(`${m.name} is listed, not readable from here: open it on that Mac.`)} />
          ))}
          <button type="button" className="zv-machine" ref={bind('machine') as React.Ref<HTMLButtonElement>} onClick={() => motion.go(-1)} aria-label={`Open ${machine}`}>
            <span className="zv-machine-deck" />
            <span className="zv-machine-label"><b>{machine}</b><small>{model.frame.workspaces.length} workspaces · {rows.length} agents</small></span>
          </button>
        </div>
        <div className="zv-device" ref={bind('device')}>
          <div className="zv-device-label" style={{ transform: `translate(${-device.box.w / 2 + 50}px, ${device.labelY}px)` }}>
            <b>{machine}</b><span>{model.frame.workspaces.length} workspaces</span><small>agents open the crew · browsers open thumbnails</small>
          </div>
          {model.marks.map((m) => <MarkNode key={m.id} mark={m} bind={bind} onOpen={() => void switchWorkspace(m.id)} />)}
          <button className="zv-workspace-hit" type="button" style={{ transform: `translate(${activeSlot.x - 90}px, ${activeSlot.y - 90}px)` }} onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} agents`} />
        </div>
        <div className="zv-scene" ref={bind('scene')}>
          <div className="zv-wash" ref={bind('wash')} />
          <div className="zv-ring" ref={bind('ring')}><InkRing /></div>
          {model.frame.ties.map((t) => <div key={t.key} className="zv-tie" ref={bind(`tie:${t.key}`)}><InkTie /></div>)}
          {model.agents.map((a) => (
            <div key={a.id} className="zv-cardl" ref={bind(`agent-cardl:${a.id}`)}>
              <div className="zv-card" ref={bind(`agent-card:${a.id}`)} role="presentation" onClick={() => motion.agent(a.id)} />
            </div>
          ))}
          {model.frame.links.map((l) => {
            const a = agentOf.get(l.agent), i = itemOf.get(l.item)
            return a && i ? <LinkNode key={l.key} k={l.key} agent={a} item={i} shared={i.owners.length} bind={bind} onClick={() => zoomStore.get().dir === 'items' ? motion.agent(a.id) : motion.item(i.id)} /> : null
          })}
          {model.items.map((i) => <ItemNode key={i.id} item={i} names={i.owners.map((id) => agentOf.get(id)?.name ?? id)} bind={bind} onClick={() => motion.item(i.id)} />)}
          {model.agents.map((a) => <AgentNode key={a.id} agent={a} bind={bind} onOpen={() => motion.agent(a.id)} />)}
          {model.agents.filter((a) => a.phase === 'waiting').map((a) => <span key={a.id} className="zv-dot" ref={bind(`agent-dot:${a.id}`)} />)}
          <div className="zv-grp" ref={bind('label')}>
            <button type="button" className="zv-seal" onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} crew`}>{model.agents.length}</button>
            <button type="button" className="zv-workspace-name" onClick={() => motion.go(1, 'agents')}>{model.name}</button>
            <button type="button" className="zv-tot" onClick={() => motion.go(0, 'items')} aria-label={`Open ${model.name} browsers and notes`} title={model.hiddenItems ? `${model.hiddenItems} more not drawn in the grid` : undefined}><Counts browsers={model.browsers} notes={model.notes} none="no items" /></button>
          </div>
          <div className="zv-newcap" ref={bind('newCap')}>{newest ? <>newest · {newest.title}</> : null}</div>
          {model.agents.length === 0 && <div className="zv-empty">No agents here yet. Add an agent from the dock.</div>}
        </div>
        <div className="zv-panel" ref={bind('panel')} />
      </div>
      <nav className="zv-controls" aria-label="Semantic zoom">
        <button type="button" className="zv-back" onClick={() => { const i = stops.indexOf(selectedStop); motion.go(stops[Math.max(0, i - 1)]) }} aria-label="Zoom out">‹</button>
        <div className="zv-zoom-control">
          <input aria-label="Zoom level" type="range" min={RANGE[zoom.dir][0]} max={RANGE[zoom.dir][1]} step={0.01} value={zoom.v} onChange={(e) => motion.go(Number(e.target.value))} />
          <div className="zv-stops">{stops.map((v, i) => <button key={v} type="button" aria-current={selectedStop === v ? 'step' : undefined} onClick={() => motion.go(v)}>{names[i]}</button>)}</div>
        </div>
        <span className="zv-location">{zoom.dir === 'agents' ? 'agents' : 'browsers & notes'}</span>
      </nav>
      {error && <div role="alert" className="zv-error">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    </div>
  )
}
