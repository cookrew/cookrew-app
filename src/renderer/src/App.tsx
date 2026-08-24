import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
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
import { isViewed, markViewed, pruneViewers, type ViewerClocks } from '../../shared/phone-viewing'
import { TerminalNode } from './nodes/TerminalNode'
import { NoteNode } from './nodes/NoteNode'
import { BrowserNode } from './nodes/BrowserNode'
import { CableEdge } from './CableEdge'
import { Header, type MainView } from './Header'
import { Dock } from './Dock'
import { CardMenu, type CardMenuAnchor } from './CardMenu'
import { TerminalOverlayLayer } from './TerminalOverlay'
import { useLodLayout } from './zoom-lod'
import type { InstalledPreset } from '../../shared/preset-chip'
import { browserInFullView } from './dock-target'
import { BrowserLayer, useInteractiveBrowserCapability } from './BrowserLayer'
import {
  shouldClearLegacyThumbs,
  shouldPollThumbs,
  shouldSnapshotLocally
} from './browser-thumb-policy'
import { retry } from './retry'
import { CanvasUiContext, ToolId } from './canvas-ui'
import {
  activityStore,
  thumbStore,
  useActivitiesSnapshot,
  useThumbsSnapshot
} from './activity-thumb-store'
import { reconcileFlowNodes } from './flow-nodes'
import { cardZoomMode } from './nodes/card-zoom'
import { useBrowserEngine } from './browser-engine'
import { ErrorBoundary } from './ErrorBoundary'
import { ReauthOverlay } from './ReauthOverlay'
import { snapCardChanges, MOUSE_SNAP_PX, TOUCH_SNAP_PX, SnapGuide } from './card-snap'
import { SnapGuides } from './SnapGuides'
import { EventToastLayer } from './EventToast'
import { RosterPanel } from './RosterPanel'
import { MetricsPanel } from './MetricsPanel'
import { GrantPanel, canGrant } from './GrantPanel'
import { SelectionBar } from './SelectionBar'
import { ConfirmClose } from './ConfirmClose'
import { apiPath } from './api-base'
import { authHeaders } from './auth-gate'

/** How often a headless browser card refreshes its still. Matches the legacy
 *  webview capture cadence — the same picture, from the page that now owns it. */
const BROWSER_SNAPSHOT_MS = 5000

/** Phone companion parity: widen the snap magnet for finger-driven gestures. */
const snapRadiusPx = window.matchMedia('(pointer: coarse)').matches ? TOUCH_SNAP_PX : MOUSE_SNAP_PX

/** Two viewports are "the same" when restoring one wouldn't move the canvas. */
function sameViewport(
  a: { x: number; y: number; zoom: number },
  b: { x: number; y: number; zoom: number }
): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.01
}

const nodeTypes = { terminal: TerminalNode, note: NoteNode, browser: BrowserNode }
const edgeTypes = { cable: CableEdge }

/** The ids ReactFlow currently marks selected — carried across a reconcile. */
function selectedIds(nodes: Node[]): Set<string> {
  return new Set(nodes.filter((n) => n.selected).map((n) => n.id))
}


function toFlowEdges(state: WorkspaceState): Edge[] {
  return state.connections.map((c) => ({
    id: c.id,
    source: c.a,
    target: c.b,
    type: 'cable'
  }))
}

function Canvas(): React.JSX.Element {
  const interactiveCapability = useInteractiveBrowserCapability()
  const interactiveBrowser = interactiveCapability?.enabled ?? null
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
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
  // activity events must not re-render every card. App reads the whole map via
  // the snapshot hooks (it needs the aggregate counts); cards subscribe per id.
  const activities = useActivitiesSnapshot()
  const thumbs = useThumbsSnapshot()
  /** Alignment guides while a card resize is snapped to a neighbour edge. */
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** Terminal whose overlay owns the stage — the dock shows its composer. */
  const [zoomedTerminalId, setZoomedTerminalId] = useState<string | null>(null)
  /** Global agent roster panel (opened from the header). */
  /**
   * Which of the two main views the stage shows. The agents view renders as a
   * full-bleed overlay INSIDE the stage rather than replacing it: the canvas
   * owns live webviews and terminal panes that must never remount, and swapping
   * it out of the tree would also drop the viewport transform.
   */
  const [view, setView] = useState<MainView>('canvas')
  /** Activity metrics / history panel (opened from the workspace popout). */
  const [metricsOpen, setMetricsOpen] = useState(false)
  // WHO CAN CALL. Owner-desktop only, and ABSENT rather than disabled anywhere
  // else — a greyed-out list of who is enrolled still discloses who is
  // enrolled, on the device most likely to be lying on a table.
  const [grantOpen, setGrantOpen] = useState(false)
  /** Board selection mode — the dock's slid-in clipboard button drives it. */
  const [boardSelecting, setBoardSelecting] = useState(false)
  /**
   * Node awaiting a close confirmation. Every ✕ routes here instead of calling
   * removeNode, so there is one dialog and no close button can skip it.
   */
  const [closingId, setClosingId] = useState<string | null>(null)
  /**
   * Marketplace presets (§8) and the one currently armed. Arming is exclusive
   * with the harness-preset and role chips: three families, one selection.
   */
  const [installedPresets, setInstalledPresets] = useState<InstalledPreset[]>([])
  const [presetId, setPresetId] = useState<string | null>(null)
  const refreshPresets = useCallback(() => {
    void cookrew()
      .listInstalledPresets()
      .then(setInstalledPresets)
      .catch((error) => console.error('listInstalledPresets failed:', error))
  }, [])
  useEffect(refreshPresets, [refreshPresets])
  /**
   * M3: STABLE identities. Inline arrows here were new objects every render, so
   * the dock's effect re-fired on each one and the R3 batch never settled.
   * M5: no console TODOs — the gate sheet and the HEAD request are the
   * registry's work, and until they exist these are no-ops that change nothing
   * rather than log lines pretending to.
   */
  /**
   * N4: a locked chip must ACKNOWLEDGE the click. The 401/402/403 sheets land
   * with the gate, but "nothing happens" is indistinguishable from a broken
   * chip, so until then the chip answers for itself and says it is locked.
   */
  const [gatedId, setGatedId] = useState<string | null>(null)
  const openPresetGate = useCallback((id: string) => {
    setGatedId(id)
    window.setTimeout(() => setGatedId((current) => (current === id ? null : current)), 2400)
  }, [])
  const checkPresetUpdates = useCallback((_ids: string[]) => {
    // A manifest HEAD by version (R3) needs a registry to ask.
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
  const knownWsIdRef = useRef<string | null>(null)
  const reactFlow = useReactFlow()
  const { screenToFlowPosition } = reactFlow
  const browsersRef = useRef<BrowserNodeData[]>([])
  const draggingRef = useRef(false)
  /** Viewport before the last zoomToNode, so ⤢ CANVAS can return to it. */
  const prevViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null)
  /** Node currently zoomed into full view — drives layered ⌘W. */
  const zoomedNodeIdRef = useRef<string | null>(null)
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
    fitPendingRef.current = true
    // The outgoing canvas is gone, so the saved "back" viewport and the zoomed
    // node both point at cards that no longer exist; ⤢ / ESC must fall back to
    // the overview rather than restore a dead frame.
    prevViewportRef.current = null
    zoomedNodeIdRef.current = null
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
    return cookrew().onWorkspaceState((state) => {
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

  // Fire the armed fit, one frame after the incoming nodes are committed —
  // React Flow measures a node on layout, and fitting before that measurement
  // frames the cards at a stale size.
  useEffect(() => {
    if (!fitPendingRef.current) return
    fitPendingRef.current = false
    // An empty workspace has nothing to frame; fitView would be a no-op that
    // still costs an animation, so leave the viewport where it is.
    if (nodes.length === 0) return
    const frame = requestAnimationFrame(() => {
      void reactFlow.fitView({ duration: 450, padding: 0.1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [nodes, reactFlow])

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
    return cookrew().onTerminalActivity((activity) => {
      activityStore.set(activity.terminalId, activity)
    })
  }, [])

  // ⌘W from the main process, resolved against the latest layer state.
  useEffect(() => cookrew().onCmdW(() => cmdWRef.current()), [])

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
  const baseEdges = useMemo(() => (workspace ? toFlowEdges(workspace) : []), [workspace])
  const edges = useMemo(() => {
    if (!clipping || hoverId === null) return baseEdges
    return baseEdges.map((e) =>
      e.source === hoverId || e.target === hoverId ? { ...e, data: { hot: true } } : e
    )
  }, [baseEdges, clipping, hoverId])

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
  // Leaving the board view stands its selection mode down.
  useEffect(() => {
    if (view !== 'agents') setBoardSelecting(false)
  }, [view])

  /** Mirrors for the ⌘A handler (stable subscription, fresh reads). */
  const viewRef = useRef<MainView>(view)
  viewRef.current = view
  const clippingRef = useRef(clipping)
  clippingRef.current = clipping
  const activitiesRef = useRef(activities)
  activitiesRef.current = activities
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
      const nodeEl = target.closest('.react-flow__node') as HTMLElement | null
      const nodeId = nodeEl?.dataset.id
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

  // ⌘A while clipping picks the whole canvas — the whole-team case the old
  // dock buttons owned. Never while typing (any input/textarea/xterm owns
  // its own ⌘A), never under the agents view or a zoomed card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"], .xterm')) return
      if (viewRef.current !== 'canvas' || !clippingRef.current) return
      if (zoomedNodeIdRef.current) return
      e.preventDefault()
      const state = workspaceRef.current
      if (!state) return
      // Working agents are uncopyable, so ⌘A leaves them out — a pick-all
      // that traps the selection behind a busy agent isn't "all".
      const working = activitiesRef.current
      setPicked(
        new Set(
          state.nodes
            .filter((n) => n.kind !== 'terminal' || working[n.id]?.phase !== 'thinking')
            .map((n) => n.id)
        )
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Semantic zoom: clicking a card animates the viewport until the card
  // fills the stage; crossing the coverage threshold swaps its thumbnail
  // for the full renderer (see zoom-lod.ts).
  const zoomToNode = useCallback(
    (id: string, rect?: { x: number; y: number; width: number; height: number }) => {
      // Save the return point only when not already mid-zoom: a second click
      // (or a click after a reload that landed already zoomed, with a terminal
      // overlay covering the stage) must NOT persist a zoomed viewport as the
      // "back" target — that makes ⤢/ESC restore another zoomed state, an
      // inescapable loop (Magpie E2). Leaving it null falls Back back to
      // fitView instead.
      if (!prevViewportRef.current && !zoomedTerminalIdRef.current) {
        prevViewportRef.current = reactFlow.getViewport()
      }
      zoomedNodeIdRef.current = id
      // A just-created node may not be in the React Flow store yet (its
      // workspace broadcast is still in flight) — fitView can't find it, so
      // callers that know the node's rect pass it for a fitBounds instead.
      if (rect) {
        void reactFlow.fitBounds(rect, { duration: 500, padding: 0.02 })
      } else {
        void reactFlow.fitView({ nodes: [{ id }], duration: 500, padding: 0.02 })
      }
    },
    [reactFlow]
  )

  const zoomBack = useCallback(() => {
    const previous = prevViewportRef.current
    prevViewportRef.current = null
    zoomedNodeIdRef.current = null
    // Restoring a saved viewport that equals the current one wouldn't move the
    // canvas — we'd stay zoomed (the loop). Fall back to fitView so Back always
    // escapes to the overview.
    if (previous && !sameViewport(previous, reactFlow.getViewport())) {
      void reactFlow.setViewport(previous, { duration: 450 })
    } else {
      void reactFlow.fitView({ duration: 450, padding: 0.1 })
    }
  }, [reactFlow])

  const requestClose = useCallback((nodeId: string) => setClosingId(nodeId), [])

  /**
   * Dock tool selection. There is no MOVE button — the resting hand is what
   * every tool falls back to: re-clicking the active tool stands it down,
   * and arming a placement tool always stands the clipboard down (one
   * click-target contract at a time).
   */
  const selectTool = useCallback((next: ToolId) => {
    setTool((prev) => (prev === next ? 'move' : next))
    setClipping(false)
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
   * Paused while the window is hidden and while a card is zoomed — the zoomed
   * one is showing the live stream, and its own card is behind that overlay.
   */
  useEffect(() => {
    if (!shouldSnapshotLocally({ remote: isRemoteMode(), interactive: interactiveBrowser })) return
    const snapshot = cookrew().browserSnapshot
    if (!snapshot) return
    let disposed = false
    const tick = async (): Promise<void> => {
      if (document.hidden) return
      for (const browser of browsersRef.current) {
        if (disposed) return
        if (browser.id === zoomedNodeIdRef.current) continue
        const dataUrl = await snapshot(browser.id).catch(() => null)
        if (!disposed && dataUrl) {
          thumbStore.set(browser.id, dataUrl) // set() dedupes identical values
        }
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), BROWSER_SNAPSHOT_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [interactiveBrowser])

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
  useEffect(() => {
    if (!shouldPollThumbs({ remote: isRemoteMode(), interactive: interactiveBrowser })) return
    const tick = (): void => {
      // Zoomed OUT, no browser card decodes its thumb (BrowserNode mini path),
      // so fetching + blob-decoding all of them is pure memory churn — and on a
      // phone at fit-to-view (all cards mini) that churn is what tips iOS Safari
      // into a WebContent OOM. Skip the whole poll at mini; it resumes when a
      // card is zoomed in enough to actually show a picture.
      if (document.hidden || cardZoomMode(reactFlow.getZoom()) === 'mini') return
      const browserIds = (workspaceRef.current?.nodes ?? [])
        .filter((n) => n.kind === 'browser')
        .map((n) => n.id)
      for (const id of browserIds) {
        // A HEADER, not ?token=. This is an ordinary fetch and can set one, so
        // the token stays out of the URL — see tokenParam, which exists only
        // for the two EventSources that genuinely cannot.
        void fetch(apiPath(`/api/browser/${id}/thumb?v=${Date.now()}`), {
          headers: authHeaders()
        })
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (!blob) return
            const old = thumbStore.get(id)
            if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
            thumbStore.set(id, URL.createObjectURL(blob))
          })
          .catch(() => undefined)
      }
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => clearInterval(timer)
  }, [interactiveBrowser])

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
      zoomBack,
      requestClose,
      picked,
      togglePick
    }),
    [tool, clipping, interactiveBrowser, zoomToNode, zoomBack, requestClose, picked, togglePick]
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

  const onPaneClick = useCallback(
    async (event: React.MouseEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      if (tool === 'terminal') {
        // R2: an armed marketplace chip places HERE — this click is the aimed
        // confirm, so there is no dialog between the chip and the canvas, not
        // even for a team paste. It takes precedence over the harness/role
        // chips because arming one clears the others.
        if (presetId) {
          // M4: the reset must survive a throw. Placement now REFUSES loudly
          // (bad id, missing preset, failed signature), and without this a
          // refusal left the chip armed and the tool stuck — every later click
          // on the canvas would try to place the same broken preset again.
          try {
            await cookrew().placeInstalledPreset(presetId, position, orch)
          } catch (error) {
            console.error('Placing preset failed:', error)
          } finally {
            setPresetId(null)
            setTool('move')
          }
          return
        }
        // A SAVED TEMPLATE placed as a preset IMPORTS a session: a new
        // workspace forked from the template — team, worktree, workdir —
        // switched to. Not a terminal on this canvas, so it returns before
        // createTerminal. The click that "placed" it is the confirm.
        if (!role && templates.includes(preset)) {
          try {
            await cookrew().templateImport(preset, position)
          } catch (error) {
            console.error('Importing template failed:', error)
          } finally {
            setTool('move')
          }
          return
        }
        // window.prompt is unsupported in Electron — creation uses the
        // preset (or saved-role) chips in the dock; a role boots its preset
        // with the role prompt injected once the TUI is quiet (roleName path).
        const selectedRole = role ? roles.find((r) => r.name === role) : undefined
        const created = await cookrew().createTerminal(
          selectedRole
            ? { name: selectedRole.name, preset: selectedRole.preset, roleName: selectedRole.name, position, orch }
            : { name: preset, preset, position, orch }
        )
        setTool('move')
        // A new code agent zooms straight into its live terminal so the
        // first prompt can be typed immediately; plain shells stay as
        // overview cards.
        if (created.kind === 'terminal' && created.preset !== 'Shell') {
          zoomToNode(created.id, { ...created.position, ...created.size })
        }
      } else if (tool === 'note') {
        const note: CanvasNode = {
          kind: 'note',
          id: crypto.randomUUID(),
          name: 'untitled',
          customName: null,
          content: '',
          locked: false,
          position,
          size: { width: 280, height: 220 }
        }
        await cookrew().addNode(note)
        setTool('move')
      } else if (tool === 'browser') {
        const browser: CanvasNode = {
          kind: 'browser',
          id: crypto.randomUUID(),
          name: 'Browser',
          url: 'https://example.com',
          position,
          size: { width: 720, height: 560 }
        }
        await cookrew().addNode(browser)
        setTool('move')
      } else {
        // A pane click while clipping clears the pick — the canvas-wide
        // "click again to cancel". Arming no tool just stands connect down.
        if (clipping) setPicked((prev) => (prev.size === 0 ? prev : new Set()))
        setConnectFrom(null)
      }
    },
    // presetId belongs here: without it the callback closes over a stale arm
    // and the click places the PREVIOUSLY armed preset, or nothing at all.
    [tool, preset, role, roles, orch, clipping, presetId, screenToFlowPosition, zoomToNode]
  )

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
  const terminals = useMemo(
    () => (workspace?.nodes.filter((n) => n.kind === 'terminal') ?? []) as TerminalNodeData[],
    [workspace?.nodes]
  )
  const browsers = useMemo(
    () => (workspace?.nodes.filter((n) => n.kind === 'browser') ?? []) as BrowserNodeData[],
    [workspace?.nodes]
  )
  // The snapshot poll reads this instead of `browsers`, so it subscribes once
  // rather than tearing down its interval on every workspace push.
  browsersRef.current = browsers
  // ONE shared overlay arbitration across terminals AND browsers — per-kind
  // instances each picked their own remote fullscreen winner, stacking a
  // browser view over the zoomed terminal (Magpie E2 HIGH 2).
  const overlayNodes = useMemo(() => [...terminals, ...browsers], [terminals, browsers])
  const lod = useLodLayout(overlayNodes)
  /** Null once the node is gone, which is also how the dialog self-dismisses. */
  const closingNode = closingId
    ? (workspace?.nodes.find((n) => n.id === closingId) ?? null)
    : null
  const busyCount = terminals.filter((t) => activities[t.id]?.phase === 'thinking').length
  const attentionCount = terminals.filter((t) => activities[t.id]?.phase === 'waiting').length

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
      <div className={`cr cr-app tool-${tool}${clipping ? ' clipping' : ''}`}>
        <Header
          workspaceName={workspace?.name ?? 'Cookrew'}
          dir={workspace?.dir ?? ''}
          terminalCount={terminals.length}
          busyCount={busyCount}
          attentionCount={attentionCount}
          view={view}
          onViewChange={setView}
          onActivity={() => setMetricsOpen(true)}
          onResync={resync}
        />
        <div className="cr-stage" ref={stageRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodeContextMenu={(e, node) => {
              // Right-click edits the card under the cursor (touch gets the
              // same menu via long-press — see the stage effect above).
              e.preventDefault()
              setCardMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
            }}
            onNodeMouseEnter={(_e, n) => {
              if (clipping) setHoverId(n.id)
            }}
            onNodeMouseLeave={() => {
              if (clipping) setHoverId(null)
            }}
            /* Cards stay draggable while clipping — the clipboard is a
               toggle over the resting hand, not a separate one: the header
               drags, the body click picks (click again cancels). */
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onConnect={onConnect}
            minZoom={0.1}
            maxZoom={8}
            onlyRenderVisibleElements
            /* Backspace/Delete used to remove a selected card outright — and
               disconnect its cables on the way, since ReactFlow deletes the
               attached edges too. That is the accident the close confirmation
               exists to prevent, and it fired from a key that sits next to the
               ones you type with. ⌘W is the keyboard way to close now, and it
               asks like every ✕ does. */
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#D9D3C5" />
            <SnapGuides guides={guides} />
            <MiniMap pannable zoomable className="cookrew-minimap" />
            <Controls position="bottom-right" />
            {/* Cross-workspace paste preview: dashed ghosts at the exact
                spots the staged elements would land (moves keep their
                position, copies nudge +32). Flow coordinates via the
                viewport portal, so they pan/zoom with the canvas. */}
            {clipping &&
              clipInfo !== null &&
              activeWsId !== null &&
              clipInfo.fromWorkspaceId !== activeWsId && (
                <ViewportPortal>
                  {clipInfo.items.map((item) => {
                    const nudge = item.moves ? 0 : 32
                    return (
                      <div
                        key={item.id}
                        className="cr-paste-ghost"
                        style={{
                          transform: `translate(${item.position.x + nudge}px, ${item.position.y + nudge}px)`,
                          width: item.size.width,
                          height: item.size.height
                        }}
                      >
                        <span className="cr-paste-ghost-name">{item.name}</span>
                      </div>
                    )
                  })}
                </ViewportPortal>
              )}
          </ReactFlow>
          {/* Inside the stage on purpose: it covers exactly the canvas and
              leaves the header — which owns the way back — reachable above it.
              The canvas keeps running underneath rather than unmounting. */}
          {view === 'agents' && canGrant() && (
            <button
              className="gs-entry"
              onClick={() => setGrantOpen(true)}
              title="Who may call your agents over the internet"
            >
              🔑 WHO CAN CALL
            </button>
          )}
          {view === 'agents' && (
            <RosterPanel
              workspace={workspace}
              activeWorkspaceId={activeWsId}
              picked={picked}
              onTogglePick={togglePick}
              editing={boardSelecting}
              onEditingChange={setBoardSelecting}
              onClipStaged={() => {
                // Land where the clipboard lives: the canvas with the
                // clipboard armed, tray showing what the board just staged.
                setView('canvas')
                setClipping(true)
                setTool('move')
              }}
              variant="view"
              onOpenGrants={() => setGrantOpen(true)}
              onClose={() => setView('canvas')}
            />
          )}
          {/* The clipboard's action bar: copy / cut / save / paste on the
              picked cards (cables included). Present the whole time the
              toggle is on — PASTE must be reachable before anything is
              picked. Hidden when a card zooms to full view. */}
          {workspace && clipping && view === 'canvas' && lod.primaryId === null && (
            <SelectionBar
              workspace={workspace}
              picked={picked}
              onClipChange={setClipInfo}
              onPasted={() => setClipping(false)}
            />
          )}
          {/* Right-click / long-press card edit menu: rename, save/fork by
              checkpoint, workdir. Rendered at viewport coordinates inside
              the stage; CardMenu dismisses itself outside / on Escape. */}
          {cardMenu &&
          workspace &&
          view === 'canvas' &&
          workspace.nodes.some((n) => n.id === cardMenu.nodeId) ? (
            <CardMenu
              anchor={cardMenu}
              workspace={workspace}
              onClose={() => setCardMenu(null)}
            />
          ) : null}
        </div>
        <Dock
          tool={tool}
          onSelect={selectTool}
          clipping={clipping}
          onToggleClipping={toggleClipping}
          presets={presets}
          preset={preset}
          onPreset={(name) => {
            setPreset(name)
            setRole(null)
            setPresetId(null)
          }}
          roles={roles}
          role={role}
          onRole={(name) => {
            setRole(name)
            setPresetId(null)
          }}
          installedPresets={installedPresets}
          presetId={presetId}
          onPresetChip={(id) => {
            // Arm only — the canvas click commits (R2).
            setPresetId(id)
            setRole(null)
          }}
          gatedPresetId={gatedId}
          onPresetGate={openPresetGate}
          onCheckUpdates={checkPresetUpdates}
          orch={orch}
          onOrch={setOrch}
          voiceFor={
            zoomedTerminalId && terminals.some((t) => t.id === zoomedTerminalId)
              ? { id: zoomedTerminalId, activity: activities[zoomedTerminalId] }
              : null
          }
          browserFor={browserInFullView(lod.primaryId, browsers)}
          /* Board view: the canvas tools glide out and the board's
             clipboard selection toggle glides in — the SAME dock, the same
             motion as zooming a terminal. */
          boardFor={
            view === 'agents'
              ? { editing: boardSelecting, onToggle: () => setBoardSelecting((v) => !v) }
              : null
          }
          connectHint={
            tool === 'connect'
              ? connectFrom
                ? 'NOW CLICK THE TARGET NODE TO FINISH THE CABLE'
                : 'CLICK THE FIRST NODE TO CONNECT'
              : null
          }
        />
        <TerminalOverlayLayer
          terminals={terminals}
          activities={activities}
          lod={lod}
          onPrimaryChange={setZoomedTerminalId}
        />
        {metricsOpen && <MetricsPanel onClose={() => setMetricsOpen(false)} />}
        {grantOpen && activeWsId && (
          <GrantPanel
            workspace={workspace}
            workspaceId={activeWsId}
            onClose={() => setGrantOpen(false)}
          />
        )}
        {/* One confirmation for every close path. Rendered last so it sits over
            the zoomed overlays the ✕ was clicked in. A node that vanished while
            the dialog was open (⌘W elsewhere, a crash) simply has nothing to
            confirm, so the lookup failing closes it rather than throwing. */}
        {closingNode && (
          <ConfirmClose
            node={closingNode}
            activity={activities[closingNode.id] ?? null}
            onCancel={() => setClosingId(null)}
            onConfirm={() => confirmClose(closingNode.id)}
          />
        )}
        <BrowserLayer
          browsers={browsers}
          lod={lod}
          onThumb={onThumb}
          isPhoneViewing={isPhoneViewing}
          interactiveCapability={interactiveCapability}
        />
        <EventToastLayer />
        <ReauthOverlay />
      </div>
    </CanvasUiContext.Provider>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </ErrorBoundary>
  )
}
