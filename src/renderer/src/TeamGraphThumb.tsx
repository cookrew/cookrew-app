import { useState } from 'react'
import type { TeamGraph, TeamGraphItem } from '../../shared/model'

/**
 * A team's shape as connected DOTS: one crafted glyph per element — dark
 * square = agent, amber circle = note, framed square = browser — laid out
 * by their real relative canvas positions, cables drawn between them.
 * Labels don't scale past a few elements, so names live on HOVER instead:
 * the tip names the element and its cables light up. The clipboard tray
 * and the saved-template picker share this, so "what travels" and "what a
 * template boots" read the same way everywhere.
 */
export function TeamGraphThumb({
  graph,
  width = 200,
  height = 72,
  movedIds
}: {
  graph: TeamGraph
  width?: number
  height?: number
  /** Ids that transfer whole on paste (cut, session-less) — marked ✂. */
  movedIds?: ReadonlySet<string>
}): React.JSX.Element | null {
  const [hoverId, setHoverId] = useState<string | null>(null)
  const { items, cables } = graph
  if (items.length === 0) return null

  const centers = new Map(
    items.map((i) => [
      i.id,
      { x: i.position.x + i.size.width / 2, y: i.position.y + i.size.height / 2 }
    ])
  )
  const xs = [...centers.values()].map((c) => c.x)
  const ys = [...centers.values()].map((c) => c.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(1, Math.max(...xs) - minX)
  const spanY = Math.max(1, Math.max(...ys) - minY)
  const pad = 10
  const toX = (x: number): number =>
    items.length === 1 ? width / 2 : pad + ((x - minX) / spanX) * (width - pad * 2)
  const toY = (y: number): number =>
    items.length === 1 ? height / 2 : pad + ((y - minY) / spanY) * (height - pad * 2)

  const glyph = (item: TeamGraphItem, x: number, y: number, hot: boolean): React.JSX.Element => {
    const s = hot ? 4.6 : 3.6
    if (item.kind === 'note') {
      return <circle cx={x} cy={y} r={s} fill="var(--amber)" stroke="var(--ink)" strokeWidth={1.2} />
    }
    if (item.kind === 'browser') {
      return (
        <rect
          x={x - s}
          y={y - s}
          width={s * 2}
          height={s * 2}
          fill="var(--cream-hi)"
          stroke="var(--ink)"
          strokeWidth={1.4}
        />
      )
    }
    return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} fill="var(--ink)" />
  }

  const hovered = hoverId === null ? null : (items.find((i) => i.id === hoverId) ?? null)
  const hoveredCenter = hovered ? centers.get(hovered.id) : undefined

  return (
    <div className="team-graph" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden>
        {cables.map((c, i) => {
          const a = centers.get(c.a)
          const b = centers.get(c.b)
          if (!a || !b) return null
          const hot = hoverId !== null && (c.a === hoverId || c.b === hoverId)
          return (
            <line
              key={i}
              x1={toX(a.x)}
              y1={toY(a.y)}
              x2={toX(b.x)}
              y2={toY(b.y)}
              stroke={hot ? 'var(--amber-deep)' : 'var(--ink-soft)'}
              strokeWidth={hot ? 2 : 1.2}
              strokeDasharray="3 3"
            />
          )
        })}
        {items.map((item) => {
          const c = centers.get(item.id)
          if (!c) return null
          return glyph(item, toX(c.x), toY(c.y), hoverId === item.id)
        })}
        {/* Fat invisible hit targets on top — 4px dots are not a hover
            surface, and phones get them as tap targets. */}
        {items.map((item) => {
          const c = centers.get(item.id)
          if (!c) return null
          return (
            <circle
              key={`hit-${item.id}`}
              cx={toX(c.x)}
              cy={toY(c.y)}
              r={10}
              fill="transparent"
              onMouseEnter={() => setHoverId(item.id)}
              onMouseLeave={() => setHoverId(null)}
              onPointerDown={() => setHoverId((prev) => (prev === item.id ? null : item.id))}
            />
          )
        })}
      </svg>
      {hovered && hoveredCenter && (
        <span
          className="team-graph-tip"
          style={{
            left: Math.max(30, Math.min(width - 30, toX(hoveredCenter.x))),
            top: Math.max(14, toY(hoveredCenter.y) - 8)
          }}
        >
          {hovered.name}
          {movedIds?.has(hovered.id) ? ' ✂' : ''}
        </span>
      )}
    </div>
  )
}
