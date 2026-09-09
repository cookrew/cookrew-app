import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Background,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Node,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import '../../../../src/renderer/src/styles.css'
import { TerminalNode } from '../../../../src/renderer/src/nodes/TerminalNode'
import { NoteNode } from '../../../../src/renderer/src/nodes/NoteNode'
import { BrowserNode } from '../../../../src/renderer/src/nodes/BrowserNode'
import { toFlowNode } from '../../../../src/renderer/src/flow-nodes'
import { useLodLayout } from '../../../../src/renderer/src/zoom-lod'
import type { CanvasNode } from '../../../../src/shared/model'
import { seedNodes } from './seed'

const nodeTypes = { terminal: TerminalNode, note: NoteNode, browser: BrowserNode }

/**
 * THE WIRING THIS GATE EXISTS FOR — App as it stood on dev before perf lane
 * L6 (2026-09-06), around the same real ReactFlow and the same real cards:
 *
 *   - the LOD arbitration (useLodLayout, and through it useViewport) runs in
 *     the component that renders ReactFlow, so every pan frame re-renders it;
 *   - the three node handlers are inline arrows, so every one of those
 *     renders hands each memo'd NodeWrapper new props.
 *
 * Together: every visible card re-renders on every viewport frame. The gate
 * asserts this fixture DOES that, so a green result on the app is known to
 * come from a counter that can see the trap.
 */
function LegacyCanvas({ canvas }: { canvas: CanvasNode[] }): React.JSX.Element {
  const [nodes, setNodes] = useState<Node[]>(() => canvas.map(toFlowNode))
  const overlayNodes = useMemo(() => canvas.filter((n) => n.kind !== 'note'), [canvas])
  useLodLayout(overlayNodes, true, null, null)
  return (
    <ReactFlow
      nodes={nodes}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange[]) => setNodes((prev) => applyNodeChanges(changes, prev))}
      onNodeContextMenu={(e) => e.preventDefault()}
      onNodeMouseEnter={() => undefined}
      onNodeMouseLeave={() => undefined}
      minZoom={0.1}
      maxZoom={8}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      fitView
    >
      <Background />
      <MiniMap pannable zoomable className="cookrew-minimap" />
    </ReactFlow>
  )
}

createRoot(document.getElementById('root')!).render(
  <div className="cr cr-app tool-move">
    <div className="cr-stage">
      <ReactFlowProvider>
        <LegacyCanvas canvas={seedNodes()} />
      </ReactFlowProvider>
    </div>
  </div>
)
