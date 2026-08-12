import { EdgeProps } from '@xyflow/react'

/**
 * Cable edge: a dashed bezier with a slack sag between
 * the two nodes, drawn beneath the node layer.
 */
export function CableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  data
}: EdgeProps): React.JSX.Element {
  const sag = Math.min(120, Math.hypot(targetX - sourceX, targetY - sourceY) * 0.2)
  const midX = (sourceX + targetX) / 2
  const midY = (sourceY + targetY) / 2 + sag
  const path = `M ${sourceX} ${sourceY} Q ${midX} ${midY} ${targetX} ${targetY}`
  // SELECT mode sets `hot` on the cables of the hovered card (App edges
  // memo) — the hover shows what would travel with the selection.
  const hot = (data as { hot?: boolean } | undefined)?.hot === true || selected

  return (
    <g className="cable-edge">
      <path
        id={id}
        d={path}
        fill="none"
        stroke={hot ? '#D97706' : '#2D2A20'}
        strokeWidth={hot ? 3 : 2}
        strokeDasharray="7 7"
        strokeLinecap="round"
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={16} />
    </g>
  )
}
