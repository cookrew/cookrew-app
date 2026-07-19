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
import type { CanvasNode, BrowserNodeData, TerminalNodeData, WorkspaceState } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { TerminalActivity } from '../../shared/turn'
import { cookrew, isRemoteMode } from './api'
import { TerminalNode } from './nodes/TerminalNode'
import { NoteNode } from './nodes/NoteNode'
import { BrowserNode } from './nodes/BrowserNode'
import { RopeEdge } from './RopeEdge'
import { Header } from './Header'
import { Dock } from './Dock'
import { TerminalOverlayLayer } from './TerminalOverlay'
import { BrowserLayer } from './BrowserLayer'
import { CanvasUiContext, ToolId } from './canvas-ui'
import { useBrowserEngine } from './browser-engine'
import { ErrorBoundary } from './ErrorBoundary'

const nodeTypes = { terminal: TerminalNode, note: NoteNode, browser: BrowserNode }
const edgeTypes = { rope: RopeEdge }

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
    type: 'rope'
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
  const [activities, setActivities] = useState<Record<string, TerminalActivity>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  useEffect(() => {
    void cookrew()
      .listPresets()
      .then((list) => setPresets(list.map((p) => p.name)))
  }, [])
  const reactFlow = useReactFlow()
  const { screenToFlowPosition } = reactFlow
  const draggingRef = useRef(false)
  /** Viewport before the last zoomToNode, so ⤢ CANVAS can return to it. */
  const prevViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null)
  /** Node currently zoomed into full view — drives layered ⌘W. */
  const zoomedNodeIdRef = useRef<string | null>(null)
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

  const edges = useMemo(() => (workspace ? toFlowEdges(workspace) : []), [workspace])

  // Semantic zoom: clicking a card animates the viewport until the card
  // fills the stage; crossing the coverage threshold swaps its thumbnail
  // for the full renderer (see zoom-lod.ts).
  const zoomToNode = useCallback(
    (id: string) => {
      // Save the return point only when not already mid-zoom: a second click
      // during the animation (or on another card) must not clobber the
      // original overview viewport that ⤢ CANVAS goes back to.
      if (!prevViewportRef.current) prevViewportRef.current = reactFlow.getViewport()
      zoomedNodeIdRef.current = id
      void reactFlow.fitView({ nodes: [{ id }], duration: 500, padding: 0.02 })
    },
    [reactFlow]
  )

  const zoomBack = useCallback(() => {
    const previous = prevViewportRef.current
    prevViewportRef.current = null
    zoomedNodeIdRef.current = null
    if (previous) {
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

  // ESC leaves a zoomed-in card back to the canvas overview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && zoomedNodeIdRef.current) {
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

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev))
  }, [])

  const onNodeDragStart = useCallback(() => {
    draggingRef.current = true
  }, [])

  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    draggingRef.current = false
    void cookrew().updateNode(node.id, { position: node.position })
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
        // preset chips in the dock; names come from the preset.
        await cookrew().createTerminal({ name: preset, preset, position, orch })
        setTool('select')
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
    [tool, preset, orch, screenToFlowPosition]
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
            <MiniMap pannable zoomable className="cookrew-minimap" />
            <Controls position="bottom-right" />
          </ReactFlow>
        </div>
        <Dock
          tool={tool}
          onSelect={setTool}
          presets={presets}
          preset={preset}
          onPreset={setPreset}
          orch={orch}
          onOrch={setOrch}
          connectHint={
            tool === 'connect'
              ? connectFrom
                ? 'NOW CLICK THE TARGET NODE TO FINISH THE CABLE'
                : 'CLICK THE FIRST NODE TO CONNECT'
              : null
          }
        />
        <TerminalOverlayLayer terminals={terminals} activities={activities} />
        <BrowserLayer browsers={browsers} onThumb={onThumb} />
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
