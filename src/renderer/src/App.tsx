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
  applyNodeChanges,
  useReactFlow,
  ReactFlowProvider
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AgentRole, CanvasNode, BrowserNodeData, TerminalNodeData, WorkspaceState } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { TerminalActivity } from '../../shared/turn'
import { cookrew, isRemoteMode } from './api'
import { isViewed, markViewed, pruneViewers, type ViewerClocks } from '../../shared/phone-viewing'
import { TerminalNode } from './nodes/TerminalNode'
import { NoteNode } from './nodes/NoteNode'
import { BrowserNode } from './nodes/BrowserNode'
import { CableEdge } from './CableEdge'
import { Header } from './Header'
import { Dock } from './Dock'
import { TerminalOverlayLayer } from './TerminalOverlay'
import { useLodLayout } from './zoom-lod'
import { BrowserLayer } from './BrowserLayer'
import { CanvasUiContext, ToolId } from './canvas-ui'
import { useBrowserEngine } from './browser-engine'
import { ErrorBoundary } from './ErrorBoundary'
import { snapCardChanges, MOUSE_SNAP_PX, TOUCH_SNAP_PX, SnapGuide } from './card-snap'
import { SnapGuides } from './SnapGuides'
import { TeamForkPicker } from './TeamForkPicker'
import { EventToastLayer } from './EventToast'
import { RosterPanel } from './RosterPanel'
import { MetricsPanel } from './MetricsPanel'

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

function toFlowNodes(state: WorkspaceState): Node[] {
  return state.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    data: { node: n },
    style: { width: n.size.width, height: n.size.height },
    dragHandle: '.node-header'
  }))
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
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [tool, setTool] = useState<ToolId>('select')
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [preset, setPreset] = useState('Shell')
  const [orch, setOrch] = useState(false)
  const [presets, setPresets] = useState<string[]>(['Shell'])
  const [roles, setRoles] = useState<AgentRole[]>([])
  /** Selected saved role for TERMINAL placement, or null for a plain preset. */
  const [role, setRole] = useState<string | null>(null)
  const [activities, setActivities] = useState<Record<string, TerminalActivity>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  /** Alignment guides while a card resize is snapped to a neighbour edge. */
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** Terminal whose overlay owns the stage — the dock shows its composer. */
  const [zoomedTerminalId, setZoomedTerminalId] = useState<string | null>(null)
  /** Team-fork picker overlay (opened from the header's ⑂ button). */
  const [teamPickerOpen, setTeamPickerOpen] = useState(false)
  /** Global agent roster panel (opened from the header). */
  const [rosterOpen, setRosterOpen] = useState(false)
  /** Activity metrics / history panel (opened from the header). */
  const [metricsOpen, setMetricsOpen] = useState(false)

  useEffect(() => {
    void cookrew()
      .listPresets()
      .then((list) => setPresets(list.map((p) => p.name)))
    // Saved roles ride alongside presets as terminal-creation options.
    void cookrew().roleList().then(setRoles).catch(() => undefined)
  }, [])
  const reactFlow = useReactFlow()
  const { screenToFlowPosition } = reactFlow
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

  useBrowserEngine()

  useEffect(() => {
    void cookrew()
      .getWorkspace()
      .then((state) => {
        setWorkspace(state)
        setNodes(toFlowNodes(state))
      })
    return cookrew().onWorkspaceState((state) => {
      setWorkspace(state)
      if (!draggingRef.current) setNodes(toFlowNodes(state))
    })
  }, [])

  useEffect(() => {
    void cookrew()
      .listActivity()
      .then((list) =>
        // Live events may land before this snapshot resolves — merge under
        // existing entries so the snapshot never clobbers fresher activity.
        setActivities((prev) => ({
          ...Object.fromEntries(list.map((a) => [a.terminalId, a])),
          ...prev
        }))
      )
    return cookrew().onTerminalActivity((activity) => {
      setActivities((prev) => ({ ...prev, [activity.terminalId]: activity }))
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

  const edges = useMemo(() => (workspace ? toFlowEdges(workspace) : []), [workspace])

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

  const onThumb = useCallback((id: string, dataUrl: string) => {
    setThumbs((prev) => ({ ...prev, [id]: dataUrl }))
    // Mirror to main so the mobile companion can serve it to the phone.
    cookrew().browserThumb(id, dataUrl)
  }, [])

  // A phone viewing a browser (polling its /thumb) must keep the desktop
  // capture loop alive for that browser even while the desktop window is
  // hidden. Main pings us on every poll; we keep a TTL clock per browser and
  // hand the capture loop a stable getter (a ref, so refreshes don't churn the
  // capture effect). Desktop-only — remote/demo apis no-op the subscription.
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

  // Remote (phone) mode: iframes can't capturePage(), so browser card thumbs
  // come from the desktop's capture loop via the mobile server.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  useEffect(() => {
    if (!isRemoteMode()) return
    const tick = (): void => {
      const browserIds = (workspaceRef.current?.nodes ?? [])
        .filter((n) => n.kind === 'browser')
        .map((n) => n.id)
      for (const id of browserIds) {
        void fetch(`/api/browser/${id}/thumb?v=${Date.now()}`)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (!blob) return
            setThumbs((prev) => {
              const old = prev[id]
              if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
              return { ...prev, [id]: URL.createObjectURL(blob) }
            })
          })
          .catch(() => undefined)
      }
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => clearInterval(timer)
  }, [])

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

  const ui = useMemo(
    () => ({ tool, activities, thumbs, zoomToNode, zoomBack }),
    [tool, activities, thumbs, zoomToNode, zoomBack]
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
        void cookrew().connectNodes(connectFrom, node.id)
        setConnectFrom(null)
        setTool('select')
      }
    },
    [tool, connectFrom]
  )

  const onPaneClick = useCallback(
    async (event: React.MouseEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      if (tool === 'terminal') {
        // window.prompt is unsupported in Electron — creation uses the
        // preset (or saved-role) chips in the dock; a role boots its preset
        // with the role prompt injected once the TUI is quiet (roleName path).
        const selectedRole = role ? roles.find((r) => r.name === role) : undefined
        const created = await cookrew().createTerminal(
          selectedRole
            ? { name: selectedRole.name, preset: selectedRole.preset, roleName: selectedRole.name, position, orch }
            : { name: preset, preset, position, orch }
        )
        setTool('select')
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
        setTool('select')
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
        setTool('select')
      } else {
        setConnectFrom(null)
      }
    },
    [tool, preset, role, roles, orch, screenToFlowPosition, zoomToNode]
  )

  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const node of deleted) void cookrew().removeNode(node.id)
  }, [])

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const edge of deleted) void cookrew().disconnect(edge.id)
  }, [])

  const onConnect = useCallback((params: { source: string | null; target: string | null }) => {
    if (params.source && params.target) void cookrew().connectNodes(params.source, params.target)
  }, [])

  const terminals = (workspace?.nodes.filter((n) => n.kind === 'terminal') ??
    []) as TerminalNodeData[]
  const browsers = (workspace?.nodes.filter((n) => n.kind === 'browser') ?? []) as BrowserNodeData[]
  // ONE shared overlay arbitration across terminals AND browsers — per-kind
  // instances each picked their own remote fullscreen winner, stacking a
  // browser view over the zoomed terminal (Magpie E2 HIGH 2).
  const overlayNodes = useMemo(() => [...terminals, ...browsers], [terminals, browsers])
  const lod = useLodLayout(overlayNodes)
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
      zoomBack()
      void cookrew().removeNode(zoomedId)
      return
    }
    for (const node of nodes.filter((n) => n.selected)) void cookrew().removeNode(node.id)
  }

  return (
    <CanvasUiContext.Provider value={ui}>
      <div className={`cr cr-app tool-${tool}`}>
        <Header
          workspaceName={workspace?.name ?? 'Cookrew'}
          dir={workspace?.dir ?? ''}
          terminalCount={terminals.length}
          busyCount={busyCount}
          attentionCount={attentionCount}
          onTeamFork={() => setTeamPickerOpen(true)}
          onRoster={() => setRosterOpen(true)}
          onMetrics={() => setMetricsOpen(true)}
        />
        <div className="cr-stage">
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
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onConnect={onConnect}
            minZoom={0.1}
            maxZoom={8}
            onlyRenderVisibleElements
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#D9D3C5" />
            <SnapGuides guides={guides} />
            <MiniMap pannable zoomable className="cookrew-minimap" />
            <Controls position="bottom-right" />
          </ReactFlow>
        </div>
        <Dock
          tool={tool}
          onSelect={setTool}
          presets={presets}
          preset={preset}
          onPreset={(name) => {
            setPreset(name)
            setRole(null)
          }}
          roles={roles}
          role={role}
          onRole={setRole}
          orch={orch}
          onOrch={setOrch}
          voiceFor={
            zoomedTerminalId && terminals.some((t) => t.id === zoomedTerminalId)
              ? { id: zoomedTerminalId, activity: activities[zoomedTerminalId] }
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
        {teamPickerOpen && workspace && (
          <TeamForkPicker workspace={workspace} onClose={() => setTeamPickerOpen(false)} />
        )}
        {rosterOpen && <RosterPanel onClose={() => setRosterOpen(false)} />}
        {metricsOpen && <MetricsPanel onClose={() => setMetricsOpen(false)} />}
        <BrowserLayer
          browsers={browsers}
          lod={lod}
          onThumb={onThumb}
          isPhoneViewing={isPhoneViewing}
        />
        <EventToastLayer />
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
