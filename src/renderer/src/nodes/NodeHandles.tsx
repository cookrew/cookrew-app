import { Handle, Position } from '@xyflow/react'

/**
 * Invisible connection anchors. Cookrew edges are logical (any node to any
 * node), but React Flow still requires source/target handles to exist.
 */
export function NodeHandles(): React.JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} className="ghost-handle" isConnectable />
      <Handle type="source" position={Position.Right} className="ghost-handle" isConnectable />
    </>
  )
}
