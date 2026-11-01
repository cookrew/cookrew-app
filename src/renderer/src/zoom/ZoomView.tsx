import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceList, WorkspaceState } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { cookrew } from '../api'
import type { Crew } from '../stage/crew-rows'
import { thumbWants } from '../pets/thumb-wants'
import { Counts, AgentNode, ItemNode, LinkNode, MachineNode, MarkNode, type Bind } from './ZoomParts'
import { InkRing, InkTie } from './InkAvatar'
import { buildZoomModel } from './zoom-model'
import { deviceOf, machinesAt, MACHINE_CARD } from './zoom-layout'
import { deviceWords, SWS, type FrameEls } from './zoom-frame'
import { useZoom, zoomStore } from './zoom-store'
import { useZoomMotion } from './use-zoom-motion'
import { BAR_NAMES, BAR_STOPS, barStop, RANGE, stepOut } from './zoom-path'
import { useZoomFleetView } from './use-zoom-fleet'
import './zoom.css'

/**
 * The real navigator, from devices through workspaces and crew to the real
 * full views underneath. React owns the live data and the elements, the
 * frame engine owns their transforms. No second terminal/browser is made
 * for the animation: the full view behind the shell is the real one.
 */
export function ZoomView({ workspace, workspaceId, attachIndex, crew, onDelete, children }: {
  workspace: WorkspaceState | null
  workspaceId: string | null
  attachIndex: AttachmentIndex
  /** The crew, read once in App (stage/crew-rows.ts · useCrew): the agent group draws the same. */
  crew: Crew
  /** Asked to remove a card: the app's own confirm dialog answers (App: requestClose). */
  onDelete?: (id: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const overview = useRef<HTMLDivElement>(null)
  const registry = useRef(new Map<string, HTMLElement>())
  /**
   * One handler per node for its whole life, which runs the closure of the
   * latest render: the memoised nodes (ZoomParts · sameProps) keep their
   * handler, and a click still does what this render says.
   */
  const runs = useRef(new Map<string, () => void>())
  const trampolines = useRef(new Map<string, () => void>())
  const stable = (key: string, run: () => void): (() => void) => {
    runs.current.set(key, run)
    let fn = trampolines.current.get(key)
    if (!fn) {
      fn = () => runs.current.get(key)?.()
      trampolines.current.set(key, fn)
    }
    return fn
  }
  /** Bumped when an element joins or leaves the registry: collect's cache key. */
  const registryVersion = useRef(0)
  /** Bumped when a web font finishes loading: the measured widths change. */
  const fontsVersion = useRef(0)
  const collected = useRef<{ model: unknown; registry: number; fonts: number; els: FrameEls } | null>(null)
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const bind = useCallback<Bind>((key) => {
    let fn = refs.current.get(key)
    if (!fn) {
      fn = (el) => {
        if (el) {
          if (registry.current.get(key) === el) return
          registry.current.set(key, el)
        } else if (!registry.current.delete(key)) return
        registryVersion.current += 1
      }
      refs.current.set(key, fn)
    }
    return fn
  }, [])
  const zoom = useZoom()
  const rows = crew.all
  // Only what the view draws of the fleet (use-zoom-fleet.ts · useZoomFleetView).
  const fleet = useZoomFleetView()
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
    nodes: workspace?.nodes ?? [], connections: workspace?.connections ?? [], rows, crew: crew.crew, attachIndex,
    workspaces: fleetWorkspaces.length ? fleetWorkspaces.map((w) => ({ id: w.id, name: w.name, dir: '', dirs: [], icon: w.icon ?? '🗂' })) : (list?.workspaces ?? []), activeId: workspaceId ?? list?.activeId ?? 'local', name: workspace?.name ?? 'Workspace',
    machines: fleet.machines
  }), [workspace?.nodes, workspace?.connections, workspace?.name, workspaceId, rows, crew.crew, attachIndex, list, fleetWorkspaces, fleet.machines])
  const modelRef = useRef(model)
  modelRef.current = model
  /**
   * The painter's elements and their measured widths. Asked for on every
   * animation frame; built again only when the model, the registered elements
   * or the loaded fonts changed (it read three offsetWidths per agent and
   * rebuilt five maps every frame: 158 ms in 12 s of zooming, profiled).
   */
  const collect = useCallback((): FrameEls | null => {
    const last = collected.current
    if (last && last.model === modelRef.current && last.registry === registryVersion.current && last.fonts === fontsVersion.current) return last.els
    const els = collectNow()
    collected.current = els ? { model: modelRef.current, registry: registryVersion.current, fonts: fontsVersion.current, els } : null
    return els
  }, [])
  const collectNow = useCallback((): FrameEls | null => {
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
      // The card's own parts exist for the open card only (cardIds): absent is not missing.
      const body = get(`agent-body:${a.id}`)
      const reply = get(`agent-reply:${a.id}`)
      const card = get(`agent-card:${a.id}`)
      const cardl = get(`agent-cardl:${a.id}`)
      if (!node || !av || !nm || !st || !cnt || !card || !cardl) continue
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
    return { devices: get('devices')!, device: get('device')!, scene: get('scene')!, panel: get('panel')!, wash: get('wash')!, ring: get('ring')!, label: get('label')!, labelW: get('label')!.offsetWidth, labelH: get('label')!.offsetHeight, newCap: get('newCap')!, machine: get('machine')!, agents, links, items, ties, marks, next: get('newseat') }
  }, [])
  // THE CREW SCROLLS ON A PHONE (zoom-frame.ts · phoneCamera): the crew is
  // drawn at a readable size, so a tall one scrolls (by a drag) instead of shrinking.
  const panAt = useRef(0)
  const panMax = useRef(0)
  const pan = useMemo(() => ({
    get: () => panAt.current,
    setMax: (max: number) => {
      panMax.current = max
      if (panAt.current > max) panAt.current = max
    }
  }), [])
  const motion = useZoomMotion(model.frame, collect, root, pan)
  // The crew and the thumbnails scroll apart: a side opened again starts at its top.
  useEffect(() => {
    panAt.current = 0
  }, [zoom.dir])
  /** The crew stop, or the thumbnails, on a narrow screen with more than fits: where a drag scrolls (no wheel: owner, 2026-10-31). */
  const canPan = (): boolean => {
    const z = zoomStore.get()
    return panMax.current > 0 && (z.dir === 'agents' ? z.v > 0.9 && z.v < 1.5 : z.v > -0.5 && z.v < 0.5)
  }
  const scrollBy = (dy: number): void => {
    panAt.current = Math.min(panMax.current, Math.max(0, panAt.current + dy))
    motion.wake()
  }
  const drag = useRef<{ y: number; pan: number; on: boolean } | null>(null)
  const panned = useRef(false)
  // A web font that lands later changes every measured width: measure again.
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts?.addEventListener) return
    const onFonts = (): void => {
      fontsVersion.current += 1
      motion.wake()
    }
    fonts.addEventListener('loadingdone', onFonts)
    return () => fonts.removeEventListener('loadingdone', onFonts)
  }, [motion.wake])
  // ONE CARD INSTANCE (owner, 2026-10-31): the card's body, strip and reply are
  // drawn for the open card only, and for the one it is leaving while that
  // fades, never once per agent behind the crew.
  const focusId = zoom.agent ?? model.agents[0]?.id ?? null
  const [prevFocus, setPrevFocus] = useState<string | null>(null)
  const lastFocus = useRef(focusId)
  useEffect(() => {
    if (lastFocus.current === focusId) return
    setPrevFocus(lastFocus.current)
    lastFocus.current = focusId
  }, [focusId])
  const cardIds = useMemo(() => new Set([focusId, prevFocus].filter((id): id is string => id !== null)), [focusId, prevFocus])
  const cardKey = [...cardIds].join(' ')
  useLayoutEffect(() => { motion.wake() }, [model, size, cardKey, motion.wake])
  // THE VIEW IS NEVER SCROLLED (zoom.css · .zv-overview): the painter draws
  // from its (0, 0). Where `overflow: clip` is not known, a scroll that
  // happens anyway is put back at once.
  useEffect(() => {
    const boxes = [root.current, overview.current].filter((el): el is HTMLDivElement => el !== null)
    const pin = (e: Event): void => {
      const el = e.currentTarget as HTMLElement
      if (el.scrollLeft !== 0) el.scrollLeft = 0
      if (el.scrollTop !== 0) el.scrollTop = 0
    }
    for (const el of boxes) el.addEventListener('scroll', pin, { passive: true })
    return () => { for (const el of boxes) el.removeEventListener('scroll', pin) }
  }, [])
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
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm')) return
      e.preventDefault()
      stepBack()
    }
    // Capture, so a card that stops Escape on its way up does not keep us zoomed.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stepBack])
  // A press that turned into a pinch or a drag is not the click that steps out.
  const moved = useRef(false)
  const swallowClick = useRef(false)
  useEffect(() => {
    thumbWants.claim('zoom', model.items.filter((i) => i.kind === 'browser').slice(0, 12).map((i) => i.id))
    return () => thumbWants.release('zoom')
  }, [model.items])
  const agentOf = useMemo(() => new Map(model.agents.map((a) => [a.id, a])), [model.agents])
  // The grid's items and the coins' others: a coin's face is drawn either way.
  const itemOf = useMemo(() => new Map([...model.items, ...model.coinItems].map((i) => [i.id, i])), [model.items, model.coinItems])
  const device = useMemo(() => deviceOf(model.frame.workspaces, size.w < 760), [model.frame.workspaces, size.w])
  const activeSlot = device.at[model.frame.active] ?? { x: 0, y: 0 }
  // The device stop's words grow to be read at the size the device is seen (zoom-frame.ts · deviceWords).
  const words = useMemo(() => deviceWords(device, size.w, size.h, size.w < 760), [device, size])
  // Static placement on the device: the real active workspace is rendered by the scene layer.
  useLayoutEffect(() => {
    for (const m of model.marks) {
      const el = registry.current.get(`mark:${m.id}`)
      const at = device.at[m.id]
      if (el && at) el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${SWS})`
      const label = el?.querySelector<HTMLElement>('.zv-mark-label')
      if (label) {
        label.style.transform = `translateX(-50%) scale(${words.markK.toFixed(4)})`
        label.style.maxWidth = `${Math.round(words.markMax)}px`
      }
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
  }, [device, words, model.marks, model.machines])
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
  const stops = BAR_STOPS[zoom.dir]
  const names = BAR_NAMES[zoom.dir]
  const selectedStop = barStop(zoom.dir, zoom.v)
  // The slider spans the bar's stops; a card or a full view sits at its end.
  const barMax = stops[stops.length - 1]
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
      <div className="zv-overview" ref={overview}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          moved.current = false
          panned.current = false
          drag.current = pointers.current.size === 1 && canPan() ? { y: e.clientY, pan: panAt.current, on: false } : null
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
          const d = drag.current
          if (d && pointers.current.size === 1) {
            if (!d.on && Math.abs(e.clientY - d.y) > 6) d.on = true
            if (d.on) {
              panned.current = true
              scrollBy(d.pan + (d.y - e.clientY) - panAt.current)
            }
          }
          const p = pinch.current
          if (p && pointers.current.size === 2 && p.distance > 0) motion.go(p.v + Math.log2(distance() / p.distance) * 1.1)
        }}
        onPointerUp={(e) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; drag.current = null }}
        // A drag that scrolled the crew is not a click on the face it ended on.
        onClickCapture={(e) => {
          if (!panned.current) return
          panned.current = false
          e.stopPropagation()
          e.preventDefault()
        }}
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
            <span className="zv-machine-label"><b>{machine}</b><small>{model.frame.workspaces.length} workspaces · {model.deviceAgents} agents</small></span>
          </button>
        </div>
        <div className="zv-device" ref={bind('device')}>
          <div className="zv-device-label" style={{ transform: `translate(${-device.box.w / 2 + 50}px, ${device.titleBottom}px) scale(${words.titleK.toFixed(4)}) translateY(-100%)`, maxWidth: Math.round(words.titleMax) }}>
            <b>{machine}</b><span>{model.frame.workspaces.length} workspaces</span><small>agents open the crew · browsers open thumbnails</small>
          </div>
          {model.marks.map((m) => <MarkNode key={m.id} mark={m} bind={bind} onOpen={stable(`mark:${m.id}`, () => void switchWorkspace(m.id))} />)}
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
            return a && i ? <LinkNode key={l.key} k={l.key} agent={a} item={i} shared={i.owners.length} bind={bind} onClick={stable(`link:${l.key}`, () => (zoomStore.get().dir === 'items' ? motion.agent(a.id) : motion.item(i.id)))} /> : null
          })}
          {model.items.map((i) => <ItemNode key={i.id} item={i} names={i.owners.map((id) => agentOf.get(id)?.name ?? id)} bind={bind} onClick={stable(`item:${i.id}`, () => motion.item(i.id))} onDelete={onDelete ? stable(`item-del:${i.id}`, () => onDelete(i.id)) : undefined} />)}
          {model.agents.map((a) => <AgentNode key={a.id} agent={a} card={cardIds.has(a.id)} bind={bind} onOpen={stable(`agent:${a.id}`, () => motion.agent(a.id))} onDelete={onDelete ? stable(`agent-del:${a.id}`, () => onDelete(a.id)) : undefined} />)}
          {model.agents.filter((a) => a.phase === 'waiting').map((a) => <span key={a.id} className="zv-dot" ref={bind(`agent-dot:${a.id}`)} />)}
          <div className="zv-grp" ref={bind('label')}>
            <button type="button" className="zv-seal" onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} crew`}>{model.agents.length}</button>
            <button type="button" className="zv-workspace-name" onClick={() => motion.go(1, 'agents')}>{model.name}</button>
            <button type="button" className="zv-tot" onClick={() => motion.go(0, 'items')} aria-label={`Open ${model.name} artifacts`} title={model.hiddenItems ? `${model.hiddenItems} more not drawn in the grid` : undefined}><Counts browsers={model.browsers} notes={model.notes} none="no items" /></button>
          </div>
          <div className="zv-newcap" ref={bind('newCap')}>{newest ? <>newest · {newest.title}</> : null}</div>
          {model.agents.length === 0 && <div className="zv-empty">No agents here yet. Add an agent from the dock.</div>}
        </div>
        <div className="zv-panel" ref={bind('panel')} />
      </div>
      <nav className="zv-controls" aria-label="Semantic zoom">
        <button type="button" className="zv-back" onClick={stepBack} aria-label="Zoom out">‹</button>
        <div className="zv-zoom-control">
          <input aria-label="Zoom level" type="range" min={RANGE[zoom.dir][0]} max={barMax} step={0.01} value={Math.min(zoom.v, barMax)} onChange={(e) => motion.go(Number(e.target.value))} />
          <div className="zv-stops">{stops.map((v, i) => <button key={v} type="button" aria-current={selectedStop === v ? 'step' : undefined} onClick={() => motion.go(v)}>{names[i]}</button>)}</div>
        </div>
        <span className="zv-location">{zoom.dir === 'agents' ? 'agents' : 'artifacts'}</span>
      </nav>
      {error && <div role="alert" className="zv-error">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    </div>
  )
}
