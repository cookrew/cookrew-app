import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { attachmentIndex, sameAttachmentIndex, TerminalAttachmentsContext, type AttachmentIndex } from './terminal-attachments'
import { requestJoin } from './account/open-request'
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeChange,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  ReactFlowProvider
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AgentRole, CanvasNode, BrowserNodeData, TeamClipStatus, TerminalNodeData, WorkspaceState } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { TerminalActivity } from '../../shared/turn'
import { cookrew, isRemoteMode } from './api'
import { mergeActivity } from './turn-view-model'
import { isViewed, markViewed, pruneViewers, type ViewerClocks } from '../../shared/phone-viewing'
import { TerminalNode } from './nodes/TerminalNode'
import { NoteNode } from './nodes/NoteNode'
import { useWorkspaceWall } from './WorkspaceWallHost'
import { RoutingPanel, shouldAutoOpen } from './routing/RoutingPanel'
import { useRouteState } from './routing/use-route-state'
import { useSetupTerminal } from './routing/use-setup-terminal'
import { newestError } from './routing/newest-error'
import { BrowserNode } from './nodes/BrowserNode'
import { CableEdge } from './CableEdge'
import { Header, type MainView } from './Header'
import { BoardSearch } from './BoardSearch'
import { Dock } from './Dock'
import { tuningStore } from './tuning-store'
import { CardMenu, type CardMenuAnchor } from './CardMenu'
import { onCardMenuRequest } from './card-menu-request'
import { LodOverlays } from './LodOverlays'
import { browserInFullView } from './dock-target'
import { BrowserLayer, useInteractiveBrowserCapability } from './BrowserLayer'
import type { LodLayout } from './zoom-lod'
import {
  recordThumbFailure,
  recordThumbSuccess,
  shouldClearLegacyThumbs,
  shouldPollThumbs,
  snapshotPlan,
  shouldSnapshotLocally,
  thumbPollList,
  THUMB_BATCH_MAX,
  THUMB_BATCH_TIMEOUT_MS,
  applyThumbBatch,
  knownVersions,
  viewportBrowserIds,
  type ThumbBatchFrame,
  type ThumbBackoffs
} from './browser-thumb-policy'
import { retry } from './retry'
import { CanvasUiContext, ToolId } from './canvas-ui'
import {
  activityStore,
  thumbStore,
  useActivity,
  useActivityPhaseCount,
  ACTIVITY_SEED_DEADLINE_MS,
  markActivitySeeded
} from './activity-thumb-store'
import { reconcileFlowEdges, reconcileFlowNodes } from './flow-nodes'
import { carryGit } from './workspace-git-carry'
import { decodeBase64 } from './base64'
import {
  CARD_FIT_PADDING,
  CARD_ZOOM_MS,
  cardZoomMode,
  OVERVIEW_FIT_MS,
  OVERVIEW_FIT_PADDING
} from './nodes/card-zoom'
import {
  nodesZoomBounds,
  nodeZoomBounds,
  reportMissingZoomTarget,
  savesReturnViewport
} from './nodes/zoom-target'
import {
  createJumpController,
  reportJumpMiss,
  type JumpController
} from './cross-workspace-jump'
import { useBrowserEngine } from './browser-engine'
import { ErrorBoundary } from './ErrorBoundary'
import { ReauthOverlay } from './ReauthOverlay'
import { snapCardChanges, MOUSE_SNAP_PX, TOUCH_SNAP_PX, SnapGuide } from './card-snap'
import { SnapGuides } from './SnapGuides'
import { EventToastLayer } from './EventToast'
import { DoorMovedNotice } from './DoorMovedNotice'
import { TerminalSessionNotice } from './TerminalSessionNotice'
// Opened by a tap, never at boot: each panel is its own chunk (perf lane L7).
const MetricsPanel = lazy(() => import('./MetricsPanel').then((m) => ({ default: m.MetricsPanel })))
const StageView = lazy(() => import('./stage/StageView').then((m) => ({ default: m.StageView })))
import { GateSheet } from './GateSheet'
import { ImportServedSheet } from './ImportServedSheet'
import { SourcePicker } from './use/SourcePicker'
import { useAccountSurface } from './account/AccountSurface'
import { ConfirmClose } from './ConfirmClose'
import { apiPath } from './api-base'
import { planeFetch } from './plane-fetch'
import { authHeaders } from './auth-gate'
import { CrIcon } from './icons'
import { CommandBox } from './CommandBox'
import {
  canvasVisualModeOf,
  nextCanvasVisualMode,
  visibleCanvasEdges,
  visibleCanvasNodes,
  type CanvasVisualMode
} from './canvas-visual-mode'
import { CableHarness } from './CableHarness'
import { ownersOf, stageSelect, useStageSelection } from './stage/stage-select'
import { AgentPets } from './pets/AgentPets'
import { CrewProvider, WithCrew } from './stage/crew-rows'
import { ItemPets } from './pets/ItemPets'
import { thumbWants } from './pets/thumb-wants'
import { ZoomView } from './zoom/ZoomView'
import { useZoomFull } from './zoom/zoom-store'
import { zoomStore } from './zoom/zoom-store'
import { importTeam, makeAgent, makeItem, type Made } from './zoom/make-card'
import { attachView } from './attach-view'
import { installStatusChime } from './chime-sound'
import type { StageShowing } from './stage/StageView'

/** How often a headless browser card refreshes its still. Matches the legacy
 *  webview capture cadence — the same picture, from the page that now owns it. */
const BROWSER_SNAPSHOT_MS = 5000
const CANVAS_VISUAL_MODE_KEY = 'cookrew-canvas-visual-mode'

const VISUAL_MODE_LABEL: Record<CanvasVisualMode, string> = {
  all: 'All',
  harness: 'Cables tidied',
  'no-cables': 'Cables hidden',
  agents: 'Agents only'
}

const VISUAL_MODE_ICON: Record<CanvasVisualMode, 'canvas' | 'connect' | 'agent' | 'expand'> = {
  all: 'canvas',
  harness: 'connect',
  'no-cables': 'connect',
  agents: 'agent'
}

/**
 * The view a window opens on: the stage, always (2026-10-30). Canvas and
 * board are merged into it, and the board came back as the header's search
 * box (BoardSearch.tsx, 2026-11-01). The levels view is deleted (2026-10-31).
 */
const MAIN_VIEW_KEY = 'cookrew-main-view'

function storedMainView(): MainView {
  return 'stage'
}

/** The browser host's layout with the canvas retired: no card is zoomed, so no rects. */
const NO_CANVAS_LOD: LodLayout = { activeIds: new Set(), rects: {}, primaryId: null }

function storedCanvasVisualMode(): CanvasVisualMode {
  try {
    return canvasVisualModeOf(window.localStorage.getItem(CANVAS_VISUAL_MODE_KEY))
  } catch {
    return 'all'
  }
}

/** Phone companion parity: widen the snap magnet for finger-driven gestures. */
const snapRadiusPx = window.matchMedia('(pointer: coarse)').matches ? TOUCH_SNAP_PX : MOUSE_SNAP_PX

/** Two viewports are "the same" when restoring one wouldn't move the canvas. */
function sameViewport(
  a: { x: number; y: number; zoom: number },
  b: { x: number; y: number; zoom: number }
): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.01
}

/**
 * MiniMap node attributes as FUNCTIONS, module-level so their identity never
 * changes. React Flow wraps a string value in a fresh arrow on every MiniMap
 * render and passes that to its memo'd per-node components, so with the
 * defaults all 170 minimap nodes re-rendered on every commit. The colour is
 * applied INLINE by the library (it beats the .cookrew-minimap rule in
 * styles.css), so it names the same token that rule does.
 */
const minimapNodeColor = (): string => 'var(--line-soft)'
const minimapNodeStrokeColor = (): string => 'transparent'
const minimapNodeClassName = (): string => ''

const nodeTypes = { terminal: TerminalNode, note: NoteNode, browser: BrowserNode }
const edgeTypes = { cable: CableEdge }

/** The ids ReactFlow currently marks selected — carried across a reconcile. */
function selectedIds(nodes: Node[]): Set<string> {
  return new Set(nodes.filter((n) => n.selected).map((n) => n.id))
}


function Canvas(): React.JSX.Element {
  const interactiveCapability = useInteractiveBrowserCapability()
  const interactiveBrowser = interactiveCapability?.enabled ?? null
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const zoomFull = useZoomFull()
  /** The stage's pick: in a browser's or note's full view, which one it is (the side groups attach around it). */
  const stagePick = useStageSelection()
  const [nodes, setNodes] = useState<Node[]>([])
  const [canvasVisualMode, setCanvasVisualMode] = useState<CanvasVisualMode>(storedCanvasVisualMode)
  const [tool, setTool] = useState<ToolId>('move')
  /**
   * Clipboard selection mode — a TOGGLE over the resting hand (the board
   * view's model), not a tool: cards stay draggable, clicking a card picks
   * it, clicking it again cancels.
   */
  const [clipping, setClipping] = useState(false)
  /** The clipboard's picked card ids — the unit of copy/cut/save/paste. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** Card under the cursor while clipping; its cables light up with it. */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** Open card edit menu (right-click / long-press on a card). */
  const [cardMenu, setCardMenu] = useState<CardMenuAnchor | null>(null)
  /** The stage element — the long-press gesture listens on it. */
  const stageRef = useRef<HTMLDivElement>(null)
  /** Clipboard status lifted from the bar — drives the paste ghosts. */
  const [clipInfo, setClipInfo] = useState<TeamClipStatus | null>(null)
  /** Active workspace id (state objects carry none; names can collide). */
  const [activeWsId, setActiveWsId] = useState<string | null>(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [preset, setPreset] = useState('Shell')
  const [orch, setOrch] = useState(false)
  const [presets, setPresets] = useState<string[]>(['Shell'])
  const [templates, setTemplates] = useState<string[]>([])
  const [roles, setRoles] = useState<AgentRole[]>([])
  /** Selected saved role for TERMINAL placement, or null for a plain preset. */
  const [role, setRole] = useState<string | null>(null)
  // Per-terminal activity + per-browser thumbnails live in an external per-id
  // store (activity-thumb-store), NOT React state on this context — a stream of
  // activity events must not re-render every card, and not this component
  // either: it subscribes to two COUNTS (below) and to the one card a dialog
  // is about; the dock and the overlays subscribe per id themselves.
  /** Alignment guides while a card resize is snapped to a neighbour edge. */
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** Terminal whose overlay owns the stage — the dock shows its composer. */
  const [zoomedTerminalId, setZoomedTerminalId] = useState<string | null>(null)
  // PHONE MEMORY DIET (2026-08-27): while an overlay owns the stage, the
  // canvas underneath it is pure ballast — 39 cards, edges and a minimap of
  // iOS layer backing pressing against the same 1536 MB jetsam cap the
  // overlay's own weight needs. display:none (via this body class) drops
  // their render objects and backing stores; React state is untouched and
  // the canvas reappears the instant the overlay closes. Remote only.
  useEffect(() => {
    if (!isRemoteMode()) return
    document.body.classList.toggle('cr-overlay-owns-stage', zoomedTerminalId !== null)
    return () => document.body.classList.remove('cr-overlay-owns-stage')
  }, [zoomedTerminalId])
  /** Global agent roster panel (opened from the header). */
  /**
   * Which of the two main views the stage shows. The agents view renders as a
   * full-bleed overlay INSIDE the stage rather than replacing it: the canvas
   * owns live webviews and terminal panes that must never remount, and swapping
   * it out of the tree would also drop the viewport transform.
   */
  const [view, setView] = useState<MainView>(storedMainView)
  useEffect(() => {
    if (view !== 'stage') return
    try {
      window.localStorage.setItem(MAIN_VIEW_KEY, view)
    } catch {
      // Storage blocked: the next window opens on the stage, the default.
    }
  }, [view])
  /** The agent on the stage: the dock's composer and the route follow it. */
  const [stageShowing, setStageShowing] = useState<StageShowing | null>(null)
  /** Activity metrics / history panel (opened from the workspace popout). */
  const [metricsOpen, setMetricsOpen] = useState(false)
  /**
   * Node awaiting a close confirmation. Every ✕ routes here instead of calling
   * removeNode, so there is one dialog and no close button can skip it.
   */
  const [closingId, setClosingId] = useState<string | null>(null)
  // R30 import side: the one entry for a served team's address.
  const [importServedOpen, setImportServedOpen] = useState(false)
  /** An address that arrived by `cookrew://` link, for the sheet to look up. */
  const [importPrefill, setImportPrefill] = useState<string | null>(null)
  const closeImportServed = useCallback((): void => {
    setImportServedOpen(false)
    setImportPrefill(null)
  }, [])
  useEffect(() => {
    void cookrew()
      .listPresets()
      .then((list) => setPresets(list.map((p) => p.name)))
    // Saved roles ride alongside presets as terminal-creation options.
    void cookrew().roleList().then(setRoles).catch(() => undefined)
    // Saved templates ARE presets too, but placing one imports a session
    // instead of dropping a terminal — so the placement path must tell them
    // apart. Kept as a name set, refreshed on save.
    void cookrew().teamList?.().then((list) => setTemplates(list.map((t) => t.name))).catch(() => undefined)
  }, [])

  // Track the active workspace ID — the paste ghosts only show for a
  // CROSS-workspace paste, and comparing names would lie on collisions.
  useEffect(() => {
    void cookrew()
      .listWorkspaces()
      .then((list) => noteActiveWorkspace(list.activeId))
      .catch(() => undefined)
    return cookrew().onWorkspaceList((list) => noteActiveWorkspace(list.activeId))
  }, [])

  /* ── THE SCREEN WALL (WorkspaceWall.tsx, hosted by WorkspaceWallHost.tsx) ──
   * Switching by NAME asks people to remember the one thing about a workspace
   * nobody does. The wall shows each one as a tilted screen carrying a
   * snapshot of its canvas, and you pick the picture — and it is where a
   * workspace is made, given directories or removed, too. */
  const wall = useWorkspaceWall({
    stageRef,
    workspace,
    onActivity: () => setMetricsOpen(true),
    onArrived: () => zoomStore.go(1, 'agents')
  })
  useEffect(() => onCardMenuRequest(setCardMenu), [])
  // R1 · the Routing panel: the gateway's state (pushed), the Setup card its
  // buttons type into, and one self-opening on first boot while nothing is
  // installed. Everything else about it is a menu entry in the header.
  const routeState = useRouteState()
  const setupTerminal = useSetupTerminal(workspace)
  const [routingOpen, setRoutingOpen] = useState(false)
  useEffect(() => {
    if (routeState.state && shouldAutoOpen(routeState.state.status, window.localStorage)) setRoutingOpen(true)
  }, [routeState.state])
  // The panel opening is the owner looking: ask main once, so a renderer that
  // fell behind the gateway shows the default the owner actually has.
  const rereadRoute = routeState.reread
  useEffect(() => {
    if (routingOpen) rereadRoute()
  }, [routingOpen, rereadRoute])
  const cardNames = useMemo(() => new Map((workspace?.nodes ?? []).map((n) => [n.id, n.name])), [workspace?.nodes])
  /**
   * A workspace switch replaces every node while the viewport still frames the
   * OUTGOING canvas — so the incoming workspace opens somewhere off in empty
   * space and the user has to hunt for their own agents. Fit the view on
   * arrival.
   *
   * Armed here, fired below, because the switch lands as TWO broadcasts: the
   * store emits 'workspaces' (the new activeId) before 'change' (the new
   * nodes). Fitting the moment the id changes would frame the canvas we are
   * leaving. Arming happens in the message callback rather than in an effect
   * so it rides that delivery order directly, instead of on whichever renders
   * React chooses to batch the two updates into.
   */
  const fitPendingRef = useRef(false)
  /**
   * The board's cross-workspace tap. A ref because the arrival fit declared
   * just below reads it, while the controller itself is built much further
   * down, where the zoom it needs exists. A jump is what ASKED for the switch,
   * so the fit that switch would have done is the jump's to spend: it has a
   * better destination than the overview, and hands the fit back if its card
   * never arrives.
   */
  const jumpRef = useRef<JumpController<Node> | null>(null)
  const knownWsIdRef = useRef<string | null>(null)
  const reactFlow = useReactFlow()
  const browsersRef = useRef<BrowserNodeData[]>([])
  const draggingRef = useRef(false)
  /** Viewport before the last zoomToNode, so ⤢ CANVAS can return to it. */
  const prevViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null)
  /** Node currently zoomed into full view — drives layered ⌘W. */
  const zoomedNodeIdRef = useRef<string | null>(null)
  /**
   * The card whose zoom animation has FINISHED. Distinct from the zoomed card:
   * this one says the viewport has come to rest on it, which is what lets its
   * full view mount without waiting out the LOD's settle debounce.
   */
  const [arrivedId, setArrivedId] = useState<string | null>(null)
  /**
   * The overlay winner (terminal or browser), as LodOverlays last reported it.
   * Canvas no longer runs the arbitration itself — that hook re-renders its
   * host on every viewport frame, and this host is the whole app.
   */
  const [overlayPrimaryId, setOverlayPrimaryId] = useState<string | null>(null)
  const clearArrived = useCallback(() => setArrivedId(null), [])
  /**
   * Did the user DELIBERATELY zoom into a card (tap → zoomToNode)? On mobile the
   * overview is zoomed in to bound rendered-node count (OOM fix), so a large
   * card there would passively cross the LOD coverage threshold and auto-open,
   * trapping the view. Gate the auto-open on this: false in the overview, true
   * after a tap, false again on Back. Desktop ignores it (allowAutoOpen stays
   * true there) so its zoom-into-a-card behaviour is unchanged.
   */
  const deliberateOpenRef = useRef(false)
  /** Mirror of zoomedTerminalId so callbacks/handlers can read it fresh. */
  const zoomedTerminalIdRef = useRef<string | null>(null)
  zoomedTerminalIdRef.current = zoomedTerminalId
  /** Latest ⌘W handler; a stable subscription calls through this ref. */
  const cmdWRef = useRef<() => void>(() => undefined)

  /**
   * Record the active workspace, and arm a fit when it CHANGED. The first id
   * we learn is the workspace already on screen, not a switch — fitting there
   * would fight the viewport the canvas restored on load.
   */
  const noteActiveWorkspace = (id: string): void => {
    const previous = knownWsIdRef.current
    knownWsIdRef.current = id
    setActiveWsId(id)
    if (previous === null || previous === id) return
    // The outgoing canvas is gone either way, so the saved "back" viewport
    // points at cards that no longer exist; ⤢ / ESC must fall back to the
    // overview rather than restore a dead frame.
    prevViewportRef.current = null
    // WHOSE SWITCH IS THIS. A jump asked for this one and is arriving at a
    // CARD, not at a workspace — so none of the resets below are right for it,
    // and the store's two broadcasts give no order to lean on: when the nodes
    // beat the id here, the jump has ALREADY zoomed and these lines would undo
    // it. No arrival, so no full view; no deliberate flag, so the phone's LOD
    // refuses to open the card; and an armed fit left over for the next node
    // change to spend on the overview.
    if (jumpRef.current?.claims(id) === true) return
    fitPendingRef.current = true
    zoomedNodeIdRef.current = null
    // …and so do the auto-open credentials. Left armed, the switch's fitView
    // settling would passively mount whatever card crosses the coverage floor
    // on the NEW canvas — the exact trap deliberateOpenRef exists to prevent
    // (Pilot's phone-crash hunt, 2026-08-27, section 3).
    deliberateOpenRef.current = false
    setArrivedId(null)
  }

  useBrowserEngine()

  /**
   * Load the canvas from the server, replacing whatever is on screen.
   *
   * RETRIED, because this is the only pull the canvas ever makes: a phone
   * asks at the worst moment (screen just unlocked, tailnet still coming up,
   * desktop app mid-restart) and one missed answer used to leave it showing an
   * empty workspace until the user reloaded the page.
   */
  const loadWorkspace = useCallback(
    () =>
      retry(() => cookrew().getWorkspace())
        .then((state) => {
          setWorkspace(state)
          setNodes((prev) => reconcileFlowNodes(prev, state.nodes, selectedIds(prev)))
        })
        .catch((error: unknown) => {
          console.error('Could not load the workspace:', error)
        }),
    []
  )

  /**
   * IDENTITY (v2, phase 1). One hook: the avatar for the header's brand group
   * and the sheets/lock overlay. Feature-detected — on the phone companion and
   * in a demo tab both are null and nothing about the canvas changes.
   */
  const account = useAccountSurface()

  /**
   * Bring a stale client back in step — the push channel is re-established
   * (a dead one delivers nothing and never says so) and the canvas re-pulled.
   * Reached from the brand mark, and automatically when the page returns to
   * the foreground or the network comes back.
   */
  const resync = useCallback((): void => {
    cookrew().reconnect?.()
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    void loadWorkspace()
    return cookrew().onWorkspaceState((pushed) => {
      // The push carries the raw canvas; only the pull embeds each terminal's
      // git state. Carry what the previous state held, or every card would
      // lose its chip on the first change and fetch it back one by one (L7).
      const state = carryGit(workspaceRef.current, pushed)
      setWorkspace(state)
      // Selection must SURVIVE the rebuild (reconcileFlowNodes carries no
      // `selected` of its own), so it is re-applied from the previous nodes —
      // including the N broadcasts a duplicate-in-place itself fires, which
      // would otherwise unmount the SelectionBar before its own success renders.
      // reconcileFlowNodes ALSO preserves identity for unchanged nodes, so a
      // single-node broadcast re-renders a single card, not all 91.
      if (!draggingRef.current) {
        setNodes((prev) => reconcileFlowNodes(prev, state.nodes, selectedIds(prev)))
      }
    })
  }, [loadWorkspace])

  /**
   * A phone spends most of its life asleep. Coming back to the foreground (or
   * back onto the network) is exactly when its push channel may already have
   * been reaped without notice — so re-establish it and re-pull the canvas
   * rather than trusting what is on screen.
   */
  useEffect(() => {
    if (!isRemoteMode()) return
    const onVisible = (): void => {
      if (!document.hidden) resync()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', resync)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', resync)
    }
  }, [resync])

  /**
   * FRAME THE WHOLE BOARD — the one overview fit, and NOT `reactFlow.fitView`.
   *
   * D1, canvas QA 2026-09-07. fitView queues itself behind `nodesInitialized`,
   * which `onlyRenderVisibleElements` holds false whenever a card is off
   * screen (see zoomToNode). From the overview every card is on screen, so the
   * fit happens to work there and the defect looked like a zoom-to-CARD bug —
   * but the same call from a zoomed-in state (⤢ CANVAS with no saved viewport,
   * a workspace switch) is inert, and the fit it left QUEUED is what fires
   * later on an unrelated node update and lands on the previously tapped card.
   * fitBounds calls panZoom directly and cannot be deferred.
   */
  const fitAll = useCallback(
    (duration: number): void => {
      const bounds = nodesZoomBounds(reactFlow.getNodes())
      if (bounds === null) return
      void reactFlow.fitBounds(bounds, { duration, padding: OVERVIEW_FIT_PADDING })
    },
    [reactFlow]
  )

  // Fire the armed fit, one frame after the incoming nodes are committed —
  // React Flow measures a node on layout, and fitting before that measurement
  // frames the cards at a stale size.
  useEffect(() => {
    if (!fitPendingRef.current) return
    fitPendingRef.current = false
    // A jump asked for this switch and owes the owner one particular card, so
    // the overview is not where they are going. Spending the fit here would
    // frame the whole board for a beat and then throw the viewport across it.
    if (jumpRef.current?.travelling() === true) return
    // An empty workspace has nothing to frame; fitView would be a no-op that
    // still costs an animation, so leave the viewport where it is.
    if (nodes.length === 0) return
    const frame = requestAnimationFrame(() => {
      // Frame the WHOLE board, phone included — the user must be able to see all
      // their agents at a glance. This is only affordable because every card
      // renders a LIGHT mini tile when zoomed out (TerminalNode/NoteNode/
      // BrowserNode mini paths: no markdown, no decoded thumbnails), so 90 tiles
      // at the overview no longer OOM iOS Safari.
      fitAll(OVERVIEW_FIT_MS)
    })
    return () => cancelAnimationFrame(frame)
  }, [nodes, fitAll])

  useEffect(() => {
    void cookrew()
      .listActivity()
      .then((list) =>
        // Live events may land before this snapshot resolves — seed under
        // existing entries so the snapshot never clobbers fresher activity.
        activityStore.seed(
          list.map((a) => [a.terminalId, a] as [string, TerminalActivity]),
          true
        )
      )
      // A refused snapshot (route scoping, transient network) must stay a
      // missing seed, never an unhandled rejection — live events still fill
      // the store.
      .catch(() => undefined)
      // Either way the cards may now decide whether they are idle; before
      // this they must not read their tails (use-stream-tails, L7).
      .finally(markActivitySeeded)
    // A snapshot that hangs must not hold every card's preview forever: past
    // this the seed is declared and the cards fall back to how they behaved
    // before the gate existed.
    const seedDeadline = setTimeout(markActivitySeeded, ACTIVITY_SEED_DEADLINE_MS)
    const off = cookrew().onTerminalActivity((activity) => {
      activityStore.set(activity.terminalId, mergeActivity(activityStore.get(activity.terminalId), activity))
    })
    return () => {
      clearTimeout(seedDeadline)
      off()
    }
  }, [])

  // A chime when an agent finishes or needs you (status-chime.ts decides when).
  useEffect(() => installStatusChime(), [])

  // WHAT EACH AGENT IS RUNNING ON (tuning-store). One snapshot for the whole
  // fleet, then a push per card when — and only when — its dials change. The
  // phone runs this same effect over its own transport (/api/tuning + the
  // stream's `tuning` frame); feature-detected so a bridge without either
  // leaves every card wearing no tag rather than throwing.
  useEffect(() => {
    const snapshot = cookrew().listTuning
    if (snapshot) {
      void snapshot()
        .then((rows) =>
          // Live pushes may land first; seed UNDER them so the snapshot never
          // replaces a fresher reading (same rule as the activity seed).
          tuningStore.seed(Object.entries(rows), true)
        )
        .catch(() => undefined)
    }
    return cookrew().onTerminalTuning?.((row) => tuningStore.set(row.terminalId, row.tuning))
  }, [])

  // ⌘W from the main process, resolved against the latest layer state.
  useEffect(() => cookrew().onCmdW(() => cmdWRef.current()), [])

  // A `cookrew://` link the OS handed to the app, parsed by main
  // (src/main/deep-link.ts). Every verb lands on a sheet a person could have
  // opened themselves, and the sheet still asks before anything is placed.
  useEffect(
    () =>
      cookrew().onDeepLink((link) => {
        if (link.verb === 'import') {
          // `session=new` is read and set aside: the import path has no such
          // option (a session is minted per caller at the door, every time).
          setImportPrefill(link.address)
          setImportServedOpen(true)
          return
        }
        if (link.verb === 'install') {
          // No in-app surface takes a preset id yet; the marketplace entry
          // the app does have is the import sheet, so the link opens that.
          setImportPrefill(null)
          setImportServedOpen(true)
          return
        }
        if (link.verb === 'join') {
          // D8: the account surface owns the card that spends a code. It is
          // asked rather than rendered here, because the bridge holds one
          // deep-link subscriber and this component is it.
          requestJoin(link.code)
          return
        }
        // 'serve' would open the share sheet for a saved template; that sheet
        // exists only on a selection today, so the link is set aside.
      }),
    []
  )

  // A file dropped outside a terminal overlay would make Chromium navigate
  // to it, killing the app — swallow drags at the window level so only the
  // overlays' own drop handlers (which run first) see them.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  // Cables light up with the hovered card while clipping — the hover tells
  // you what would travel with the selection before you commit to it. Split
  // memos so resting-hand hovers never rebuild the edge set.
  // Reconciled, not rebuilt: a workspace broadcast is a fresh object even when
  // no cable changed, and rebuilding the edge list from it handed all 232
  // EdgeWrappers new identity on every agent event (perf lane L6).
  const baseEdgesRef = useRef<Edge[]>([])
  const baseEdges = useMemo(() => {
    const next = reconcileFlowEdges(baseEdgesRef.current, workspace?.connections ?? [])
    baseEdgesRef.current = next
    return next
  }, [workspace?.connections])
  const edges = useMemo(() => {
    if (!clipping || hoverId === null) return baseEdges
    return baseEdges.map((e) =>
      e.source === hoverId || e.target === hoverId ? { ...e, data: { hot: true } } : e
    )
  }, [baseEdges, clipping, hoverId])
  const renderedNodes = useMemo(
    () => visibleCanvasNodes(nodes, canvasVisualMode),
    [nodes, canvasVisualMode]
  )
  const renderedEdges = useMemo(
    () => visibleCanvasEdges(edges, canvasVisualMode),
    [edges, canvasVisualMode]
  )
  const cycleCanvasVisualMode = useCallback((): void => {
    const next = nextCanvasVisualMode(canvasVisualMode)
    setCanvasVisualMode(next)
    setCardMenu(null)
    try {
      window.localStorage.setItem(CANVAS_VISUAL_MODE_KEY, next)
    } catch {
      // The view still works when browser storage is unavailable.
    }
  }, [canvasVisualMode])

  const togglePick = useCallback((id: string): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Picked ids must track the canvas: a cut-pasted (removed) card, or a
  // workspace switch, prunes itself out — never a stale id in the clipboard
  // spec. Toggling the clipboard off keeps the picks (the board view keeps
  // them too): re-entering finds the slate as it was left.
  useEffect(() => {
    if (!workspace) return
    setPicked((prev) => {
      const alive = new Set(workspace.nodes.map((n) => n.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [workspace])
  useEffect(() => {
    if (!clipping) setHoverId(null)
  }, [clipping])
  /** Mirrors for the ⌘A handler (stable subscription, fresh reads). */
  const viewRef = useRef<MainView>(view)
  viewRef.current = view
  const clippingRef = useRef(clipping)
  clippingRef.current = clipping
  // Long-press on a card = right-click: the touch path into the card edit
  // menu. 550ms hold with a 10px slop, touch pointers only; interactive
  // descendants (buttons, editors, the live terminal) keep their own
  // gestures. The synthetic click that follows the release is swallowed so
  // the card doesn't zoom out from under the fresh menu.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let timer: number | null = null
    let sx = 0
    let sy = 0
    let suppressClick = false
    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      const target = e.target as HTMLElement | null
      if (
        !target ||
        target.closest('button, input, textarea, select, a, .xterm, [contenteditable="true"]')
      ) {
        return
      }
      const nodeEl = target.closest('[data-card-id]') as HTMLElement | null
      const nodeId = nodeEl?.dataset.cardId
      if (!nodeId) return
      sx = e.clientX
      sy = e.clientY
      timer = window.setTimeout(() => {
        timer = null
        suppressClick = true
        setCardMenu({ nodeId, x: sx, y: sy })
        // No release-click may follow (pointercancel) — don't eat a later one.
        window.setTimeout(() => {
          suppressClick = false
        }, 800)
      }, 550)
    }
    const onMove = (e: PointerEvent): void => {
      if (timer === null) return
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (!suppressClick) return
      suppressClick = false
      e.preventDefault()
      e.stopPropagation()
    }
    stage.addEventListener('pointerdown', onDown, true)
    stage.addEventListener('pointermove', onMove, true)
    stage.addEventListener('pointerup', cancel, true)
    stage.addEventListener('pointercancel', cancel, true)
    stage.addEventListener('click', onClick, true)
    return () => {
      cancel()
      stage.removeEventListener('pointerdown', onDown, true)
      stage.removeEventListener('pointermove', onMove, true)
      stage.removeEventListener('pointerup', cancel, true)
      stage.removeEventListener('pointercancel', cancel, true)
      stage.removeEventListener('click', onClick, true)
    }
  }, [])

  // ⌘K is the one box (CommandBox): the command line to Sous and the inbox.
  // Toggles anywhere but inside a terminal, where ⌘K is the terminal's.
  // Same guard as ⌘A: never while typing somewhere else. Focus goes back to
  // where it was when the box closes.
  const [commandOpen, setCommandOpen] = useState(false)
  const commandReturnFocus = useRef<HTMLElement | null>(null)
  const closeCommand = useCallback(() => {
    setCommandOpen(false)
    const back = commandReturnFocus.current
    commandReturnFocus.current = null
    if (back && back.isConnected) back.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
      const target = e.target as HTMLElement | null
      if (target?.closest('.cmd')) {
        e.preventDefault()
        closeCommand()
        return
      }
      if (target?.closest('input, textarea, [contenteditable="true"], .xterm')) return
      e.preventDefault()
      setCommandOpen((v) => {
        if (!v) commandReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        return !v
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeCommand])

  // Open a card: on the stage, wherever it was asked for from.
  const zoomToNode = useCallback(
    (
      id: string,
      rect?: { x: number; y: number; width: number; height: number },
      /**
       * The canvas under this zoom is not the one the viewport was framing: a
       * board row from another workspace, landing on a canvas that arrived a
       * moment ago. See savesReturnViewport — it decides what Back means here.
       */
      freshCanvas = false
    ) => {
      // A card asked for from anywhere (the pets, the command box, a toast,
      // the board) takes the stage's middle: a browser or note as itself,
      // anything else as the agent. One from another workspace says so on the
      // stage (StageTerminal) until that workspace is switched to. The canvas
      // is retired (2026-10-30) and is not rendered, so there is nowhere else.
      const asked = workspaceRef.current?.nodes.find((n) => n.id === id)
      const item = asked?.kind === 'browser' || asked?.kind === 'note'
      stageSelect.set(item ? { kind: 'item', id } : { kind: 'agent', id })
      zoomStore.jumpTo(item ? 'item' : 'agent', id)
      if (viewRef.current !== 'stage') setView('stage')
      // The canvas's own arguments (a just-created card's rect, a board row
      // landing on a canvas that just arrived) have nothing left to frame.
      void rect
      void freshCanvas
    },
    []
  )

  const zoomBack = useCallback(() => {
    const previous = prevViewportRef.current
    prevViewportRef.current = null
    zoomedNodeIdRef.current = null
    setArrivedId(null)
    // Back to the overview: the LOD must not re-open the card we are leaving.
    deliberateOpenRef.current = false
    // Restoring a saved viewport that equals the current one wouldn't move the
    // canvas — we'd stay zoomed (the loop). Fall back to the overview fit so
    // Back always escapes. That fallback fires from a ZOOMED-IN viewport, which
    // is precisely where fitView was inert (D1) — hence fitAll, not fitView.
    if (previous && !sameViewport(previous, reactFlow.getViewport())) {
      void reactFlow.setViewport(previous, { duration: OVERVIEW_FIT_MS })
    } else {
      fitAll(OVERVIEW_FIT_MS)
    }
  }, [reactFlow, fitAll])

  /**
   * THE BOARD'S CROSS-WORKSPACE TAP. The board lists every agent on the
   * machine; the canvas holds one workspace at a time. A row from anywhere
   * else needs a switch before there is a card to fly to, and the switch
   * arrives as a broadcast the tap cannot await — so the intent waits here
   * (cross-workspace-jump.ts) and lands when the canvas carrying the card
   * shows up.
   *
   * Built once and steered through refs: `zoomToNode` and `fitAll` are stable
   * callbacks, and rebuilding the controller would drop a jump in flight.
   */
  const jump = useMemo(
    () =>
      createJumpController<Node>({
        activeWorkspaceId: () => knownWsIdRef.current,
        hasNode: (nodeId) => reactFlow.getNode(nodeId) !== undefined,
        switchWorkspace: (workspaceId) => cookrew().switchWorkspace(workspaceId),
        arrive: (nodeId, node) => {
          // A landed jump brings its node: the canvas was handed to us this
          // instant, and the card's own declared box needs no measurement —
          // which is what the flow store would still be waiting on. It is also
          // what says this canvas is a fresh one, so the viewport we came in
          // with is not a place Back can return to.
          zoomToNode(nodeId, nodeZoomBounds(node) ?? undefined, node !== null)
        },
        handBack: () => {
          // The jump is over and no card is opening, so give the switch the
          // arrival it was denied when the jump claimed it: nothing is zoomed,
          // nothing may auto-open, and the board gets framed.
          zoomedNodeIdRef.current = null
          deliberateOpenRef.current = false
          setArrivedId(null)
          fitAll(OVERVIEW_FIT_MS)
        },
        schedule: (run, ms) => {
          const timer = window.setTimeout(run, ms)
          return () => window.clearTimeout(timer)
        },
        report: reportJumpMiss
      }),
    [zoomToNode, fitAll, reactFlow]
  )
  jumpRef.current = jump

  // The incoming canvas, offered to the jump. Declared after the fit above so
  // it runs after it: the fit stands down for a jump in flight, and then this
  // is what lands it — one commit, one viewport move.
  useEffect(() => jump.sawNodes(nodes), [nodes, jump])

  // Dropping the canvas must drop the travel with it: a zoom that fires into
  // an unmounted tree is the kind of thing that outlives its own reason.
  useEffect(() => () => jump.cancel(), [jump])

  const requestClose = useCallback((nodeId: string) => setClosingId(nodeId), [])

  // Sous at the wheel (shared/sous-ui): main has already switched the
  // workspace and placed the card; this is the VIEW catching up. No workspace
  // check on purpose — the command can outrun the workspace:state it follows,
  // and a zoom to a card that is not here yet falls back to fitView, which is
  // the same place zoom-back lands. focus-input is a zoom too: the full view
  // hands focus to the terminal on open.
  useEffect(
    () =>
      cookrew().onUiCommand((event) => {
        const command = event.command
        if (command.kind === 'zoom-back') zoomBack()
        else zoomToNode(command.nodeId)
      }),
    [zoomToNode, zoomBack]
  )

  /** The dock is making a card (zoom/make-card.ts), and why the last one failed. */
  const [making, setMaking] = useState(false)
  const [makeError, setMakeError] = useState<string | null>(null)
  const makingRef = useRef(false)
  /**
   * Dock tool selection. There is no MOVE button — the resting hand is what
   * every tool falls back to: re-clicking the active tool stands it down,
   * and arming a placement tool always stands the clipboard down (one
   * click-target contract at a time).
   */
  const selectTool = useCallback((next: ToolId) => {
    setTool((prev) => (prev === next ? 'move' : next))
    setClipping(false)
    setMakeError(null)
  }, [])
  /**
   * The dock MAKES, it no longer places (the canvas is retired): a chip or
   * NOTE / BROWSER makes its card at once in the active workspace, through
   * the crew seat's own path (zoom/make-card.ts). One at a time, so a double
   * press makes one card.
   */
  const make = useCallback(async (run: () => Promise<Made>) => {
    if (makingRef.current) return
    makingRef.current = true
    setMaking(true)
    setMakeError(null)
    const made = await run()
    makingRef.current = false
    setMaking(false)
    if (made.ok) setTool('move')
    else setMakeError(made.error)
  }, [])
  /** The clipboard toggle: arming it stands any placement tool down. */
  const toggleClipping = useCallback(() => {
    setClipping((prev) => {
      if (!prev) setTool('move')
      return !prev
    })
  }, [])

  /**
   * Carry out a confirmed close. Un-zoom FIRST: the overlay is anchored to a
   * card that is about to stop existing, and leaving the stage zoomed onto a
   * gap is how you end up unable to see the canvas you just returned to.
   */
  const confirmClose = useCallback(
    (nodeId: string) => {
      setClosingId(null)
      if (zoomedNodeIdRef.current === nodeId) zoomBack()
      void cookrew().removeNode(nodeId)
    },
    [zoomBack]
  )

  /**
   * The browser cards the screen can see, in flow space — the one set both
   * picture producers are bounded by (the desktop's sweep and the phone's
   * poll). A picture nobody can see is a picture nobody should pay for.
   */
  const visibleBrowserIds = useCallback((): string[] => {
    const topLeft = reactFlow.screenToFlowPosition({ x: 0, y: 0 })
    const bottomRight = reactFlow.screenToFlowPosition({ x: window.innerWidth, y: window.innerHeight })
    return viewportBrowserIds(
      reactFlow.getNodes().map((n) => ({
        id: n.id,
        kind: n.type ?? '',
        x: n.position.x,
        y: n.position.y,
        // Unmeasured on the first tick: fall back to the card's own size,
        // or a zero-width card would miss the viewport it is plainly in.
        width: n.measured?.width ?? n.width ?? (n.data as { node?: { size?: { width: number } } }).node?.size?.width ?? 0,
        height: n.measured?.height ?? n.height ?? (n.data as { node?: { size?: { height: number } } }).node?.size?.height ?? 0
      })),
      { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y }
    )
  }, [reactFlow])

  const onThumb = useCallback((id: string, dataUrl: string) => {
    if (interactiveBrowser !== false) return
    thumbStore.set(id, dataUrl)
    // Mirror to main so the mobile companion can serve it to the phone.
    cookrew().browserThumb(id, dataUrl)
  }, [interactiveBrowser])

  /**
   * Card thumbnails with the flag ON. The legacy loop captured a webview that
   * no longer exists here, so every browser card sat on its placeholder; the
   * picture now comes from the headless page that owns the tab.
   *
   * ONLY WHAT THE SCREEN SHOWS. This used to walk every browser on the canvas
   * — at mount and every five seconds — which on a board of forty browsers is
   * forty CDP screenshots through main before anything is looked at. It now
   * takes the same plan the phone's poll takes (snapshotPlan): the visible
   * cards, none at mini, never the zoomed one (its card is behind the live
   * view), capped. A card scrolled into view is photographed on the next tick.
   */
  useEffect(() => {
    if (!shouldSnapshotLocally({ remote: isRemoteMode(), interactive: interactiveBrowser })) return
    const snapshot = cookrew().browserSnapshot
    if (!snapshot) return
    let disposed = false
    const tick = async (): Promise<void> => {
      // The browsers whose faces the item pets show (pets/thumb-wants.ts):
      // with the canvas retired there is no viewport to ask.
      const ids = snapshotPlan({
        zoom: 'card',
        hidden: document.hidden,
        visible: thumbWants.ids(),
        zoomedId: zoomedNodeIdRef.current,
        max: THUMB_BATCH_MAX
      })
      for (const id of ids) {
        if (disposed) return
        const dataUrl = await snapshot(id).catch(() => null)
        if (!disposed && dataUrl) {
          // A handed-off live frame is a blob; replacing one must revoke it,
          // exactly as the poll path does. set() dedupes identical strings.
          const old = thumbStore.get(id)
          if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
          thumbStore.set(id, dataUrl)
        }
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), BROWSER_SNAPSHOT_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [interactiveBrowser, reactFlow, visibleBrowserIds])

  // Never retain a legacy frame once ownership resolves to headless. Browser
  // cards remain neutral until their shared stream is opened in the popout.
  // Desktop only: a phone holds POLLED frames here, and wiping (and revoking)
  // those is how its cards went blank.
  useEffect(() => {
    if (!shouldClearLegacyThumbs({ remote: isRemoteMode(), interactive: interactiveBrowser })) return
    thumbStore.clear((src) => {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src)
    })
  }, [interactiveBrowser])

  // In flag-off mode, a phone polling /thumb must keep the desktop webview
  // capture alive while hidden. Main pings on every poll; keep a TTL per
  // browser and hand the capture loop a stable getter. Headless streams do not
  // use this legacy path. Remote/demo APIs no-op the subscription.
  const phoneViewingRef = useRef<ViewerClocks>({})
  useEffect(
    () =>
      cookrew().onBrowserPhoneViewing((browserId) => {
        phoneViewingRef.current = markViewed(phoneViewingRef.current, browserId, Date.now())
      }),
    []
  )
  // Drop lapsed/junk viewer ids so an unauth LAN client polling /thumb with
  // random ids can't grow the map without bound.
  useEffect(() => {
    const t = setInterval(() => {
      phoneViewingRef.current = pruneViewers(phoneViewingRef.current, Date.now())
    }, 30_000)
    return () => clearInterval(t)
  }, [])
  const isPhoneViewing = useCallback(
    (browserId: string) => isViewed(phoneViewingRef.current, browserId, Date.now()),
    []
  )

  // Remote browser-card thumbs are polled from main, under EITHER owner: the
  // desktop's webview capture with the flag off, the headless page main
  // photographs on request with it on. Gating this to flag-off left the phone
  // with no producer at all once browsers went headless — every card on the
  // canvas sat on its placeholder.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  // Lives in a ref: backoff bookkeeping must not re-render the canvas.
  const thumbBackoffsRef = useRef<ThumbBackoffs>({})
  /** id → the `at` of the frame the store holds, so an unchanged one costs no bytes. */
  const thumbVersionsRef = useRef<Readonly<Record<string, number>>>({})
  useEffect(() => {
    if (!shouldPollThumbs({ remote: isRemoteMode(), interactive: interactiveBrowser })) return
    // ONE BATCH AT A TIME, AND NEVER FOR LONG (2026-11-01): a batch the Mac
    // did not answer (one page's screenshot hung) used to be joined by
    // another every 5 s, until they held every free HTTP/1.1 connection and
    // the keystrokes typed in LIVE queued behind them.
    let inFlight: AbortController | null = null
    const tick = (): void => {
      // A page nobody is looking at needs no pictures.
      if (document.hidden || inFlight) return
      // ONLY WHAT THE SCREEN SHOWS, IN ONE EXCHANGE, ONLY WHEN CHANGED. The
      // poll used to walk every browser card on the canvas eight at a time,
      // one request each with ?v= so nothing could ever be cached — through
      // the relay ~96 exchanges a minute for pictures that mostly had not
      // changed (perf lane L7, 2026-09-08). Now: the browser cards inside
      // the viewport, one GET /api/browser/thumbs, and the version of each
      // frame already held rides along so an unchanged one answers with a
      // number and no bytes.
      // Only what the item pets show (pets/thumb-wants.ts): the canvas and
      // its viewport are retired.
      const visible = [...thumbWants.ids()]
      // Per-id failure backoff — the desktop's capture-storm lesson, applied to
      // the polling side. After an app restart NO engine is booted, so 40+
      // cards have no frame at once; re-asking them all every 5s was a
      // sustained storm (owner's Web Inspector, 2026-08-27).
      const now = Date.now()
      const ids = thumbPollList(visible, thumbBackoffsRef.current, now).slice(0, THUMB_BATCH_MAX)
      if (ids.length === 0) return
      const params = new URLSearchParams({ ids: ids.join(',') })
      const known = knownVersions(thumbVersionsRef.current, ids)
      if (known.length > 0) params.set('known', known)
      const failAll = (): void => {
        for (const id of ids) {
          thumbBackoffsRef.current = recordThumbFailure(thumbBackoffsRef.current, id, Date.now())
        }
      }
      // A HEADER, not ?token=. This is an ordinary fetch and can set one, so
      // the token stays out of the URL — see tokenParam, which exists only
      // for the two EventSources that genuinely cannot.
      const batch = new AbortController()
      inFlight = batch
      const giveUp = setTimeout(() => batch.abort(), THUMB_BATCH_TIMEOUT_MS)
      void planeFetch(apiPath(`/api/browser/thumbs?${params.toString()}`), { headers: authHeaders(), signal: batch.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ frames: ThumbBatchFrame[] }>) : null))
        .then((body) => {
          if (!body) {
            failAll()
            return
          }
          const outcome = applyThumbBatch(body.frames, thumbBackoffsRef.current, thumbVersionsRef.current, Date.now())
          thumbBackoffsRef.current = outcome.backoffs
          thumbVersionsRef.current = outcome.versions
          for (const frame of outcome.changed) {
            // A blob URL, as before: the browser holds the decoded bytes, not a
            // base64 string in the store, which is what the phone's memory
            // ceiling cares about. Decoded HERE, synchronously and in order —
            // a data: fetch was tried and the renderer CSP (connect-src) blocks
            // it, so every frame failed silently; and async decodes landed out
            // of order. One bad frame is that frame's problem.
            try {
              const old = thumbStore.get(frame.id)
              if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
              thumbStore.set(frame.id, URL.createObjectURL(new Blob([decodeBase64(frame.data)], { type: frame.type })))
            } catch {
              thumbBackoffsRef.current = recordThumbFailure(thumbBackoffsRef.current, frame.id, Date.now())
            }
          }
        })
        .catch(failAll)
        .finally(() => {
          clearTimeout(giveUp)
          if (inFlight === batch) inFlight = null
        })
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      clearInterval(timer)
      inFlight?.abort()
    }
  }, [interactiveBrowser, reactFlow, visibleBrowserIds])

  // ESC dismisses the top overlay: modal panels (team fork / roster / metrics /
  // directory manager) self-handle it in the capture phase; this bubble-phase
  // handler is the last resort that leaves a zoomed-in card back to the canvas
  // overview. Fires whenever anything is covering the stage — a zoomed node OR
  // a live terminal overlay (which can outlast zoomedNodeIdRef after a reload)
  // — so ESC always escapes, even from the mid-zoom loop above.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && (zoomedNodeIdRef.current || zoomedTerminalIdRef.current)) {
        e.preventDefault()
        zoomBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBack])

  // activities/thumbs are NOT here — they live in the per-id store, so this
  // context value stays stable across the activity stream and the cards that
  // read it (tool/clipping/picked) don't re-render on every event.
  const ui = useMemo(
    () => ({
      tool,
      clipping,
      interactiveBrowser,
      zoomToNode,
      jumpToNode: jump.to,
      zoomBack,
      requestClose,
      picked,
      togglePick
    }),
    [
      tool,
      clipping,
      interactiveBrowser,
      zoomToNode,
      jump,
      zoomBack,
      requestClose,
      picked,
      togglePick
    ]
  )

  // Every change batch routes through the edge snapper: while a card is
  // resized or dragged, its moving edges snap flush to neighbouring cards
  // (card-snap.ts); gesture-end batches persist the snapped geometry.
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  /** Ids of the in-flight drag gesture — tells drag-end from keyboard moves. */
  const dragIdsRef = useRef<ReadonlySet<string>>(new Set())
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const result = snapCardChanges(
        changes,
        nodesRef.current,
        reactFlow.getZoom(),
        dragIdsRef.current,
        snapRadiusPx
      )
      if (result.active) draggingRef.current = true
      if (result.dragIds.length > 0) dragIdsRef.current = new Set(result.dragIds)
      if (result.dragEnded) dragIdsRef.current = new Set()
      setGuides((prev) => (prev.length === 0 && result.guides.length === 0 ? prev : result.guides))
      setNodes((prev) => applyNodeChanges(result.changes, prev))
      if (result.resizeEndedId) {
        draggingRef.current = false
        const node = nodesRef.current.find((n) => n.id === result.resizeEndedId)
        const end = result.changes.find(
          (c): c is Extract<NodeChange, { type: 'dimensions' }> =>
            c.type === 'dimensions' && c.id === result.resizeEndedId
        )
        if (node && end?.dimensions) {
          void cookrew().updateNode(node.id, {
            position: node.position,
            size: { width: end.dimensions.width, height: end.dimensions.height }
          })
        }
      }
    },
    [reactFlow]
  )

  const onNodeDragStart = useCallback(() => {
    draggingRef.current = true
  }, [])

  // Persist from the store, not the handler args: XYDrag reports its own
  // internal positions, which don't carry an engaged edge snap. Iterating
  // the third argument also persists every card of a multi-selection drag.
  const onNodeDragStop = useCallback((_e: unknown, _node: Node, dragged: Node[]) => {
    draggingRef.current = false
    for (const draggedNode of dragged) {
      const current = nodesRef.current.find((n) => n.id === draggedNode.id)
      void cookrew().updateNode(draggedNode.id, {
        position: current?.position ?? draggedNode.position
      })
    }
  }, [])

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      if (tool !== 'connect') return
      if (connectFrom === null) {
        setConnectFrom(node.id)
      } else if (connectFrom !== node.id) {
        // node:connect now VALIDATES both ids, so a node deleted between the
        // two clicks rejects instead of writing a dangling edge. Report it
        // rather than letting the tool reset with no edge and no explanation.
        void cookrew()
          .connectNodes(connectFrom, node.id)
          .catch((error: unknown) => console.error('Connect failed:', error))
        setConnectFrom(null)
        setTool('move')
      }
    },
    [tool, connectFrom]
  )

  // STABLE, on purpose. React Flow hands these three straight to every
  // NodeWrapper as props, and NodeWrapper is memo'd on them: an inline arrow
  // here is a new identity per Canvas render, which re-rendered EVERY mounted
  // card (and its handles, pick box and status coin) on every commit — 104
  // cards at the desktop overview, 2.5 commits per pan frame (perf lane L6,
  // scripts/perf-dom-probe.mjs, 2026-09-06). Clipping is read through a ref so
  // the hover handlers never change identity when the toggle flips.
  // Right-click edits the card under the cursor (touch gets the same menu via
  // long-press — see the stage effect above).
  const onStageContextMenu = useCallback((e: React.MouseEvent) => {
    const nodeId = (e.target as Element).closest<HTMLElement>('[data-card-id]')?.dataset.cardId
    if (!nodeId) return
    e.preventDefault()
    setCardMenu({ nodeId, x: e.clientX, y: e.clientY })
  }, [])
  const onNodeMouseEnter = useCallback((_e: React.MouseEvent, n: Node) => {
    if (clippingRef.current) setHoverId(n.id)
  }, [])
  const onNodeMouseLeave = useCallback(() => {
    if (clippingRef.current) setHoverId(null)
  }, [])

  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const node of deleted) void cookrew().removeNode(node.id)
  }, [])

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const edge of deleted) void cookrew().disconnect(edge.id)
  }, [])

  const onConnect = useCallback((params: { source: string | null; target: string | null }) => {
    if (params.source && params.target) {
      void cookrew()
        .connectNodes(params.source, params.target)
        .catch((error: unknown) => console.error('Connect failed:', error))
    }
  }, [])

  // Memoized on the node list, NOT recomputed every render: a fresh .filter()
  // each render gave overlayNodes' memo new-identity deps (so it recomputed
  // every frame) and handed TerminalOverlayLayer/BrowserLayer new-identity array
  // props (so they re-rendered) even during pan/zoom and activity, when the
  // nodes themselves are unchanged. These now change only on a real workspace
  // push.
  // Each terminal's wired browsers and notes, for its zoomed card. Kept the
  // same object while nothing a card shows changes (sameAttachmentIndex):
  // the workspace object itself changes on every tick and drag.
  // THE CREW, READ ONCE (stage/crew-rows.ts · CrewProvider): the zoom view,
  // the stage and the agent group all draw this one list, so they agree on
  // who is in it, how many, and in what state. In context, not here: a crew
  // change re-renders those three, not the whole app.
  const attachIndexRef = useRef<AttachmentIndex>(new Map())
  const attachIndex = useMemo(() => {
    const next = attachmentIndex(workspace?.nodes ?? [], workspace?.connections ?? [])
    if (!sameAttachmentIndex(attachIndexRef.current, next)) attachIndexRef.current = next
    return attachIndexRef.current
  }, [workspace?.nodes, workspace?.connections])
  // What a full view shows, for the side groups that attach to it: never the
  // card on the panel; around a browser or note, the agents wired to it first.
  const fullItemId = zoomFull === 'item' && stagePick.kind === 'item' ? stagePick.id : null
  const fullAgentId = zoomFull === 'agent' ? (stageShowing?.terminalId ?? null) : null
  const fullDock = useMemo(
    () => ({
      agents: { exclude: fullAgentId, first: fullItemId ? (ownersOf(attachIndex).get(fullItemId) ?? []) : [] },
      items: { exclude: fullItemId }
    }),
    [fullAgentId, fullItemId, attachIndex]
  )
  const terminals = useMemo(
    () => (workspace?.nodes.filter((n) => n.kind === 'terminal') ?? []) as TerminalNodeData[],
    [workspace?.nodes]
  )
  const browsers = useMemo(
    () => (workspace?.nodes.filter((n) => n.kind === 'browser') ?? []) as BrowserNodeData[],
    [workspace?.nodes]
  )
  /** The global prompt's agents: its @names, and who it can talk to. */
  const promptAgents = useMemo(
    () => terminals.map((t) => ({ id: t.id, name: t.name, remote: t.servedSession != null })),
    [terminals]
  )
  /** The prompt's "#Name": every note and browser of the workspace, and who holds it. */
  const promptArtifacts = useMemo(() => {
    const owners = ownersOf(attachIndex)
    return (workspace?.nodes ?? []).flatMap((n) =>
      n.kind === 'note' || n.kind === 'browser' ? [{ id: n.id, name: n.name, kind: n.kind, owners: owners.get(n.id) ?? [] }] : []
    )
  }, [workspace?.nodes, attachIndex])
  // The snapshot poll reads this instead of `browsers`, so it subscribes once
  // rather than tearing down its interval on every workspace push.
  browsersRef.current = browsers
  /** Null once the node is gone, which is also how the dialog self-dismisses. */
  const closingNode = closingId
    ? (workspace?.nodes.find((n) => n.id === closingId) ?? null)
    : null
  const terminalIds = useMemo(() => terminals.map((t) => t.id), [terminals])
  const busyCount = useActivityPhaseCount(terminalIds, 'thinking')
  const attentionCount = useActivityPhaseCount(terminalIds, 'waiting')
  /** The card a close dialog is about — '' subscribes to nothing. */
  const closingActivity = useActivity(closingId ?? '')

  // ⌘W closes the focused card and its session (ESC handles un-zooming):
  //   • a zoomed-in browser with >1 tab → close the active tab
  //   • a zoomed-in card → close it (removes the node, kills its session) and
  //     drop back to the canvas
  //   • otherwise → close the selected card(s)
  cmdWRef.current = () => {
    const zoomedId = zoomedNodeIdRef.current
    if (zoomedId) {
      const browser = browsers.find((p) => p.id === zoomedId)
      if (browser) {
        const tabs = browserTabs(browser)
        if (tabs.length > 1) {
          const active = activeBrowserTab(browser)
          const index = tabs.findIndex((t) => t.id === active.id)
          const remaining = tabs.filter((t) => t.id !== active.id)
          const next = remaining[Math.min(index, remaining.length - 1)]
          void cookrew().updateNode(browser.id, {
            tabs: remaining,
            activeTabId: next.id,
            url: next.url
          })
          return
        }
      }
      requestClose(zoomedId)
      return
    }
    // Selection close asks too, but only for a single card: the dialog names
    // one thing and its cost, and a bulk variant would be a second prompt
    // worded differently for the same act.
    const selected = nodes.filter((n) => n.selected)
    if (selected.length === 1) requestClose(selected[0].id)
    else for (const node of selected) void cookrew().removeNode(node.id)
  }

  return (
    <CanvasUiContext.Provider value={ui}>
      <CrewProvider workspace={workspace} workspaceId={activeWsId}>
      <div className={`cr cr-app tool-${tool}${clipping ? ' clipping' : ''}`}>
        <Header
          workspaceName={workspace?.name ?? 'Cookrew'}
          dir={workspace?.dir ?? ''}
          terminalCount={terminals.length}
          busyCount={busyCount}
          view={view}
          onViewChange={setView}
          onWall={wall.open}
          onRouting={routeState.available ? () => setRoutingOpen(true) : undefined}
          routeStatus={routeState.state?.status ?? null}
          onResync={resync}
          zoomedAgent={view === 'stage' ? (stageShowing?.zoomed ? stageShowing.name : null) : (terminals.find((t) => t.id === zoomedTerminalId)?.name ?? null)}
          stageWorkspace={view === 'stage' ? (stageShowing?.workspaceName ?? null) : null}
          avatar={account.avatar}
          search={<BoardSearch workspace={workspace} activeWorkspaceId={activeWsId} attentionCount={attentionCount} onAction={(id) => (id === 'new-workspace' ? wall.openCreate() : wall.openRename())} />}
        />
        <div className="cr-stage" ref={stageRef} onContextMenu={onStageContextMenu}>
          {/* THE CANVAS IS RETIRED (owner, 2026-10-30): it is not rendered, so
              it costs no CPU or GPU. Every card opens on the stage below, and
              the agents and the browsers and notes ride over every page as
              pets (pets/). */}
          {/* RETIRED (owner ruling 2026-08-26): the WHO CAN CALL entry opened
              a parallel admin panel onto a dead end ("no agents are
              exportable"). Sharing now happens once, where saving happens —
              the save sheet's share section — and who-is-on lives on the
              served team itself. */}
          {view === 'stage' && (
            <Suspense fallback={null}>
              <TerminalAttachmentsContext.Provider value={attachIndex}>
                <WithCrew>
                  {(crew) => (
                    <ZoomView workspace={workspace} workspaceId={activeWsId} attachIndex={attachIndex} crew={crew} onDelete={requestClose} onNewWorkspace={wall.openCreate}>
                      {zoomFull !== null && <StageView workspace={workspace} workspaceId={activeWsId} terminals={terminals} attachIndex={attachIndex} crew={crew} onShowing={setStageShowing} />}
                    </ZoomView>
                  )}
                </WithCrew>
              </TerminalAttachmentsContext.Provider>
            </Suspense>
          )}
        </div>
        {/* The dock always holds its strip: it is where an agent is added, and
            a dock that comes and goes resizes the stage under the zoom. Only
            its composer waits for an agent to be in the middle (voiceFor). */}
        <Dock
          tool={tool}
          onSelect={selectTool}
          clipping={clipping}
          onToggleClipping={toggleClipping}
          presets={presets}
          templates={templates}
          preset={preset}
          onPreset={(name) => {
            setPreset(name)
            setRole(null)
            // A saved team opens a session of its own; a harness joins this crew.
            void make(() =>
              templates.includes(name)
                ? importTeam(cookrew(), name)
                : makeAgent(cookrew(), { name, preset: name, orch }, workspace?.nodes ?? [])
            )
          }}
          roles={roles}
          role={role}
          onRole={(name) => {
            setRole(name)
            const chosen = roles.find((r) => r.name === name)
            if (!chosen) return
            void make(() =>
              makeAgent(cookrew(), { name: chosen.name, preset: chosen.preset, roleName: chosen.name, orch }, workspace?.nodes ?? [])
            )
          }}
          onMake={(kind) => void make(() => makeItem(cookrew(), kind, workspace?.nodes ?? []))}
          making={making}
          makeError={makeError}
          onImportServed={() => setImportServedOpen(true)}
          orch={orch}
          onOrch={setOrch}
          agents={promptAgents}
          artifacts={promptArtifacts}
          workspaceName={workspace?.name ?? null}
          nodes={workspace?.nodes ?? NO_NODES}
          voiceFor={
            view === 'stage'
              ? stageShowing?.terminalId != null
                ? { id: stageShowing.terminalId, remote: terminals.find((t) => t.id === stageShowing.terminalId)?.servedSession != null }
                : null
              : zoomedTerminalId && terminals.some((t) => t.id === zoomedTerminalId)
              ? {
                  id: zoomedTerminalId,
                  // An imported card runs at someone else's app: the dock's
                  // attach button would paste THIS machine's paths into it.
                  remote: terminals.find((t) => t.id === zoomedTerminalId)?.servedSession != null
                }
              : null
          }
          browserFor={browserInFullView(overlayPrimaryId, browsers)}
          /* The board is the header's search box now; its dock toggle is unused. */
          boardFor={null}
          connectHint={
            tool === 'connect'
              ? connectFrom
                ? 'NOW CLICK THE TARGET NODE TO FINISH THE CABLE'
                : 'CLICK THE FIRST NODE TO CONNECT'
              : null
          }
        />
        {metricsOpen && (
          <Suspense fallback={null}>
            <MetricsPanel onClose={() => setMetricsOpen(false)} />
          </Suspense>
        )}
        {/* A new card goes on the stage at once; a re-pointed one is already there. */}
        <SourcePicker
          onOpened={(card, made) => {
            if (!made) return
            stageSelect.set({ kind: 'item', id: card.id })
            zoomStore.jumpTo('item', card.id)
            if (viewRef.current !== 'stage') setView('stage')
          }}
        />
        {importServedOpen && (
          <ImportServedSheet
            /* A second link while the sheet is open is a new question: remount
               so the field and the lookup start from the new address. */
            key={importPrefill ?? ''}
            {...(importPrefill !== null ? { prefill: importPrefill } : {})}
            onClose={closeImportServed}
            onImported={(placed) => {
              closeImportServed()
              // GO AND SHOW IT. The card is placed at canvas coordinates that
              // have nothing to do with where the person is looking, so
              // without this the button's promise — place the orch card — was
              // kept somewhere they could not see, which reads as a failure.
              if (!placed) return
              const size = placed.size ?? { width: 420, height: 300 }
              window.setTimeout(
                () =>
                  zoomToNode(placed.id, {
                    x: placed.position.x,
                    y: placed.position.y,
                    width: size.width,
                    height: size.height
                  }),
                60
              )
            }}
          />
        )}
        {/* One confirmation for every close path. Rendered last so it sits over
            the zoomed overlays the ✕ was clicked in. A node that vanished while
            the dialog was open (⌘W elsewhere, a crash) simply has nothing to
            confirm, so the lookup failing closes it rather than throwing. */}
        {closingNode && (
          <ConfirmClose
            node={closingNode}
            activity={closingActivity ?? null}
            nodes={workspace?.nodes ?? []}
            onCancel={() => setClosingId(null)}
            onConfirm={() => confirmClose(closingNode.id)}
          />
        )}
        {cardMenu && workspace && <CardMenu anchor={cardMenu} workspace={workspace} onClose={() => setCardMenu(null)} />}
        {/* The screen wall covers the stage it hands back to, so it is mounted
            after the canvas and measures that stage rather than guessing. */}
        {wall.element}
        <RoutingPanel
          open={routingOpen}
          onClose={() => setRoutingOpen(false)}
          state={routeState.state}
          available={routeState.available}
          onRun={(line, options) => void setupTerminal.run(line, options)}
          setupTerminalId={setupTerminal.terminalId}
          focusTick={setupTerminal.focusTick}
          running={setupTerminal.running}
          onSetDefault={routeState.setDefault}
          onSetSharedMcp={routeState.setSharedMcp}
          error={newestError(routeState.error, setupTerminal.error)}
          onAddToDock={(harness) => {
            // "In the dock" as Cookrew can make it true today: the harness
            // becomes the dock's active preset, its chip lit in the row.
            setPreset(harness.name)
            setRole(null)
            setRoutingOpen(false)
          }}
          names={cardNames}
          onZoom={(terminalId) => {
            setRoutingOpen(false)
            zoomToNode(terminalId)
          }}
        />
        <EventToastLayer />
        {/* THE BROWSER HOST: every browser page lives in BrowserLayer and is
            drawn at the slot a stage pane or a terminal's lower half measures
            (attach-view.ts). It rode inside the canvas's LodOverlays, and
            retiring the canvas took it along — every browser slot stayed
            empty (owner, 2026-10-31). No canvas, so no card rects. */}
        <BrowserLayer
          browsers={browsers}
          lod={NO_CANVAS_LOD}
          onThumb={onThumb}
          isPhoneViewing={isPhoneViewing}
          interactiveCapability={interactiveCapability}
        />
        {/* The crew, and the browsers and notes, as pets over every page: hover
            for a card, click to open it (pets/). On the stage they ride at the
            full view only — the navigator draws the crew everywhere else. */}
        {(zoomFull !== null || view !== 'stage') && (
          <WithCrew>
            {(crew) => (
              <AgentPets
                crew={crew}
                attachIndex={attachIndex}
                onOpen={zoomToNode}
                onDelete={requestClose}
                // In a full view both groups attach to its panel (pets/pet-dock.ts),
                // as group-motion-pivot.html draws them.
                dock={view === 'stage' && zoomFull !== null ? fullDock.agents : null}
              />
            )}
          </WithCrew>
        )}
        {/* Not beside an agent's full view: its browsers and notes attach to
            its own sheet there (stage/AgentArtifacts.tsx · owner, 2026-11-01). */}
        {(zoomFull === 'item' || view !== 'stage') && <ItemPets
          workspace={workspace}
          attachIndex={attachIndex}
          dock={view === 'stage' && zoomFull !== null ? fullDock.items : null}
          onStage={view === 'stage' ? (stageShowing?.terminalId ?? null) : null}
          onOpen={(id, owners) => {
            // The agent on stage's own browser or note opens under its
            // transcript, as its side tab did; anything else takes the middle.
            const onStage = view === 'stage' ? (stageShowing?.terminalId ?? null) : null
            const kind = workspace?.nodes.find((n) => n.id === id)?.kind
            if (onStage && owners.includes(onStage) && (kind === 'browser' || kind === 'note')) attachView.toggle(onStage, id, kind)
            else zoomToNode(id)
          }}
        />}
        {/* D14 · a door this Mac was serving moved to another of the account's. */}
        <DoorMovedNotice />
        {/* Terminals from an earlier macOS login cannot resolve names or open apps. */}
        <TerminalSessionNotice />
        {/* R3 · the one box: ⌘K on the desktop, the bottom bar on the phone. */}
        <CommandBox open={commandOpen} onClose={closeCommand} phone={isRemoteMode()} />
        {/* Identity: the sheets and the lock. Mounted here, after everything
            else, so the lock screen is drawn over the canvas it covers. */}
        {account.overlays}
        <ReauthOverlay />
      </div>
      </CrewProvider>
    </CanvasUiContext.Provider>
  )
}

/** One empty list, so a missing workspace does not hand the dock a new array every render. */
const NO_NODES: readonly CanvasNode[] = []

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </ErrorBoundary>
  )
}
