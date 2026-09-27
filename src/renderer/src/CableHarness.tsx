import { memo, useEffect, useMemo, useState } from 'react'
import { ViewportPortal, type Edge, type Node } from '@xyflow/react'
import {
  geometryKey,
  routeCables,
  type CableLink,
  type CableRect,
  type Harness
} from './cable-route'

/**
 * THE HARNESS LAYER — every cable on the canvas, drawn as one wiring diagram.
 *
 * Mounted only in the `harness` visual mode, where ReactFlow gets no edges at
 * all: a per-edge component cannot know that 65 other cables share its run,
 * and sharing the run is the whole point (cable-route.ts). This layer sees the
 * full list and draws each grid edge once.
 *
 * WHAT IT SUBSCRIBES TO, AND WHAT IT DOES NOT. Its inputs are the flow nodes
 * and edges App already holds. Those change when a card moves or a cable is
 * made — never on a pan or a zoom, which are a CSS transform on the viewport
 * and reach nothing here. So a pan renders this component zero times, which is
 * the render-count gate's condition (tests/perf/render-count.perf.ts), and a
 * drag re-renders it cheaply: the geometry key is a string join, and the
 * routing behind it waits SETTLE_MS for the drag to stop.
 *
 * Drawn in flow coordinates through the ViewportPortal, with non-scaling
 * strokes so a trunk is the same width on screen at any zoom.
 */

/** A drag re-keys geometry every frame; route once it has been still this long. */
const SETTLE_MS = 120
/** How many far-partner chips a card wears before the rest fold into a count. */
const CHIPS_PER_CARD = 6
const CHIP_W = 132
const CHIP_H = 34
/**
 * A chip is a TAB on its own card's border — it straddles the edge, half in
 * and half out. Seen on the real board: a chip placed wholly outside a card
 * lands in the 80 px gutter and on top of the neighbour; a tab pokes out by
 * CHIP_W / 2 and stays visibly attached to the card it belongs to.
 */
const CHIP_OVERHANG = CHIP_W / 2

function rectOf(node: Node): CableRect | null {
  const style = node.style as { width?: unknown; height?: unknown } | undefined
  const width = node.width ?? (typeof style?.width === 'number' ? style.width : node.measured?.width)
  const height = node.height ?? (typeof style?.height === 'number' ? style.height : node.measured?.height)
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null
  return { id: node.id, x: node.position.x, y: node.position.y, width, height }
}

/** Screen-pixel width of a trunk from how many cables share it. */
const trunkWidth = (count: number): number => 1.3 + Math.log2(count) * 0.9

interface Chip {
  card: string
  x: number
  y: number
  label: string
  more: boolean
}

/**
 * A far partner becomes a chip on the side of the card that faces it. Chips
 * stack down that side; past CHIPS_PER_CARD the rest fold into one "+N".
 */
function chipsFor(far: Harness['far'], rects: Map<string, CableRect>, names: Map<string, string>): Chip[] {
  const perCard = new Map<string, { other: string; right: boolean }[]>()
  for (const f of far) {
    const A = rects.get(f.a)
    const B = rects.get(f.b)
    if (!A || !B) continue
    const aRight = B.x + B.width / 2 > A.x + A.width / 2
    ;(perCard.get(f.a) ?? perCard.set(f.a, []).get(f.a)!).push({ other: f.b, right: aRight })
    ;(perCard.get(f.b) ?? perCard.set(f.b, []).get(f.b)!).push({ other: f.a, right: !aRight })
  }
  const chips: Chip[] = []
  for (const [card, partners] of perCard) {
    const r = rects.get(card)
    if (!r) continue
    const shown = partners.slice(0, partners.length > CHIPS_PER_CARD ? CHIPS_PER_CARD - 1 : CHIPS_PER_CARD)
    const tabX = (right: boolean): number => (right ? r.x + r.width - CHIP_OVERHANG : r.x - CHIP_OVERHANG)
    shown.forEach((p, i) => {
      chips.push({
        card,
        x: tabX(p.right),
        y: r.y + 8 + i * (CHIP_H + 6),
        label: names.get(p.other) ?? '',
        more: false
      })
    })
    if (shown.length < partners.length) {
      const right = shown.filter((p) => p.right).length * 2 >= shown.length
      chips.push({
        card,
        x: tabX(right),
        y: r.y + 8 + shown.length * (CHIP_H + 6),
        label: `+${partners.length - shown.length}`,
        more: true
      })
    }
  }
  return chips
}

interface Props {
  nodes: Node[]
  edges: Edge[]
}

function CableHarnessComponent({ nodes, edges }: Props): React.JSX.Element | null {
  const rects = useMemo(() => {
    const out: CableRect[] = []
    for (const n of nodes) {
      const r = rectOf(n)
      if (r) out.push(r)
    }
    return out
  }, [nodes])
  const links = useMemo<CableLink[]>(
    () => edges.map((e) => ({ id: e.id, a: e.source, b: e.target })),
    [edges]
  )
  const names = useMemo(() => {
    const out = new Map<string, string>()
    for (const n of nodes) {
      const data = n.data as { node?: { name?: unknown } } | undefined
      const name = data?.node?.name
      if (typeof name === 'string') out.set(n.id, name)
    }
    return out
  }, [nodes])
  const key = useMemo(() => geometryKey(rects, links), [rects, links])

  // The key the harness was last routed for. It trails `key` by SETTLE_MS so a
  // drag routes once, at the end, rather than sixty times a second.
  const [settled, setSettled] = useState(key)
  useEffect(() => {
    if (settled === key) return
    const timer = setTimeout(() => setSettled(key), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [key, settled])

  const harness = useMemo(() => routeCables(rects, links), [settled]) // eslint-disable-line react-hooks/exhaustive-deps
  const rectById = useMemo(() => new Map(rects.map((r) => [r.id, r])), [rects])
  const chips = useMemo(() => chipsFor(harness.far, rectById, names), [harness, rectById, names])

  if (harness.trunks.length === 0 && chips.length === 0) return null
  return (
    <ViewportPortal>
      <svg
        className="cr-harness"
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <g stroke="#2D2A20" strokeLinecap="round" fill="none">
          {harness.stubs.map((s) => (
            <line
              key={`${s.link}:${s.card}`}
              x1={s.from.x}
              y1={s.from.y}
              x2={s.to.x}
              y2={s.to.y}
              strokeWidth={1}
              strokeOpacity={0.45}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {harness.trunks.map((t) => (
            <line
              key={`${t.x1},${t.y1},${t.x2},${t.y2}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              strokeWidth={trunkWidth(t.count)}
              strokeOpacity={t.count > 1 ? 0.62 : 0.4}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <g fontFamily="ui-monospace, monospace" fontSize={17}>
          {chips.map((c, i) => (
            <g key={`${c.card}:${i}`}>
              <rect x={c.x} y={c.y} width={CHIP_W} height={CHIP_H} rx={6} fill="#FAF7EF" stroke="#2D2A20" strokeWidth={1.5} />
              <text x={c.x + 10} y={c.y + 24} fill={c.more ? '#6B6355' : '#211E17'} fontWeight={c.more ? 700 : 500}>
                {c.label.slice(0, 13)}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </ViewportPortal>
  )
}

export const CableHarness = memo(CableHarnessComponent)
