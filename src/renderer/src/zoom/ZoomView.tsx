import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceList, WorkspaceState } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { cookrew } from '../api'
import type { Crew } from '../stage/crew-rows'
import { thumbWants } from '../pets/thumb-wants'
import { Counts, AgentNode, ItemNode, LinkNode, MachineNode, MarkNode, type Bind, NewestThumb } from './ZoomParts'
import { followDrafts } from '../prompt/draft-follow'
import { InkRing, InkTie } from './InkAvatar'
import { buildZoomModel, itemViewOf } from './zoom-model'
import { ShelfCard } from './ShelfCard'
import { draftKey, getDraft } from '../prompt/prompt-draft'
import { defaultCrewCols, defaultDeviceCols, deviceOf, machinesAt, MACHINE_CARD, shelfPage } from './zoom-layout'
import { useCrewCols, usePerRow } from './crew-cols'
import { PerRowPill } from './PerRowPill'
import { deviceWords, layoutOf, SWS, thumbsCamera, wordsOf, type FrameEls } from './zoom-frame'
import { useZoom, zoomStore } from './zoom-store'
import { useZoomMotion } from './use-zoom-motion'
import { BAR_NAMES, BAR_SIDES, BAR_STOPS, barSide, barStop, stepOut } from './zoom-path'
import { setFaceSlot } from '../prompt/face-slot'
import { CrIcon } from '../icons'
import { promptFold } from '../prompt/prompt-fold'
import { useZoomFleetView } from './use-zoom-fleet'
import './zoom.css'
// The full view's head, for the crisp ghost the way in arrives at (zv-fv-ghost).
import './full-views.css'

/** Mounted hidden: the painter shows it (zoom-frame.ts · put). */
const CHIP_HIDDEN: React.CSSProperties = { opacity: 0 }

/** Rows of thumbnails mounted past each edge of the view, so a scroll shows them already drawn. */
const ROW_BUFFER = 2

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
    machines: fleet.machines,
    counts: new Map(fleetWorkspaces.flatMap((w) => (w.counts ? [[w.id, { browsers: w.counts.browsers, notes: w.counts.notes }] as const] : []))),
    newest: new Map(fleetWorkspaces.flatMap((w) => (w.newest ? [[w.id, w.newest] as const] : [])))
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
      agents.set(a.id, { node, av, nm, st, cnt, dft: get(`agent-dft:${a.id}`), body, reply, card, cardl, emp: get(`agent-emp:${a.id}`), dot: get(`agent-dot:${a.id}`), nmW: nm.offsetWidth, stW: st.offsetWidth, cntW: cnt.offsetWidth, nmH: nm.offsetHeight, stH: st.offsetHeight })
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
    return { devices: get('devices')!, device: get('device')!, scene: get('scene')!, panel: get('panel')!, wash: get('wash')!, ring: get('ring')!, label: get('label')!, labelW: get('label')!.offsetWidth, labelH: get('label')!.offsetHeight, newCap: get('newCap')!, machine: get('machine')!, agents, links, items, ties, marks, next: get('newseat'), fullHead: get('fullHead'), newThumb: get('newThumb'), shelfMore: get('shelfMore'), ...deviceWordEls(get('deviceLabel'), [...marks.values()], get('devices')!) }
  }, [])
  // THE CREW SCROLLS ON A PHONE (zoom-frame.ts · phoneCamera), THE THUMBNAILS
  // ON ANY SCREEN (deskThumbs, phoneThumbs): drawn at a readable size, a tall
  // one scrolls (a drag, the wheel) instead of shrinking. The shelf over the
  // thumbnails is the agents' group: one row, a page at a time (shelfPage).
  const panAt = useRef(0)
  const panMax = useRef(0)
  const [shelfAt, setShelfAt] = useState(0)
  const shelfRef = useRef(0)
  shelfRef.current = shelfAt
  const pan = useMemo(() => ({
    get: () => panAt.current,
    shelf: () => shelfRef.current,
    setMax: (max: number) => {
      panMax.current = max
      if (panAt.current > max) panAt.current = max
    }
  }), [])
  // Agents and workspaces per row, as the owner picked them on this device (crew-cols.ts).
  const narrow = size.w < 760
  const [crewCols, setCrewCols] = useCrewCols(narrow)
  const [deviceCols, setDeviceCols] = usePerRow('device', narrow)
  const frame = useMemo(
    () => (crewCols === null && deviceCols === null ? model.frame : { ...model.frame, crewCols: crewCols ?? undefined, deviceCols: deviceCols ?? undefined }),
    [model.frame, crewCols, deviceCols]
  )
  const motion = useZoomMotion(frame, collect, root, pan)
  const layout = useMemo(() => layoutOf(frame, narrow), [frame, narrow])
  // THE PHONE'S WORDS (scene-words.ts): each stop's scale at rest, for the words seen at
  // one stop only (phone-type.css), and the names' width; a new width is measured again.
  const sceneVars = useMemo(() => wordsOf(layout, size.w, size.h, narrow).vars, [layout, narrow, size])
  const varsSet = useRef<string[]>([])
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    for (const k of varsSet.current) if (!(k in sceneVars)) el.style.removeProperty(k)
    for (const [k, v] of Object.entries(sceneVars)) el.style.setProperty(k, v)
    varsSet.current = Object.keys(sceneVars)
    fontsVersion.current += 1
    motion.wake()
  }, [sceneVars, motion.wake])
  // The crew shows each agent's unsent words: keep them in step with its line (draft-follow.ts).
  useEffect(() => followDrafts(), [])
  // ONLY THE ROWS ON SCREEN ARE MOUNTED (owner, 2026-11-02: every artifact,
  // scrolled up and down). A workspace holds hundreds of them, and each
  // thumbnail rides a layer of its own (zoom-frame.ts · put: tile memory):
  // the rows in view, ROW_BUFFER more each way, mounted before they show.
  const [firstRow, setFirstRow] = useState(0)
  const firstRowAt = (p: number): number => {
    const cam = thumbsCamera(layout, size.w, size.h, narrow, p)
    return Math.max(0, Math.floor(-cam.Oy / cam.S / layout.thumbs.rowH))
  }
  const rowsSeen = Math.ceil(size.h / (layout.thumbs.rowH * thumbsCamera(layout, size.w, size.h, narrow, 0).S)) + 1
  const { shownItems, seenBrowsers } = useMemo(() => {
    const rowOf = (id: string): number => Math.round((layout.thumbs.at[id]?.y ?? -1e9) / layout.thumbs.rowH)
    const shown = model.items.filter((i) => rowOf(i.id) >= firstRow - ROW_BUFFER && rowOf(i.id) <= firstRow + rowsSeen + ROW_BUFFER)
    // The pictures wanted: the browsers in view in the grid's order, then a row past each edge (thumb-wants.ts caps them).
    const inRows = (lo: number, hi: number): string[] => layout.thumbs.order.filter((id) => rowOf(id) >= lo && rowOf(id) <= hi)
    const seen = [...inRows(firstRow, firstRow + rowsSeen), ...inRows(firstRow + rowsSeen + 1, firstRow + rowsSeen + 1), ...inRows(firstRow - 1, firstRow - 1)]
    const browsers = new Set(model.items.filter((i) => i.kind === 'browser').map((i) => i.id))
    return { shownItems: shown, seenBrowsers: seen.filter((id) => browsers.has(id)).join(' ') }
  }, [model.items, layout, firstRow, rowsSeen])
  /** The scroll that shows an item's thumbnail: the current one when it is on screen, else one that puts it mid-screen. */
  const panToItem = (id: string): number => {
    const at = layout.thumbs.at[id]
    if (!at) return 0
    const now = thumbsCamera(layout, size.w, size.h, narrow, panAt.current)
    const y = now.Oy + at.y * now.S
    if (y > 0 && y < size.h) return panAt.current
    const cam = thumbsCamera(layout, size.w, size.h, narrow, 0)
    return Math.min(cam.panMax, Math.max(0, cam.Oy + at.y * cam.S - size.h / 2))
  }
  /** An item's full view stands over its own row: stepping out lands on the item it came from, not at the grid's top. */
  const scrollToFullItem = (): boolean => {
    const s = zoomStore.get()
    if (s.dir !== 'items' || s.v <= 0.5 || !s.item) return false
    panAt.current = panToItem(s.item)
    setFirstRow(firstRowAt(panAt.current))
    return true
  }
  // The crew and the thumbnails scroll apart: a side opened again starts at its top.
  useEffect(() => {
    setShelfAt(0)
    if (scrollToFullItem()) return
    panAt.current = 0
    setFirstRow(0)
  }, [zoom.dir]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scrollToFullItem()
  }, [zoom.item]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new size or grid keeps the scroll the painter clamps: the rows in view follow it
  // (on the agents' side the scroll is the crew's, and the grid waits at its top).
  useEffect(() => {
    setFirstRow(zoomStore.get().dir === 'items' ? firstRowAt(panAt.current) : 0)
  }, [layout, size, narrow]) // eslint-disable-line react-hooks/exhaustive-deps
  /** The crew stop on a narrow screen, or the thumbnails, with more than fits: where a drag or the wheel scrolls. */
  const canPan = (): boolean => {
    const z = zoomStore.get()
    return panMax.current > 0 && (z.dir === 'agents' ? z.v > 0.9 && z.v < 1.5 : z.v > -0.5 && z.v < 0.5)
  }
  const scrollBy = (dy: number): void => {
    // The card stood by a face the scroll moves away: it goes, unless it holds a draft.
    if (!shelfCardDraft()) closeShelfCard()
    panAt.current = Math.min(panMax.current, Math.max(0, panAt.current + dy))
    if (zoomStore.get().dir === 'items') setFirstRow(firstRowAt(panAt.current))
    motion.wake()
  }
  // The shelf's page: its "+N" chip turns it, "–" on the last goes back to the first.
  const shelf = shelfPage(layout.thumbs.shelf, shelfAt)
  const turnShelf = (): void => {
    if (!shelfCardDraft()) closeShelfCard()
    const next = shelf.more?.last ? 0 : shelfAt + 1
    shelfRef.current = next
    setShelfAt(next)
    motion.wake()
  }
  // AN AGENT TAPPED OVER THE ARTIFACTS opens its card on this page (owner,
  // 2026-11-03; ShelfCard.tsx), the artifacts still under it: a face on the
  // shelf or a coin under a thumbnail. The same agent again, or the card's
  // face, is its full view. Anywhere else an agent's tap zooms as it did.
  const [shelfCard, setShelfCard] = useState<{ id: string; anchor: string } | null>(null)
  const shelfCardOpen = useRef(false)
  shelfCardOpen.current = shelfCard !== null
  const closeShelfCard = useCallback((): void => setShelfCard(null), [])
  /** The open card's agent has words in its box (prompt-draft.ts: typed in the card or before). */
  const shelfCardDraft = (): boolean => shelfCard !== null && getDraft(draftKey(shelfCard.id)).trim() !== ''
  const atShelf = (): boolean => {
    const z = zoomStore.get()
    return z.dir === 'items' && z.full === null && Math.abs(z.v) < 0.5
  }
  const tapAgent = (id: string, anchor: string): void => {
    if (!atShelf()) return motion.agent(id)
    if (shelfCard?.id === id) {
      closeShelfCard()
      return zoomStore.jumpTo('agent', id)
    }
    setShelfCard({ id, anchor })
  }
  // A press outside on the artifacts only closes the card (ShelfCard eats its click); the bar and the header keep theirs.
  const pressedOutside = useCallback((target: EventTarget | null): boolean => target instanceof Node && (overview.current?.contains(target) ?? false), [])
  useEffect(() => {
    const onShelf = zoom.dir === 'items' && zoom.full === null && Math.abs(zoom.v) < 0.5
    if (!onShelf || (shelfCard && !model.agents.some((a) => a.id === shelfCard.id))) closeShelfCard()
  }, [zoom.dir, zoom.v, zoom.full, model.agents, shelfCard, closeShelfCard])
  // THE WHEEL SCROLLS, IT NEVER ZOOMS (owner, 2026-10-31: the wheel is the
  // page's, and a list's). Up and down it scrolls the thumbnails (or a narrow
  // screen's crew), wherever the pointer is; a sideways one is the page's.
  const onWheel = useRef<(e: WheelEvent) => void>(() => undefined)
  onWheel.current = (e) => {
    if (e.ctrlKey) return
    if ((e.target as Element | null)?.closest?.('textarea, input, select, [role="dialog"]')) return
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1
    const dx = e.deltaX * k
    const dy = e.deltaY * k
    if (Math.abs(dx) > Math.abs(dy)) return
    if (canPan()) {
      scrollBy(dy)
      e.preventDefault()
    }
  }
  useEffect(() => {
    const el = overview.current
    if (!el) return
    const wheel = (e: WheelEvent): void => onWheel.current(e)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  /** A press that may become a scroll, up and down: a move mostly sideways is still a click. */
  const drag = useRef<{ x: number; y: number; pan: number; scrolling: boolean } | null>(null)
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
  useLayoutEffect(() => { motion.wake() }, [model, frame, size, cardKey, shownItems, motion.wake])
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
      // An agent's card over the artifacts closes first, from its reply box too;
      // an IME's Escape and the overlays over it (⌘K, the board) keep theirs.
      // A name's field (NameEdit.tsx) owns its Escape: it cancels the rename, not the card;
      // the who-picker's field (WhoPicker.tsx) closes the picker first.
      if (shelfCardOpen.current && !e.isComposing && !(e.target as Element | null)?.closest?.('.cmd, .cr-board-search, .cr-board-pop, .cr-name-input, .pf-who')) {
        e.preventDefault()
        closeShelfCard()
        return
      }
      // The board's box and its panel own their Esc (BoardSearch.tsx).
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm, .cr-board-search, .cr-board-pop')) return
      // The box's own buttons and picker keep their Esc while the box can fold
      // or its picker is open; in an agent's full view it steps out as before.
      if ((e.target as Element | null)?.closest?.('.cr-prompt') && (promptFold.get().foldable || document.querySelector('.pf-who'))) return
      e.preventDefault()
      // An open prompt box folds first; the view stays (prompt/prompt-fold.ts).
      if (promptFold.foldFirst()) return
      stepBack()
    }
    // Capture, so a card that stops Escape on its way up does not keep us zoomed.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stepBack, closeShelfCard])
  // A press that turned into a pinch or a drag is not the click that steps out.
  const moved = useRef(false)
  const swallowClick = useRef(false)
  useEffect(() => {
    thumbWants.claim('zoom', seenBrowsers ? seenBrowsers.split(' ') : [])
    return () => thumbWants.release('zoom')
  }, [seenBrowsers])
  const agentOf = useMemo(() => new Map(model.agents.map((a) => [a.id, a])), [model.agents])
  // One names list per item, so a row scrolled into view does not draw every mounted thumbnail again (ItemNode is memo'd).
  const namesOf = useMemo(() => new Map(model.items.map((i) => [i.id, i.owners.map((id) => agentOf.get(id)?.name ?? id)])), [model.items, agentOf])
  // The grid's items and the coins' others: a coin's face is drawn either way.
  const itemOf = useMemo(() => new Map([...model.items, ...model.coinItems].map((i) => [i.id, i])), [model.items, model.coinItems])
  const device = useMemo(() => deviceOf(model.frame.workspaces, narrow, model.frame.screenAspect, deviceCols ?? undefined), [model.frame.workspaces, model.frame.screenAspect, narrow, deviceCols])
  const activeSlot = device.at[model.frame.active] ?? { x: 0, y: 0 }
  // The device stop's words grow to be read at the size the device is seen (zoom-frame.ts · deviceWords).
  const words = useMemo(() => deviceWords(device, size.w, size.h, size.w < 760), [device, size])
  // Static placement on the device: the real active workspace is rendered by the scene layer.
  useLayoutEffect(() => {
    for (const m of model.marks) {
      const el = registry.current.get(`mark:${m.id}`)
      const at = device.at[m.id]
      if (el && at) el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${SWS})`
      const label = el?.querySelector<HTMLElement & { _t?: string; _o?: number }>('.zv-mark-label')
      if (label) {
        // A phone's painter draws it at one size on every frame (zoom-frame.ts · paintDeviceWords); a desk's is set once here.
        if (!narrow) {
          label.style.transform = `translateX(-50%) scale(${words.markK.toFixed(4)})`
          label.style.opacity = ''
          label.style.visibility = ''
          label._t = undefined
          label._o = undefined
        }
        label.style.maxWidth = `${Math.round(words.markMax)}px`
      }
    }
    // A phone's open label grows no wider than its neighbours' (deviceWords · openMax), so it is cut, never drawn smaller.
    const openLabel = registry.current.get('label')
    if (openLabel) {
      openLabel.style.maxWidth = Number.isFinite(words.openMax) ? `${Math.floor(Math.min(130, words.openMax))}px` : ''
      fontsVersion.current += 1
    }
    const machineEl = registry.current.get('machine')
    if (machineEl) {
      // The screen at the display's proportions (zoom-layout.ts · screenOf), the device view centred in it.
      const sw = device.screen.w * 0.5, sh = device.screen.h * 0.5
      machineEl.style.width = `${sw + 28}px`
      machineEl.style.height = `${sh + 28}px`
      machineEl.style.transform = `translate(${-sw / 2 - 14}px, ${-sh / 2 - 14}px)`
    }
    // The account's other machines: rows under this Mac's screen, inside the devices camera.
    const others = model.machines.filter((m) => !m.local)
    const places = machinesAt(others.length, device.screen, device.box.w < 700)
    others.forEach((m, i) => {
      const el = registry.current.get(`machinecard:${m.id}`)
      const at = places.at[i]
      if (el && at) el.style.transform = `translate(${at.x - MACHINE_CARD.w / 2}px, ${at.y - MACHINE_CARD.h / 2}px)`
    })
    // Back on a desk, the words a phone's painter held at one size go back to their sheet.
    if (!narrow) {
      for (const el of root.current?.querySelectorAll<HTMLElement & { _t?: string; _o?: number }>('.zv-machine-label, .zv-machinecard-label, .zv-mark-none') ?? []) {
        el.style.transform = ''
        el.style.opacity = ''
        el.style.visibility = ''
        el._t = undefined
        el._o = undefined
      }
    }
    motion.wake()
  }, [device, words, model.marks, model.machines, narrow, motion.wake])
  const switchWorkspace = useCallback(async (id: string, side: 'agents' | 'items' = 'agents') => {
    setError(null)
    try {
      await cookrew().switchWorkspace(id)
      zoomStore.focusAgent(null)
      zoomStore.focusItem(null)
      if (side === 'items') zoomStore.go(0, 'items')
      else zoomStore.go(1, 'agents')
    } catch (e) { setError(`Cannot open workspace: ${String(e)}`) }
  }, [])
  const ghostItem = zoom.item ? (model.items.find((i) => i.id === zoom.item) ?? model.coinItems.find((i) => i.id === zoom.item) ?? null) : null
  // The newest browser beside the stack: on its carrier's coin when one wears it, else drawn on its own.
  const newest = model.items.find((i) => model.frame.links.some((l) => l.key === model.frame.newest && l.item === i.id)) ?? model.newestItem
  const newestAlone = model.frame.newest === null ? model.newestItem : null
  // The stops above the workspace are the same on both sides; the last is the switch.
  const stops = BAR_STOPS[zoom.dir].slice(0, -1)
  const names = BAR_NAMES[zoom.dir]
  const selectedStop = barStop(zoom.dir, zoom.v)
  const side = barSide(zoom.dir, zoom.v)
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
          drag.current = pointers.current.size === 1 && canPan()
            ? { x: e.clientX, y: e.clientY, pan: panAt.current, scrolling: false }
            : null
          if (pointers.current.size === 2) {
            pinch.current = { distance: distance(), v: zoomStore.get().v }
            moved.current = true
          }
        }}
        onPointerMove={(e) => {
          const at = pointers.current.get(e.pointerId)
          if (!at) return
          // A mouse let go outside the window never sent its pointerup: no button, no drag.
          if (e.pointerType === 'mouse' && e.buttons === 0) {
            pointers.current.delete(e.pointerId)
            drag.current = null
            return
          }
          if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 6) moved.current = true
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const d = drag.current
          if (d && pointers.current.size === 1) {
            const dx = d.x - e.clientX
            const dy = d.y - e.clientY
            // A scroll starts with a move up or down: a click's sideways wobble is still a click.
            if (!d.scrolling && Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) d.scrolling = true
            if (d.scrolling) {
              panned.current = true
              scrollBy(d.pan + dy - panAt.current)
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
          {/* Placed and sized by the painter (zoom-frame.ts · paintDeviceWords): on a phone it keeps one size as the device zooms. */}
          <div className="zv-device-label" ref={bind('deviceLabel')} style={{ maxWidth: Math.round(words.titleMax) }}>
            <b>{machine}</b><span>{model.frame.workspaces.length} workspaces</span><small>agents open the crew · browsers open thumbnails</small>
          </div>
          {model.marks.map((m) => <MarkNode key={m.id} mark={m} bind={bind} onOpen={stable(`mark:${m.id}`, () => void switchWorkspace(m.id))} onOpenItems={stable(`mark-items:${m.id}`, () => void switchWorkspace(m.id, 'items'))} />)}
          <button className="zv-workspace-hit" type="button" style={{ transform: `translate(${activeSlot.x - 90}px, ${activeSlot.y - 90}px)` }} onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} agents`} />
        </div>
        {/* The full view's sheet, UNDER the scene: the open card's parts travel over it to their places (full-poses.ts). */}
        <div className="zv-panel" ref={bind('panel')} />
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
            return a && i ? <LinkNode key={l.key} k={l.key} agent={a} item={i} shared={i.owners.length} bind={bind} onClick={stable(`link:${l.key}`, () => (zoomStore.get().dir === 'items' ? tapAgent(a.id, `link-coin:${l.key}`) : motion.item(i.id)))} /> : null
          })}
          {shownItems.map((i) => <ItemNode key={i.id} item={i} names={namesOf.get(i.id) ?? []} bind={bind} onClick={stable(`item:${i.id}`, () => motion.item(i.id))} onDelete={onDelete ? stable(`item-del:${i.id}`, () => onDelete(i.id)) : undefined} />)}
          {model.agents.map((a) => <AgentNode key={a.id} agent={a} card={cardIds.has(a.id)} bind={bind} onOpen={stable(`agent:${a.id}`, () => tapAgent(a.id, `agent-av:${a.id}`))} onDelete={onDelete ? stable(`agent-del:${a.id}`, () => onDelete(a.id)) : undefined} />)}
          <button type="button" className="zv-shelf-more" ref={bind('shelfMore') as React.Ref<HTMLButtonElement>} style={CHIP_HIDDEN} onClick={turnShelf}
            title={shelf.more ? (shelf.more.last ? 'Back to the first agents' : `${shelf.more.rest} more agents`) : undefined}
            aria-label={shelf.more ? (shelf.more.last ? 'Back to the first agents' : `${shelf.more.rest} more agents`) : 'More agents'}>
            {shelf.more ? (shelf.more.last ? '\u2013' : `+${shelf.more.rest}`) : null}
          </button>
          {model.agents.filter((a) => a.phase === 'waiting').map((a) => <span key={a.id} className="zv-dot" ref={bind(`agent-dot:${a.id}`)} />)}
          <div className="zv-grp" ref={bind('label')}>
            <button type="button" className="zv-seal" onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} crew`}>{model.agents.length}</button>
            <button type="button" className="zv-workspace-name" onClick={() => motion.go(1, 'agents')}>{model.name}</button>
            <button type="button" className="zv-tot" onClick={() => motion.go(0, 'items')} aria-label={`Open ${model.name} artifacts`} title={model.hiddenItems ? `${model.hiddenItems} more not drawn in the grid` : undefined}><Counts browsers={model.browsers} notes={model.notes} none="no items" /></button>
          </div>
          {newestAlone && <NewestThumb item={newestAlone} workspace={model.name} onOpen={stable('newest-alone', () => motion.go(0, 'items'))} thumbRef={bind('newThumb')} caption={false} />}
          <div className="zv-newcap" ref={bind('newCap')}>{newest ? <>newest · {newest.title}</> : null}</div>
          {model.agents.length === 0 && <div className="zv-empty">No agents here yet. Add an agent from the dock.</div>}
        </div>
        {/* An item's full-view head, crisp, laid where the real one will be (StageView · zv-fv-head):
            the grown thumbnail fades into it rather than blowing its words up. */}
        <div className={`zv-fullview item zv-fv-ghost${narrow ? '' : ' laned'}`} ref={bind('fullHead')} aria-hidden="true">
          {ghostItem && (
            <header className="zv-fv-head">
              <span className={`zv-fv-face ${ghostItem.kind}`}>{ghostItem.kind === 'note' ? '\u00b6' : ghostItem.initial}</span>
              <span className="zv-fv-who">
                <b>{ghostItem.title}</b>
                <small>{ghostItem.kind} · {ghostItem.kind === 'browser' ? ghostItem.host : ghostItem.line}</small>
              </span>
            </header>
          )}
        </div>
      </div>
      {/* Per row: at the crew and at the workspaces, each where its row is seen (owner, 2026-11-01). */}
      {zoom.dir === 'agents' && !zoom.full && Math.abs(zoom.v - 1) < 0.25 && model.agents.length > 0 && (
        <PerRowPill what="agents" narrow={narrow} cols={crewCols ?? defaultCrewCols(narrow)} onPick={setCrewCols} />
      )}
      {!zoom.full && Math.abs(zoom.v + 1) < 0.25 && model.frame.workspaces.length > 1 && (
        <PerRowPill what="workspaces" narrow={narrow} cols={deviceCols ?? defaultDeviceCols(narrow)} onPick={setDeviceCols} />
      )}
      <nav className="zv-controls" aria-label="Semantic zoom">
        <button type="button" className="zv-back" onClick={stepBack} aria-label="Zoom out">‹</button>
        <div className="zv-zoom-control">
          <div className="zv-stops">
            {/* Narrow, the stops you are not on wear the header's own marks and give the face its room (zoom.css). */}
            {stops.map((v, i) => (
              <button key={v} type="button" aria-current={selectedStop === v ? 'step' : undefined} aria-label={names[i]} onClick={() => motion.go(v)}>
                <CrIcon name={v === BAR_STOPS[zoom.dir][0] ? 'device' : 'canvas'} className="zv-stop-ic" />
                <span className="zv-stop-word">{names[i]}</span>
              </button>
            ))}
            <div className="zv-side" role="group" aria-label="Agents or artifacts">
              {BAR_SIDES.map((s) => <button key={s.dir} type="button" aria-current={side === s.dir ? 'step' : undefined} onClick={() => motion.go(s.v, s.dir)}>{s.name}</button>)}
            </div>
          </div>
        </div>
        <span className="zv-location">{zoom.dir === 'agents' ? 'agents' : 'artifacts'}</span>
        {/* The prompt's face, folded: the send key at the bar's end (prompt/face-slot.ts). */}
        <span className="zv-face-slot" ref={setFaceSlot} />
      </nav>
      {shelfCard && agentOf.has(shelfCard.id) && (
        <ShelfCard
          key={shelfCard.id}
          agent={agentOf.get(shelfCard.id)!}
          items={(attachIndex.get(shelfCard.id) ?? []).flatMap((at) => itemViewOf(at.node, [shelfCard.id]) ?? [])}
          anchor={registry.current.get(shelfCard.anchor) ?? null}
          onOpen={() => {
            closeShelfCard()
            zoomStore.jumpTo('agent', shelfCard.id)
          }}
          onItem={(itemId) => {
            closeShelfCard()
            motion.item(itemId)
          }}
          onDelete={onDelete ? () => {
            closeShelfCard()
            onDelete(shelfCard.id)
          } : undefined}
          onOutside={pressedOutside}
          onClose={closeShelfCard}
        />
      )}
      {error && <div role="alert" className="zv-error">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    </div>
  )
}

/** The device layers' words the painter keeps at one size on a phone (zoom-frame.ts · paintDeviceWords). */
function deviceWordEls(title: HTMLElement | null, marks: HTMLElement[], devices: HTMLElement): Pick<FrameEls, 'deviceLabel' | 'markLabels' | 'markNones' | 'machineWords'> {
  const each = (sel: string): HTMLElement[] => marks.map((m) => m.querySelector<HTMLElement>(sel)).filter((e): e is HTMLElement => !!e)
  return {
    deviceLabel: title,
    markLabels: each('.zv-mark-label'),
    markNones: each('.zv-mark-none'),
    machineWords: [...devices.querySelectorAll<HTMLElement>('.zv-machine-label, .zv-machinecard-label')]
  }
}
