import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useCanvasUi } from '../canvas-ui'
import type { WorkspaceFace } from './bar-reach'
import type { WorkspaceList, WorkspaceState } from '../../../shared/model'
import { countOf } from '../../../shared/workspace-door'
import type { AttachmentIndex } from '../terminal-attachments'
import { cookrew, isDemoMode, isRemoteMode } from '../api'
import type { Crew } from '../stage/crew-rows'
import { thumbWants } from '../pets/thumb-wants'
import { zoomThumbClaim } from './thumb-claim'
import { Counts, AgentNode, ItemNode, LinkNode, LocalMachine, type Bind, NewestThumb } from './ZoomParts'
import { MachineFrame } from './MachineFrame'
import { WorkspaceTile } from './WorkspaceTile'
import { followDrafts } from '../prompt/draft-follow'
import { useFirstRunStage } from '../first-run/first-run-state'
import { buildZoomModel, itemViewOf, type MachineView } from './zoom-model'
import { scopeNeedsMachine } from '../machine-scope'
import { machineTooOld, machineWhyShows, machineWhyWords, machineSays } from './machine-why'
import { hostPlatform } from '../../../shared/machine-words'
import { MachineTrustRow, useMachineTrust } from './MachineTrustRow'
import { ShelfCard } from './ShelfCard'
import { DevicesAgents, groupsOf } from './DevicesAgents'
import { RemotePickCard } from './RemotePickCard'
import { LOCAL_MACHINE, pickKey, ringOf, samePick, type PickGroup, type PickSpot } from './agent-keys'
import { focusPickBox, revealIn, useAgentKeys, type KeysStop } from './use-agent-keys'
import { CardScaleContext } from './AgentCard'
import { draftKey, getDraft } from '../prompt/prompt-draft'
import { DEFAULT_TILE_SIZE, defaultCrewCols, fitScale, machineFrameOf, machinesAt, screenGridCols, TILE, TILE_DRAWN_W, TILE_SIZES } from './zoom-layout'
import { GroupSeal, GROUP_STEP } from './agents-group'
import { useCrewCols, useTileSize } from './crew-cols'
import { ViewTools, type PerRow, type TileSizePick } from './ViewTools'
import { cardStopCamera, deviceCam, deviceOfModel, deviceWords, layoutOf, SWS, thumbsCamera, wordsOf, type FrameEls } from './zoom-frame'
import { useZoom, zoomStore } from './zoom-store'
import { useZoomMotion } from './use-zoom-motion'
import { BAR_NAMES, BAR_STOPS, barSide, barStop, popsCard } from './zoom-path'
import { placeWords } from './full-return'
import { backCardsOf, cardsSeenOf, goneCards, type CardsSeen } from './full-back-cards'
import type { BackInput } from '../nav-events'
import { BarGroups } from './BarGroups'
import { barCard } from './bar-pick'
import { artifactSheet } from '../artifact/open-artifact'
import { filesSheet } from '../artifact/open-files'
import { setFaceSlot } from '../prompt/face-slot'
import { CrIcon } from '../icons'
import { promptFold, takeBack } from '../prompt/prompt-fold'
import { backHolder } from '../prompt/back-guard'
import { useZoomFleetView } from './use-zoom-fleet'
import { MachineGaugeLine } from './MachineGauges'
import { gaugedMachines } from './gauged-machines'
import { RemoteMachineView } from './RemoteMachineView'
import type { TilePick } from './WorkspaceTile'
import { remotePlace, remoteStop } from './remote-machine-store'
import { canEnterMachines } from './use-remote-machine'
import './zoom.css'
// The full view's head, for the crisp ghost the way in arrives at (zv-fv-ghost).
import './full-views.css'

/** Mounted hidden: the painter shows it (zoom-frame.ts · put). */
const CHIP_HIDDEN: React.CSSProperties = { opacity: 0 }

/** Rows of thumbnails mounted past each edge of the view, so a scroll shows them already drawn. */
const ROW_BUFFER = 2
/**
 * PAST THE EDGE, THE OTHER SIDE (owner, 2026-11-17: "agents视图上滑直接进入artifacts视图，再下滑返回agents视图").
 * A swipe up begun at the crew's foot (or anywhere, when the crew fits) goes on to the artifacts;
 * a swipe down begun at the artifacts' top comes back. A finger past this, or a wheel's run past that.
 */
const SIDE_SWIPE_PX = 64
const SIDE_WHEEL_PX = 40
/** A wheel's gesture ends after this quiet: what comes later is the next one. */
const WHEEL_IDLE_MS = 140
/** A tile the keys go to is brought this far inside the view's top and bottom (the head over the grid, the bar). */
const TILE_REVEAL = { top: 64, bottom: 120 } as const
/** A failure as a person reads it: its message, without the class name String() puts in front. */
const failureWords = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The real navigator, from devices through workspaces and crew to the real
 * full views underneath. React owns the live data and the elements, the
 * frame engine owns their transforms. No second terminal/browser is made
 * for the animation: the full view behind the shell is the real one.
 */
export function ZoomView({ workspace, workspaceId, attachIndex, crew, onDelete, onNewWorkspace, firstRun, children }: {
  /** The create sheet: the WORKSPACES stop says so in words. */
  onNewWorkspace?: () => void
  workspace: WorkspaceState | null
  workspaceId: string | null
  attachIndex: AttachmentIndex
  /** The crew, read once in App (stage/crew-rows.ts · useCrew): the agent group draws the same. */
  crew: Crew
  /** Asked to remove a card: the app's own confirm dialog answers (App: requestClose). */
  onDelete?: (id: string) => void
  /** The first run's screens: they stand where a new person's empty board would. */
  firstRun?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const firstStage = useFirstRunStage()
  const overview = useRef<HTMLDivElement>(null)
  const registry = useRef(new Map<string, HTMLElement>())
  /**
   * One handler per node for its whole life, which runs the closure of the
   * latest render: the memoised nodes (ZoomParts · sameProps) keep their
   * handler, and a click still does what this render says.
   */
  const runs = useRef(new Map<string, (...args: unknown[]) => void>())
  const trampolines = useRef(new Map<string, (...args: unknown[]) => void>())
  const stable = <A extends unknown[]>(key: string, run: (...args: A) => void): ((...args: A) => void) => {
    runs.current.set(key, run as (...args: unknown[]) => void)
    let fn = trampolines.current.get(key)
    if (!fn) {
      fn = (...args: unknown[]) => runs.current.get(key)?.(...args)
      trampolines.current.set(key, fn)
    }
    return fn as unknown as (...args: A) => void
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
  // Has this machine given its one proof: the row that offers it and the machines that wait on it read the same answer.
  const trust = useMachineTrust()
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [nameAsked, setNameAsked] = useState<string | null>(null)
  const localMachine = fleet.machines.find((m) => m.local)
  const fleetWorkspaces = localMachine?.workspaces ?? []
  // The fleet's name is the one the phone can know: remote-api has no machineName().
  const machine = (nameAsked ?? localMachine?.name ?? 'This desktop').replace(/\.local$/i, '')
  const [error, setError] = useState<string | null>(null)
  // Why a machine cannot be gone into: the devices stop's own sentence, never carried past it (machine-why.ts).
  const [why, setWhy] = useState<string | null>(null)
  const whyShows = machineWhyShows(zoom.v, zoom.full !== null)
  const whyShowsNow = useRef(whyShows)
  whyShowsNow.current = whyShows
  useEffect(() => {
    if (!whyShows) setWhy(null)
  }, [whyShows])
  const [size, setSize] = useState({ w: 1000, h: 700 })
  useEffect(() => {
    let alive = true
    void cookrew().listWorkspaces().then((l) => alive && setList(l)).catch((e) => alive && setError(`Cannot read workspaces: ${failureWords(e)}`))
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
    crews: new Map(fleetWorkspaces.flatMap((w) => (w.counts ? [[w.id, w.agents] as const] : []))),
    decks: new Map(fleetWorkspaces.map((w) => [w.id, w.deck] as const)),
    loaded: workspace !== null && workspace !== undefined
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
    const base = ['devices', 'device', 'scene', 'panel', 'wash', 'label', 'newCap', 'machine'] as const
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
    return { devices: get('devices')!, device: get('device')!, scene: get('scene')!, panel: get('panel')!, wash: get('wash')!, label: get('label')!, labelW: get('label')!.offsetWidth, labelH: get('label')!.offsetHeight, newCap: get('newCap')!, machine: get('machine')!, agents, links, items, ties, fold: get('fold'), glow: get('glow'), marks, next: get('newseat'), fullHead: get('fullHead'), newThumb: get('newThumb'), shelfMore: get('shelfMore'), localAgents: get('localAgents'), ...deviceWordEls(get('deviceLabel'), [...marks.values(), ...(get('openMark') ? [get('openMark')!] : [])], get('devices')!) }
  }, [])
  // THE CREW SCROLLS ON A PHONE (zoom-frame.ts · phoneCamera), THE THUMBNAILS
  // ON ANY SCREEN (deskThumbs, phoneThumbs): drawn at a readable size, a tall
  // one scrolls (a drag, the wheel) instead of shrinking. The shelf over the
  // thumbnails is the agents group: one row, swiped along (shelfRow).
  const panAt = useRef(0)
  const panMax = useRef(0)
  // The workspaces' tiles scroll apart from the crew and the thumbnails: back at a side, its own scroll is where it was.
  const tilesAt = useRef(0)
  const tilesMax = useRef(0)
  const shelfRef = useRef(0)
  const shelfMax = useRef(0)
  const pan = useMemo(() => ({
    get: () => panAt.current,
    tiles: () => tilesAt.current,
    setTilesMax: (max: number) => {
      tilesMax.current = max
      if (tilesAt.current > max) tilesAt.current = max
    },
    shelf: () => shelfRef.current,
    setShelfMax: (max: number) => {
      shelfMax.current = max
    },
    setMax: (max: number) => {
      panMax.current = max
      if (panAt.current > max) panAt.current = max
    }
  }), [])
  // Agents and workspaces per row, as the owner picked them on this device (crew-cols.ts).
  const narrow = size.w < 760
  const [crewCols, setCrewCols] = useCrewCols(narrow)
  const [tileSize, setTileSize] = useTileSize()
  // THE DEVICES STOP PICTURES EVERY MACHINE AS ITS DESKTOP SHOWS IT (owner, 2026-11-16), filling its screen (2026-11-17: zoom-layout.ts · screenCols),
  // whatever this screen is. Read off the stop aimed at. At the workspaces stop the grid takes as many as the screen holds.
  const deviceDesk = zoom.v < -1.5
  const frame = useMemo(
    () => ({ ...model.frame, crewCols: crewCols ?? undefined, tileSize: tileSize ?? undefined, fitCols: screenGridCols(size.w, size.h, narrow, tileSize ?? DEFAULT_TILE_SIZE), deviceDesk }),
    [model.frame, crewCols, tileSize, size.w, size.h, narrow, deviceDesk]
  )
  const device = useMemo(() => deviceOfModel(frame, narrow), [frame, narrow])
  const motion = useZoomMotion(frame, collect, root, pan)
  const layout = useMemo(() => layoutOf(frame, narrow), [frame, narrow])
  // THE PHONE'S WORDS (scene-words.ts): each stop's scale at rest, for the words seen at
  // one stop only (phone-type.css), and the names' width; a new width is measured again.
  const sceneVars = useMemo(() => wordsOf(layout, size.w, size.h, narrow).vars, [layout, narrow, size])
  // A card floated over the page is drawn at the card stop's size (AgentCard.tsx · CardScaleContext).
  const cardScale = useMemo(() => ({ scale: cardStopCamera(layout, null, size.w, size.h, narrow).S, narrow }), [layout, narrow, size])
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
    shelfRef.current = 0
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
  const atTiles = (): boolean => Math.abs(zoomStore.get().v + 1) < 0.1
  const canPan = (): boolean => {
    if (atTiles()) return tilesMax.current > 0
    const z = zoomStore.get()
    return panMax.current > 0 && (z.dir === 'agents' ? z.v > 0.9 && z.v < 1.5 : z.v > -0.5 && z.v < 0.5)
  }
  const panNow = (): number => (atTiles() ? tilesAt.current : panAt.current)
  const scrollBy = (dy: number): void => {
    if (atTiles()) {
      tilesAt.current = Math.min(tilesMax.current, Math.max(0, tilesAt.current + dy))
      motion.wake()
      return
    }
    // The card stood by a face the scroll moves away: it goes, unless it holds a draft.
    if (!shelfCardDraft()) closeShelfCard()
    panAt.current = Math.min(panMax.current, Math.max(0, panAt.current + dy))
    if (zoomStore.get().dir === 'items') setFirstRow(firstRowAt(panAt.current))
    motion.wake()
  }
  /** The agents stop or the artifacts stop, at rest and not in a full view: where a swipe past the edge crosses over. */
  const sideAt = (): 'agents' | 'items' | null => {
    const z = zoomStore.get()
    if (z.full !== null) return null
    if (z.dir === 'agents' && Math.abs(z.v - 1) < 0.1) return 'agents'
    if (z.dir === 'items' && Math.abs(z.v) < 0.1) return 'items'
    return null
  }
  /** The side's scroll stands at the edge a swipe crosses from: the crew's foot, the artifacts' top. */
  const atSideEdge = (side: 'agents' | 'items', pan: number): boolean =>
    side === 'agents' ? pan >= (canPan() ? panMax.current : 0) - 1 : pan <= 1
  /** `past`: how far the gesture went beyond the scroll, + up, − down. True when it crossed. */
  const crossSide = (side: 'agents' | 'items', past: number, threshold: number): boolean => {
    if (side === 'agents' && past > threshold) motion.go(0, 'items')
    else if (side === 'items' && past < -threshold) motion.go(1, 'agents')
    else return false
    return true
  }
  /** One wheel gesture (its events a moment apart): it crosses only if it began at the edge, toward the other side; the rest of it, a trackpad's coast too, then goes nowhere. */
  const sideRun = useRef<{ side: 'agents' | 'items' | null; acc: number; timer: number; swallow: boolean }>({ side: null, acc: 0, timer: 0, swallow: false })
  // THE SHELF SWIPES ALONG (agents-group.tsx; owner, 2026-11-17): a finger or a mouse
  // dragged sideways over its row, or a sideways wheel there, moves it a face at a
  // time, settling on a whole face; its seal says how many there are and opens them.
  const shelfSnap = useRef(0)
  const shelfWheelIdle = useRef(0)
  const scrollShelf = (to: number): void => {
    const next = Math.min(shelfMax.current, Math.max(0, to))
    cancelAnimationFrame(shelfSnap.current)
    if (next === shelfRef.current) return
    if (!shelfCardDraft()) closeShelfCard()
    shelfRef.current = next
    motion.wake()
  }
  const settleShelf = (): void => {
    cancelAnimationFrame(shelfSnap.current)
    const from = shelfRef.current
    const to = Math.min(shelfMax.current, Math.max(0, Math.round(from)))
    if (to === from) return
    const t0 = performance.now()
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / 180)
      shelfRef.current = from + (to - from) * (1 - (1 - k) ** 3)
      motion.wake()
      if (k < 1) shelfSnap.current = requestAnimationFrame(step)
    }
    shelfSnap.current = requestAnimationFrame(step)
  }
  /** Over the shelf's row at the artifacts' stop, with more faces than it shows: where a sideways move scrolls it. */
  const overShelf = (x: number, y: number): boolean => {
    const z = zoomStore.get()
    if (z.dir !== 'items' || z.full !== null || Math.abs(z.v) > 0.1 || shelfMax.current <= 0) return false
    const seal = overview.current?.querySelector('.zv-shelf-more')?.getBoundingClientRect()
    if (!seal || seal.height === 0) return false
    return Math.abs(y - (seal.top + seal.height / 2)) <= 26 && x <= seal.right + 24
  }
  // AN AGENT TAPPED OVER THE ARTIFACTS opens its card on this page (owner,
  // 2026-11-03; ShelfCard.tsx), the artifacts still under it: a face on the
  // shelf or a coin under a thumbnail. The same agent again, or the card's
  // face, is its full view. So does one tapped at the agents (owner,
  // 2026-11-17): the crew keeps its zoom and the card pops up beside the face,
  // the card stop's size, instead of the camera closing in on it. Anywhere
  // else an agent's tap zooms as it did.
  const [shelfCard, setShelfCard] = useState<{ id: string; anchor: string } | null>(null)
  const shelfCardOpen = useRef(false)
  shelfCardOpen.current = shelfCard !== null
  const closeShelfCard = useCallback((): void => setShelfCard(null), [])
  // THE AGENT THE KEYS STAND ON (agent-keys.ts; owner, 2026-11-17), at the devices or the workspaces stop:
  // there its card pops for a quick reply. `keys`: they brought it, so the caret goes to its box.
  const [picked, setPicked] = useState<{ spot: PickSpot; keys: boolean } | null>(null)
  const pickedNow = useRef(picked)
  pickedNow.current = picked
  const pickOpen = useRef(false)
  pickOpen.current = picked !== null
  const clearPick = useCallback((): void => setPicked(null), [])
  /** The open card's agent has words in its box (prompt-draft.ts: typed in the card or before). */
  const shelfCardDraft = (): boolean => shelfCard !== null && getDraft(draftKey(shelfCard.id)).trim() !== ''
  const atShelf = (): boolean => {
    const z = zoomStore.get()
    return popsCard(z.dir, z.v, z.full !== null)
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
    const onShelf = popsCard(zoom.dir, zoom.v, zoom.full !== null)
    if (!onShelf || (shelfCard && !model.agents.some((a) => a.id === shelfCard.id))) closeShelfCard()
  }, [zoom.dir, zoom.v, zoom.full, model.agents, shelfCard, closeShelfCard])
  // THE WHEEL SCROLLS, IT NEVER ZOOMS (owner, 2026-10-31: the wheel is the
  // page's, and a list's). Up and down it scrolls the thumbnails (or a narrow
  // screen's crew), wherever the pointer is; a sideways one is the page's.
  const onWheel = useRef<(e: WheelEvent) => void>(() => undefined)
  onWheel.current = (e) => {
    if (e.ctrlKey) return
    if ((e.target as Element | null)?.closest?.('textarea, input, select, [role="dialog"], .zv-body.open')) return
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1
    const dx = e.deltaX * k
    const dy = e.deltaY * k
    if (Math.abs(dx) > Math.abs(dy)) {
      if (!overShelf(e.clientX, e.clientY)) return
      e.preventDefault()
      scrollShelf(shelfRef.current + dx / GROUP_STEP)
      window.clearTimeout(shelfWheelIdle.current)
      shelfWheelIdle.current = window.setTimeout(settleShelf, WHEEL_IDLE_MS)
      return
    }
    const side = sideAt()
    const run = sideRun.current
    if (run.timer === 0) {
      run.acc = 0
      run.swallow = false
      run.side = side && atSideEdge(side, panAt.current) && (side === 'agents' ? dy > 0 : dy < 0) ? side : null
    }
    window.clearTimeout(run.timer)
    run.timer = window.setTimeout(() => {
      run.timer = 0
    }, WHEEL_IDLE_MS)
    if (run.swallow) {
      e.preventDefault()
      return
    }
    if (run.side) {
      e.preventDefault()
      run.acc += dy
      if (crossSide(run.side, run.acc, SIDE_WHEEL_PX)) {
        run.side = null
        run.swallow = true
      }
      return
    }
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
  /** `side`: begun at the edge of the agents or the artifacts, by a finger, so a swipe past it crosses over (sideAt). */
  const drag = useRef<{ x: number; y: number; pan: number; scrolling: boolean; side: 'agents' | 'items' | null } | null>(null)
  const panned = useRef(false)
  /** A sideways drag along the shelf (scrollShelf): where it began, the shelf's scroll then, and whether it has started. */
  const shelfDrag = useRef<{ x: number; y: number; at: number; moving: boolean } | null>(null)
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
  /**
   * Back: from a full view to the page it was opened from (owner, 2026-11-17;
   * full-return.ts), else one stop out; false at the outermost, where there is
   * nowhere further. `by` is what asked, for the counts (nav-events.ts).
   */
  const stepBack = useCallback((by: BackInput): boolean => {
    // Inside another machine (RemoteMachineView.tsx): out of its stops first, one a press.
    if (remotePlace.stepOut()) return true
    return zoomStore.back(by)
  }, [])
  // A zoom that moves on (a stop on the bar, a jump to an agent) leaves the other machine: the stage stood on the devices stop.
  useEffect(() => {
    let at = zoomStore.get()
    return zoomStore.subscribe(() => {
      const now = zoomStore.get()
      const moved = now.v !== at.v || now.dir !== at.dir || now.full !== at.full
      at = now
      if (moved && remotePlace.get().machine) remotePlace.leave()
    })
  }, [])
  useEffect(() => () => remotePlace.leave(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // The artifact and Files sheets handle their own Escape.
      if (artifactSheet.get() || filesSheet.get()) return
      // A bar group's card (BarGroups.tsx) closes first, before the box or the view.
      if (barCard.get() && !e.isComposing && !(e.target as Element | null)?.closest?.('.cmd, .cr-board-search, .cr-board-pop, .cr-name-input, .pf-who')) {
        e.preventDefault()
        barCard.close()
        return
      }
      // An agent's card over the artifacts closes first, from its reply box too;
      // an IME's Escape and the overlays over it (⌘K, the board) keep theirs.
      // A name's field (NameEdit.tsx) owns its Escape: it cancels the rename, not the card;
      // the who-picker's field (WhoPicker.tsx) closes the picker first.
      if ((shelfCardOpen.current || pickOpen.current) && !e.isComposing && !(e.target as Element | null)?.closest?.('.cmd, .cr-board-search, .cr-board-pop, .cr-name-input, .pf-who')) {
        e.preventDefault()
        closeShelfCard()
        clearPick()
        // The caret leaves the card's box with the card: the next Tab starts from the agent it stood on.
        if ((e.target as Element | null)?.closest?.('.zv-pick-card, .dm-ov-layer')) (e.target as HTMLElement).blur?.()
        return
      }
      // The board's box and its panel own their Esc (BoardSearch.tsx).
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm, .cr-board-search, .cr-board-pop')) return
      // The box's own buttons and picker keep their Esc while the box can fold
      // or its picker is open; in an agent's full view it steps out as before.
      if ((e.target as Element | null)?.closest?.('.cr-prompt') && (promptFold.get().foldable || promptFold.get().picker)) return
      e.preventDefault()
      // The picker closes first, then an open prompt box folds; the view
      // stays. Only then does the zoom step out (prompt/prompt-fold.ts · takeBack).
      takeBack(() => stepBack('esc'))
    }
    // Capture, so a card that stops Escape on its way up does not keep us zoomed.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stepBack, closeShelfCard, clearPick])
  // BACK ON A WEB PAGE (the phone companion; prompt/back-guard.ts): Android's
  // back and the browser's take the Esc order, one step a press: an agent's
  // card over the artifacts, the picker, a box open for nobody, then the zoom
  // one stop out. At the outermost stop back leaves the page, as it always did.
  // The desktop app has no back, so it keeps no entries. Nothing is pushed
  // before the owner's first touch: Chrome skips history entries a page adds
  // without one, and back would then skip past the page.
  const backSteps = useRef({ stepBack, closeShelfCard, clearPick })
  backSteps.current = { stepBack, closeShelfCard, clearPick }
  useEffect(() => {
    if (!isRemoteMode() && !isDemoMode()) return
    const holder = backHolder(window, window.history)
    const release = holder.hold({
      wants: () => {
        if ((navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === false) return false
        return filesSheet.get() !== null || artifactSheet.get() !== null || barCard.get() !== null || shelfCardOpen.current || pickOpen.current || promptFold.wantsBack() || zoomStore.canBack()
      },
      back: () => {
        if (filesSheet.get()) return filesSheet.back()
        if (artifactSheet.get()) return artifactSheet.close()
        if (barCard.get()) return barCard.close()
        if (shelfCardOpen.current) return backSteps.current.closeShelfCard()
        if (pickOpen.current) return backSteps.current.clearPick()
        takeBack(() => backSteps.current.stepBack('system'))
      }
    })
    const offFold = promptFold.subscribe(holder.sync)
    const offZoom = zoomStore.subscribe(holder.sync)
    const offBar = barCard.subscribe(holder.sync)
    const offSheet = artifactSheet.subscribe(holder.sync)
    const offFiles = filesSheet.subscribe(holder.sync)
    return () => {
      offFold()
      offZoom()
      offBar()
      offSheet()
      offFiles()
      release()
    }
  }, [])
  // A press that turned into a pinch or a drag is not the click that steps out.
  const moved = useRef(false)
  const swallowClick = useRef(false)
  const deckBrowsers = model.openMark.deck.filter((i) => i.kind === 'browser').map((i) => i.id).join(' ')
  // Only what is drawn where the zoom is (thumb-claim.ts): the open tile's deck on the tiles, the grid in
  // view at the artifacts, the crew's coins past the tiles. Keyed on that answer, so the zoom moving within
  // one stretch claims nothing again.
  // The crew's own pictures: the browsers its coins wear, and the newest one when it is drawn on its own.
  const crewBrowsers = useMemo(() => {
    const items = new Map([...model.items, ...model.coinItems].map((i) => [i.id, i]))
    const worn = model.frame.links.map((l) => items.get(l.item)).filter((i) => i?.kind === 'browser').map((i) => i!.id)
    const alone = model.frame.newest === null && model.newestItem?.kind === 'browser' ? [model.newestItem.id] : []
    return [...worn, ...alone].join(' ')
  }, [model.items, model.coinItems, model.frame.links, model.frame.newest, model.newestItem])
  const claimed = zoomThumbClaim({ dir: zoom.dir, v: zoom.v, deck: deckBrowsers.split(' '), seen: seenBrowsers.split(' '), crew: crewBrowsers.split(' ') }).join(' ')
  useEffect(() => {
    thumbWants.claim('zoom', claimed === '' ? [] : claimed.split(' '))
    return () => thumbWants.release('zoom')
  }, [claimed])
  const agentOf = useMemo(() => new Map(model.agents.map((a) => [a.id, a])), [model.agents])
  // The bar's groups reach every workspace (bar-reach.ts): each one's name, icon and served mark,
  // from the live list. Until it lands none is known, so nothing served can flash in.
  const wsFaces = useMemo(
    (): ReadonlyMap<string, WorkspaceFace> =>
      new Map((list?.workspaces ?? []).map((w) => [w.id, { name: w.name, icon: w.icon || null, ...(w.served ? { served: true } : {}) }])),
    [list]
  )
  const { jumpToNode } = useCanvasUi()
  // A notification clicked (main/notifier.ts): that agent, in its own workspace.
  useEffect(() => cookrew().onHitlOpen?.(({ workspaceId: ws, id }) => void jumpToNode(ws, id)), [jumpToNode])
  const markOf = useMemo(() => new Map(model.marks.map((m) => [m.id, m])), [model.marks])
  // One names list per item, so a row scrolled into view does not draw every mounted thumbnail again (ItemNode is memo'd).
  const namesOf = useMemo(() => new Map(model.items.map((i) => [i.id, i.owners.map((id) => agentOf.get(id)?.name ?? id)])), [model.items, agentOf])
  // The grid's items and the coins' others: a coin's face is drawn either way.
  const itemOf = useMemo(() => new Map([...model.items, ...model.coinItems].map((i) => [i.id, i])), [model.items, model.coinItems])
  const activeSlot = device.at[model.frame.active] ?? { x: 0, y: 0 }
  // The one frame every machine is drawn in on the devices stop, this one too (zoom-layout.ts · machineFrameOf).
  const frameOf = useMemo(() => machineFrameOf(device, narrow), [device, narrow])
  const gauged = useMemo(() => new Set(gaugedMachines(model.machines, scopeNeedsMachine()).map((m) => m.id)), [model.machines])
  // The device stop's words grow to be read at the size the device is seen (zoom-frame.ts · deviceWords).
  const words = useMemo(() => deviceWords(device, size.w, size.h, size.w < 760), [device, size])
  // Static placement on the device: the real active workspace is rendered by the scene layer.
  useLayoutEffect(() => {
    for (const m of model.marks) {
      const el = registry.current.get(`mark:${m.id}`)
      const at = device.at[m.id]
      if (el && at) el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${SWS})`
    }
    const open = registry.current.get('openMark')
    if (open) open.style.transform = `translate(${activeSlot.x}px, ${activeSlot.y}px) scale(${SWS})`
    fontsVersion.current += 1
    const machineEl = registry.current.get('machine')
    if (machineEl) {
      // The one frame, at the display's proportions (zoom-layout.ts · screenOf), the device view centred in it.
      machineEl.style.width = `${frameOf.w}px`
      machineEl.style.height = `${frameOf.h}px`
      machineEl.style.transform = `translate(${-frameOf.w / 2}px, ${-frameOf.h / 2}px)`
    }
    // The account's other machines: in this one's row, each the same frame (zoom-layout.ts · machinesAt).
    const others = model.machines.filter((m) => !m.local)
    const places = machinesAt(others.length, frameOf, narrow)
    others.forEach((m, i) => {
      const el = registry.current.get(`machinecard:${m.id}`)
      const at = places.at[i]
      if (el && at) el.style.transform = `translate(${at.x - frameOf.w / 2}px, ${at.y - frameOf.h / 2}px)`
    })
    // Back on a desk, the words a phone's painter held at one size go back to their sheet.
    if (!narrow) {
      for (const el of root.current?.querySelectorAll<HTMLElement & { _t?: string; _o?: number }>('.zv-machine-label') ?? []) {
        el.style.transform = ''
        el.style.opacity = ''
        el.style.visibility = ''
        el._t = undefined
        el._o = undefined
      }
    }
    motion.wake()
  }, [device, frameOf, words, model.marks, model.machines, narrow, motion.wake])
  const switchWorkspace = useCallback(async (id: string, side: 'agents' | 'items' = 'agents', target?: string, full = false) => {
    setError(null)
    try {
      await cookrew().switchWorkspace(id)
      zoomStore.focusAgent(side === 'agents' ? target ?? null : null)
      zoomStore.focusItem(side === 'items' ? target ?? null : null)
      // The tile's four doors (owner, 2026-11-17): an agent's or an artifact's full view, or the agents or the artifacts.
      if (side === 'agents' && target && full) zoomStore.jumpTo('agent', target)
      else if (side === 'items') zoomStore.go(target && full ? 1 : 0, 'items')
      else zoomStore.go(1, 'agents')
    } catch (e) { setError(`Cannot open workspace: ${failureWords(e)}`) }
  }, [])
  const ghostItem = zoom.item ? (model.items.find((i) => i.id === zoom.item) ?? model.coinItems.find((i) => i.id === zoom.item) ?? null) : null
  // The newest browser beside the stack: on its carrier's coin when one wears it, else drawn on its own.
  const newest = model.items.find((i) => model.frame.links.some((l) => l.key === model.frame.newest && l.item === i.id)) ?? model.newestItem
  const newestAlone = model.frame.newest === null ? model.newestItem : null
  // The stops above the workspace are the same on both sides; the last is the switch.
  const stops = BAR_STOPS[zoom.dir].slice(0, -1)
  const names = BAR_NAMES[zoom.dir]
  const selectedStop = barStop(zoom.dir, zoom.v)
  // Inside another machine the bar moves through its stops, not this one's (owner 2026-11-11).
  const inside = remoteStop(useSyncExternalStore(remotePlace.subscribe, remotePlace.get, remotePlace.get))
  // ── THE KEYS, AGENT BY AGENT (agent-keys.ts; owner, 2026-11-17) ──
  // At rest on the devices or the workspaces stop, never in a full view or inside another machine.
  const stopNow: KeysStop | null = zoom.full !== null || inside !== null ? null : Math.abs(zoom.v + 2) < 0.1 ? 'devices' : Math.abs(zoom.v + 1) < 0.1 ? 'workspaces' : null
  // This machine's workspaces in the grid's order, the open one in its slot: its screen at the devices stop and its tiles.
  const localMarks = useMemo(() => model.frame.workspaces.flatMap((id) => (id === model.frame.active ? [model.openMark] : (markOf.get(id) ?? []))), [model.frame.workspaces, model.frame.active, model.openMark, markOf])
  // The account's other machines, and what stands in the way of reading each (machine-why.ts).
  const others = model.machines.filter((m) => !m.local).map((m) => ({ m, say: machineSays(m, { surface: machineSurface(), trusted: trust[0]?.trusted ?? null, platform: hostPlatform(), floor: scopeNeedsMachine(), block: cookrew().machineWhy?.(m.id) ?? null }) }))
  /** A stop's agents, workspace by workspace, as drawn: this machine first, then each other one whose screen lights. */
  const groupsAt = (stop: KeysStop): PickGroup[] =>
    stop === 'workspaces' ? groupsOf(LOCAL_MACHINE, localMarks) : [...groupsOf(LOCAL_MACHINE, localMarks), ...others.filter((o) => o.say === null).flatMap((o) => groupsOf(o.m.id, o.m.marks))]
  const ringSig = stopNow ? ringOf(groupsAt(stopNow)).map(pickKey).join(' ') : ''
  // An agent gone, or the view moved on: the card goes with it.
  useEffect(() => {
    if (picked && !ringSig.split(' ').includes(pickKey(picked.spot))) setPicked(null)
  }, [ringSig, picked])
  useAgentKeys({
    stop: () => {
      const z = zoomStore.get()
      if (z.full !== null || remotePlace.get().machine) return null
      return Math.abs(z.v + 2) < 0.1 ? 'devices' : Math.abs(z.v + 1) < 0.1 ? 'workspaces' : null
    },
    groups: groupsAt,
    picked: () => pickedNow.current?.spot ?? null,
    pick: (spot) => setPicked({ spot, keys: true }),
    root: () => overview.current
  })
  const faceEl = (spot: PickSpot): HTMLElement | null => overview.current?.querySelector<HTMLElement>(`[data-pick="${CSS.escape(pickKey(spot))}"]`) ?? null
  // Where the keys went is brought into view, and the caret into its card's box.
  useEffect(() => {
    if (!picked?.keys) return undefined
    const root = overview.current
    if (!root) return undefined
    if (stopNow === 'devices') {
      const face = faceEl(picked.spot)
      const scroller = face?.closest<HTMLElement>('.da-scroll')
      if (face && scroller) revealIn(scroller, face)
      return focusPickBox(document, '.zv-pick-card .zv-reply input')
    }
    const tile = root.querySelector<HTMLElement>(`.zv-device .zv-mark[data-ws="${CSS.escape(picked.spot.workspace)}"] .dm-tile`)
    if (tile) {
      const r = tile.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      const top = box.top + TILE_REVEAL.top
      const bottom = box.bottom - TILE_REVEAL.bottom
      if (r.top < top) scrollBy(r.top - top)
      else if (r.bottom > bottom) scrollBy(Math.min(r.bottom - bottom, r.top - top))
    }
    return undefined
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps
  // A workspace card's px in the devices layer's units: the faces there as big as on the workspaces stop (DevicesAgents.tsx).
  const agentK = useMemo(() => {
    const grid = deviceOfModel({ ...frame, deviceDesk: false }, narrow)
    const tileK = (deviceCam(grid, size.w, size.h, narrow).S * SWS * TILE.w) / TILE_DRAWN_W
    return tileK / fitScale(layout.devicesBox, size.w, size.h)
  }, [frame, narrow, size, layout.devicesBox])
  /** Into another machine, in place (RemoteMachineView.tsx): at a workspace, or an agent in it. */
  const enterMachine = (m: MachineView, workspace: { id: string; name: string } | null, agent: { id: string; name: string } | null = null): void => {
    const enter = (): void => {
      setWhy(null)
      // Entered in place: its view opens from where its frame stands (remote-entry.ts).
      const box = registry.current.get(`machinecard:${m.id}`)?.getBoundingClientRect()
      remotePlace.enter({ id: m.id, name: m.name, os: m.os ?? null, ...(box ? { from: { x: box.left, y: box.top, w: box.width, h: box.height } } : {}) })
      if (workspace) remotePlace.workspace(workspace)
      if (workspace && agent) remotePlace.agent(agent)
    }
    if (m.online && m.detail !== 'listed' && canEnterMachines()) enter()
    // Asked over the network: a view gone elsewhere meanwhile neither hears the answer nor is carried into the machine.
    else void whyNot(m).then((words) => {
      if (!whyShowsNow.current) return
      if (words === null) enter()
      else setWhy(words)
    })
  }
  /** A picked agent's full view: on this machine its own, on another that machine's card. */
  const openPicked = (spot: PickSpot): void => {
    setPicked(null)
    if (spot.machine === LOCAL_MACHINE) {
      if (spot.workspace === model.frame.active) zoomStore.jumpTo('agent', spot.agent)
      else void switchWorkspace(spot.workspace, 'agents', spot.agent, true)
      return
    }
    const m = model.machines.find((one) => one.id === spot.machine)
    const mark = m?.marks.find((one) => one.id === spot.workspace)
    const agent = mark?.agents?.find((one) => one.id === spot.agent)
    if (m && mark) enterMachine(m, { id: mark.id, name: mark.name }, agent ? { id: agent.id, name: agent.name } : null)
  }
  /** A face pressed at the devices stop: its card pops; the same face again is its full view. */
  const pickFace = (spot: PickSpot): void => {
    if (samePick(pickedNow.current?.spot ?? null, spot)) return openPicked(spot)
    setPicked({ spot, keys: false })
  }
  /** What a tile's card shows when the keys stand on one of its agents (WorkspaceTile.tsx · TilePick). */
  const tilePick = (id: string): TilePick =>
    picked && stopNow === 'workspaces' && picked.spot.machine === LOCAL_MACHINE && picked.spot.workspace === id ? { agent: picked.spot.agent, keys: picked.keys } : null
  const tilePicked = (id: string) => stable(`pick:${id}`, (agentId: string | null) =>
    setPicked((now) => (agentId ? { spot: { machine: LOCAL_MACHINE, workspace: id, agent: agentId }, keys: false } : now?.spot.workspace === id ? null : now)))
  /** The card the keys (or a press) popped at the devices stop: this machine's own card, or another machine's. */
  const pickCard = (): React.ReactNode => {
    if (!picked || stopNow !== 'devices') return null
    const { spot } = picked
    const anchor = faceEl(spot)
    if (spot.machine === LOCAL_MACHINE) {
      const mark = localMarks.find((one) => one.id === spot.workspace)
      const agent = mark?.agents?.find((one) => one.id === spot.agent)
      if (!mark || !agent) return null
      const open = spot.workspace === model.frame.active
      const items = open ? (attachIndex.get(agent.id) ?? []).flatMap((at) => itemViewOf(at.node, [agent.id]) ?? []) : mark.deck.filter((item) => item.owners.includes(agent.id))
      return (
        <ShelfCard
          key={pickKey(spot)}
          className="zv-pick-card"
          agent={agent}
          items={items}
          anchor={anchor}
          onOpen={() => openPicked(spot)}
          onItem={(itemId) => {
            setPicked(null)
            if (!open) return void switchWorkspace(spot.workspace, 'items', itemId, true)
            zoomStore.focusItem(itemId)
            zoomStore.go(1, 'items')
          }}
          onOutside={pressedOutside}
          onClose={clearPick}
        />
      )
    }
    const m = model.machines.find((one) => one.id === spot.machine)
    const agent = m?.marks.find((one) => one.id === spot.workspace)?.agents?.find((one) => one.id === spot.agent)
    if (!m || !agent) return null
    return <RemotePickCard key={pickKey(spot)} machine={{ id: m.id, name: m.name, os: m.os ?? null }} workspace={spot.workspace} agent={agent} anchor={anchor} onOpen={() => openPicked(spot)} onOutside={pressedOutside} onClose={clearPick} />
  }
  const perRowAt: PerRow | null =
    zoom.dir === 'agents' && Math.abs(zoom.v - 1) < 0.25 && model.agents.length > 0
      ? { what: 'agents', narrow, cols: crewCols ?? defaultCrewCols(narrow), onPick: setCrewCols }
      : null
  // A tile's least type on a desk: the grid takes as many to a row as hold it (zoom-layout.ts · gridColsFor). A phone's one a row fills its width.
  const tileSizeAt: TileSizePick | null =
    !narrow && Math.abs(zoom.v + 1) < 0.25 && model.frame.workspaces.length > 0
      ? { sizes: TILE_SIZES, size: tileSize ?? DEFAULT_TILE_SIZE, onPick: setTileSize }
      : null
  const side = barSide(zoom.dir, zoom.v)
  // Back from a full view (full-return.ts): a closed card leaves the way back, and the ‹ says where it goes.
  const backCards = useMemo(() => (workspace ? backCardsOf(workspace.nodes) : null), [workspace])
  const cardsSeen = useRef<CardsSeen | null>(null)
  useEffect(() => {
    if (!workspace) return
    const seen = cardsSeenOf(workspaceId, workspace.nodes)
    const gone = goneCards(cardsSeen.current, seen)
    cardsSeen.current = seen
    if (gone.size > 0) zoomStore.prune((_kind, id) => !gone.has(id))
  }, [workspace, workspaceId])
  const backTo = zoom.full !== null ? zoomStore.backTarget() : null
  const backWords = backTo ? placeWords(backTo, backCards?.nameOf ?? (() => null)) : null
  // Pinch only changes the scene; the full terminal keeps its own native scroll.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; v: number } | null>(null)
  const distance = (): number => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  return (
    <CardScaleContext.Provider value={cardScale}>
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
          // A finger only: a mouse dragging on the crew moves an agent (use-zoom-motion.ts · dragStart), and the wheel crosses for it.
          const side = e.pointerType !== 'mouse' && !(e.target as Element | null)?.closest?.('textarea, input, select, [role="dialog"], .zv-body.open') ? sideAt() : null
          const edgeSide = side && atSideEdge(side, panAt.current) ? side : null
          shelfDrag.current = pointers.current.size === 1 && overShelf(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY, at: shelfRef.current, moving: false } : null
          drag.current = pointers.current.size === 1 && (canPan() || edgeSide)
            ? { x: e.clientX, y: e.clientY, pan: panNow(), scrolling: false, side: edgeSide }
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
          const sd = shelfDrag.current
          if (sd && pointers.current.size === 1) {
            const dx = sd.x - e.clientX
            // Sideways first: the shelf takes the drag; up or down first, the page scrolls as before.
            if (!sd.moving && Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(sd.y - e.clientY) && !drag.current?.scrolling) {
              sd.moving = true
              drag.current = null
            }
            if (sd.moving) {
              panned.current = true
              scrollShelf(sd.at + dx / GROUP_STEP)
              return
            }
          }
          const d = drag.current
          if (d && pointers.current.size === 1) {
            const dx = d.x - e.clientX
            const dy = d.y - e.clientY
            // A scroll starts with a move up or down: a click's sideways wobble is still a click.
            if (!d.scrolling && Math.abs(dy) > 6 && Math.abs(dy) >= Math.abs(dx)) d.scrolling = true
            if (d.scrolling) {
              panned.current = true
              if (canPan()) scrollBy(d.pan + dy - panNow())
            }
          }
          const p = pinch.current
          if (p && pointers.current.size === 2 && p.distance > 0) motion.go(p.v + Math.log2(distance() / p.distance) * 1.1)
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId)
          if (pointers.current.size < 2) pinch.current = null
          const d = drag.current
          // How far the finger went beyond what the scroll could take: a long enough swipe off the edge crosses over.
          if (d?.scrolling && d.side && pointers.current.size === 0) {
            const wanted = d.pan + (d.y - e.clientY)
            crossSide(d.side, d.side === 'agents' ? wanted - (canPan() ? panMax.current : 0) : wanted, SIDE_SWIPE_PX)
          }
          drag.current = null
          if (shelfDrag.current?.moving) settleShelf()
          shelfDrag.current = null
        }}
        // A drag that scrolled the crew is not a click on the face it ended on.
        onClickCapture={(e) => {
          if (!panned.current) return
          panned.current = false
          e.stopPropagation()
          e.preventDefault()
        }}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); pinch.current = null; moved.current = true; drag.current = null; if (shelfDrag.current?.moving) settleShelf(); shelfDrag.current = null }}
        onClick={(e) => {
          // Nothing was pressed, or the press was a pinch or a drag: not a step out.
          if (swallowClick.current) { swallowClick.current = false; return }
          if (moved.current || pinch.current !== null) return
          // A node, a card, a button, a field: its own click, which zooms in.
          if ((e.target as Element).closest('button, input, textarea, form, a, [role="button"], .zv-m, .zv-card, .zv-ip, .zv-lk, .zv-mark, .zv-machine')) return
          stepBack('background')
        }}>
        <div className="zv-devices" ref={bind('devices')}>
          {others.map(({ m, say }) => (
            <MachineFrame
              key={m.id}
              machine={m}
              frame={frameOf}
              agentK={agentK}
              say={say}
              caption={say ?? machineCaption(m)}
              gauge={gauged.has(m.id) && say === null ? <MachineGaugeLine machineId={m.id} online={m.online} /> : null}
              picked={picked && picked.spot.machine === m.id ? pickKey(picked.spot) : null}
              onPick={stable('pick-face', pickFace)}
              bind={bind}
              onOpen={() => enterMachine(m, null)}
              onOpenWorkspace={(id) => enterMachine(m, { id, name: m.marks.find((one) => one.id === id)?.name ?? id })}
            />
          ))}
          <LocalMachine name={machine} detail={`${countOf(model.frame.workspaces.length, 'workspace')} · ${countOf(model.deviceAgents, 'agent')}`} gauge={<MachineGaugeLine machineId="local" local />} bind={bind} onOpen={() => motion.go(-1)}>
            {/* Its screen at the devices stop: its agents only; the painter hands it over to the tiles on the way in (zoom-frame.ts · AGENTS_ONLY). */}
            <div className="zv-local-agents" ref={bind('localAgents')}>
              <DevicesAgents
                machine={LOCAL_MACHINE}
                name={machine}
                marks={localMarks}
                frame={frameOf}
                k={agentK}
                picked={picked && picked.spot.machine === LOCAL_MACHINE ? pickKey(picked.spot) : null}
                onPick={stable('pick-face', pickFace)}
                onOpenWorkspace={stable('open-local-ws', (id: string) => (id === model.frame.active ? motion.go(1, 'agents') : void switchWorkspace(id, 'agents')))}
              />
            </div>
          </LocalMachine>
        </div>
        <div className="zv-device" ref={bind('device')} data-density={words.density} style={{ '--zv-k': words.markK.toFixed(3), '--zv-tile-top': `${Math.round(device.tile.top)}px`, '--zv-tile-h': `${Math.round(device.tile.h)}px` } as React.CSSProperties}>
          {/* Placed and sized by the painter (zoom-frame.ts · paintDeviceWords): on a phone it keeps one size as the device zooms. */}
          <div className="zv-device-label" ref={bind('deviceLabel')} style={{ maxWidth: Math.round(words.titleMax) }}>
            <b>{machine}</b><span>{countOf(model.frame.workspaces.length, 'workspace')}</span>
          </div>
          {/* In the grid's order, so Tab walks it as the eye does. The open tile's faces are the scene's, over it. */}
          {model.frame.workspaces.map((id) => {
            if (id === model.frame.active) return <WorkspaceTile key={id} mark={model.openMark} open bind={bind} pick={tilePick(id)} onPick={tilePicked(id)} onOpen={stable('open-agents', (agentId?: string, full?: boolean) => { if (agentId && full) return zoomStore.jumpTo('agent', agentId); if (agentId) zoomStore.focusAgent(agentId); motion.go(1, 'agents') })} onOpenItems={stable('open-items', (itemId?: string, full?: boolean) => { if (itemId) zoomStore.focusItem(itemId); motion.go(itemId && full ? 1 : 0, 'items') })} />
            const m = markOf.get(id)
            return m ? <WorkspaceTile key={id} mark={m} bind={bind} pick={tilePick(id)} onPick={tilePicked(id)} onOpen={stable(`mark:${id}`, (agentId?: string, full?: boolean) => void switchWorkspace(id, 'agents', agentId, full))} onOpenItems={stable(`mark-items:${id}`, (itemId?: string, full?: boolean) => void switchWorkspace(id, 'items', itemId, full))} /> : null
          })}
        </div>
        {/* The full view's sheet, UNDER the scene: the open card's parts travel over it to their places (full-poses.ts). */}
        <div className="zv-panel" ref={bind('panel')} />
        <div className="zv-scene" ref={bind('scene')}>
          <div className="zv-wash" ref={bind('wash')} />
          {/* The fold's faces round a hovered agent, in their light (zoom-frame.ts · foldFaces): under every tie and face. */}
          {/* The crew's light at rest, under the fold's (zoom-frame.ts · terrainFaces, foldFaces; ⋯ → Agent light). */}
          <svg className="zv-glow" ref={bind('glow') as unknown as React.Ref<SVGSVGElement>} aria-hidden="true" />
          <svg className="zv-fold" ref={bind('fold') as unknown as React.Ref<SVGSVGElement>} aria-hidden="true" />
          {/* No cable is drawn between agents (owner 2026-11-12): their ties show in the fold's faces and the light at rest, and still lay out the crew. */}
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
          {model.agents.map((a) => <AgentNode key={a.id} agent={a} card={cardIds.has(a.id)} bind={bind} onOpen={stable(`agent:${a.id}`, () => tapAgent(a.id, `agent-av:${a.id}`))} onDelete={onDelete ? stable(`agent-del:${a.id}`, () => onDelete(a.id)) : undefined} onHoverIn={stable(`hover:${a.id}`, () => motion.hover(a.id))} onHoverOut={stable(`unhover:${a.id}`, () => motion.hover(null))} onDragStart={motion.dragStart} />)}
          <button type="button" className="zv-shelf-more" ref={bind('shelfMore') as React.Ref<HTMLButtonElement>} style={CHIP_HIDDEN} onClick={() => motion.go(1, 'agents')}
            aria-label={`Open ${model.name} crew: ${model.agents.length} agents`}>
            <GroupSeal count={model.agents.length} />
          </button>
          {model.agents.filter((a) => a.phase === 'waiting').map((a) => <span key={a.id} className="zv-dot" ref={bind(`agent-dot:${a.id}`)} />)}
          <div className="zv-grp" ref={bind('label')}>
            <button type="button" className="zv-seal" onClick={() => motion.go(1, 'agents')} aria-label={`Open ${model.name} crew`}>{model.agents.length}</button>
            <button type="button" className="zv-workspace-name" onClick={() => motion.go(1, 'agents')}>{model.name}</button>
            <button type="button" className="zv-tot" onClick={() => motion.go(0, 'items')} aria-label={`Open ${model.name} artifacts`} title={model.hiddenItems ? `${model.hiddenItems} more not drawn in the grid` : undefined}><Counts browsers={model.browsers} notes={model.notes} none="no items" /></button>
          </div>
          {newestAlone && <NewestThumb item={newestAlone} workspace={model.name} onOpen={stable('newest-alone', () => motion.go(0, 'items'))} thumbRef={bind('newThumb')} caption={false} />}
          <div className="zv-newcap" ref={bind('newCap')}>{newest ? <>newest · {newest.title}</> : null}</div>
          {model.agents.length === 0 && zoom.v > -0.5 && firstStage !== null && firstStage !== 'preflight' && firstStage !== 'task' && <div className="zv-empty">No agents here yet. Add an agent from the dock.</div>}
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
      {firstRun}
      {/* THE VIEW'S TOOLBAR (ViewTools.tsx; owner 2026-11-12): top right at every stop of this machine,
          per row where a row is seen (the crew's agents, the device's workspaces; owner 2026-11-01)
          beside this machine's remote desktop. Inside another machine its stops are that machine's. */}
      {!zoom.full && inside === null && <ViewTools perRow={perRowAt} tileSize={tileSizeAt} />}
      {!zoom.full && Math.abs(zoom.v + 1) < 0.25 && onNewWorkspace && (
        <button type="button" className="zv-new-workspace" onClick={onNewWorkspace}>
          <span aria-hidden="true">＋</span> New workspace
        </button>
      )}
      <nav className="zv-controls" aria-label="Semantic zoom">
        <button type="button" className="zv-back" onClick={() => stepBack('button')} aria-label={backWords ? `Back to ${backWords}` : 'Zoom out'} title={backWords ? `Back to ${backWords}` : undefined}>‹</button>
        <div className="zv-zoom-control">
          {inside !== null ? (
            <div className="zv-stops" data-machine="other">
              <button type="button" aria-label={names[0]} onClick={() => remotePlace.leave()}>
                <CrIcon name="device" className="zv-stop-ic" />
                <span className="zv-stop-word">{names[0]}</span>
              </button>
              <button type="button" aria-current={inside === 'workspaces' ? 'step' : undefined} aria-label={names[1]} onClick={() => remotePlace.backTo(1)}>
                <CrIcon name="canvas" className="zv-stop-ic" />
                <span className="zv-stop-word">{names[1]}</span>
              </button>
              <div className="zv-groups" role="group" aria-label="Artifacts or agents">
                {(['items', 'agents'] as const).map((one) => (
                  <div key={one} className={`zv-group ${one}${inside === one ? ' lit' : ''} empty`}>
                    <button type="button" className="zv-group-stop" aria-current={inside === one ? 'step' : undefined} aria-label={one === 'items' ? 'artifacts' : 'agents'} onClick={() => remotePlace.side(one)}>
                      <span className="zv-group-word">{one === 'items' ? 'artifacts' : 'agents'}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
          <div className="zv-stops">
            {/* Narrow, the stops you are not on wear the header's own marks and give the face its room (zoom.css). */}
            {stops.map((v, i) => (
              <button key={v} type="button" aria-current={selectedStop === v ? 'step' : undefined} aria-label={names[i]} onClick={() => motion.go(v)}>
                <CrIcon name={v === BAR_STOPS[zoom.dir][0] ? 'device' : 'canvas'} className="zv-stop-ic" />
                <span className="zv-stop-word">{names[i]}</span>
              </button>
            ))}
            {/* The two sides are the groups of what needs you (BarGroups.tsx), each still its stop. */}
            <BarGroups
              workspaceId={workspaceId}
              nodes={workspace?.nodes ?? null}
              rows={crew.crew}
              all={crew.all}
              workspaces={wsFaces}
              agents={agentOf}
              attachIndex={attachIndex}
              side={side}
              narrow={narrow}
              onStop={(v, dir) => motion.go(v, dir)}
              onAgentFull={(id) => zoomStore.jumpTo('agent', id)}
              onItemFull={(id) => motion.item(id)}
              onJump={(ws, id) => void jumpToNode(ws, id)}
              onDelete={onDelete}
              onOutside={pressedOutside}
            />
          </div>
          )}
        </div>
        {/* At a full view it names where the ‹ goes; at a stop, the side the view is on. */}
        <span className="zv-location">{backWords ?? (zoom.dir === 'agents' ? 'agents' : 'artifacts')}</span>
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
      {pickCard()}
      <RemoteMachineView />
      {error && <div role="alert" className="zv-error">{error}<button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
      {/* This machine's one proof, at the foot of the devices stop and outside the camera: inside it the
          button lay under this machine's own frame, where it could be neither seen nor pressed. */}
      {whyShows && <div className="zv-trust-bar"><MachineTrustRow machines={model.machines} trust={trust} /></div>}
      {!error && why && whyShows && <div role="status" className="zv-error">{why}<button type="button" onClick={() => setWhy(null)} aria-label="Dismiss">×</button></div>}
    </div>
    </CardScaleContext.Provider>
  )
}

/** Under another machine's name: how many workspaces and agents, and how many wait. */
function machineCaption(m: MachineView): string {
  return `${countOf(m.workspaces.length, 'workspace')}${m.agents !== null ? ` · ${countOf(m.agents, 'agent')}` : ''}${m.waiting ? ` · ${m.waiting} waiting` : ''}`
}

/** Where this view runs, for what it can say about another machine (machine-why.ts). */
const machineSurface = (): 'desktop' | 'page' | 'none' => (!canEnterMachines() ? 'none' : isRemoteMode() ? 'page' : 'desktop')

/**
 * What stands between this view and another machine, as the one thing to do
 * (machine-why.ts); null when asking it now found it answers, and it can be gone into.
 */
async function whyNot(m: MachineView): Promise<string | null> {
  const api = cookrew()
  const surface = machineSurface()
  // Too old for the console: a tap asks it nothing either, and says to update it.
  if (machineTooOld(m, scopeNeedsMachine())) return machineWhyWords(m, { surface, trusted: null, block: null, platform: hostPlatform(), floor: true })
  // Not read yet (a page just opened, a key just made): asked now, so a tap is not a wait for the next round.
  if (surface !== 'none' && m.online && (await api.machineFleetOf?.(m.id).catch(() => null)) != null) return null
  const trusted = surface === 'desktop' ? ((await api.machineTrust?.().catch(() => null)) ?? null)?.trusted ?? null : null
  return machineWhyWords(m, { surface, trusted, block: api.machineWhy?.(m.id) ?? null, platform: hostPlatform() })
}

/** The device layers' words the painter keeps at one size on a phone (zoom-frame.ts · paintDeviceWords). */
function deviceWordEls(title: HTMLElement | null, marks: HTMLElement[], devices: HTMLElement): Pick<FrameEls, 'deviceLabel' | 'markLabels' | 'machineWords'> {
  return {
    deviceLabel: title,
    markLabels: marks.flatMap((m) => [...m.querySelectorAll<HTMLElement>('.zv-tw')]),
    machineWords: [...devices.querySelectorAll<HTMLElement>('.zv-machine-label')]
  }
}
