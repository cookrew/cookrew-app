import { memo, useEffect, useMemo, useState } from 'react'
import { ViewportPortal, useStore, useStoreApi, type Edge, type Node } from '@xyflow/react'
import { geometryKey, routeCables, type CableLink, type CableRect } from './cable-route'
import { harnessView, stageOf, viewportKey, type ViewTab } from './cable-view'

/**
 * THE HARNESS LAYER — every cable on the canvas, drawn as one wiring diagram.
 *
 * Mounted in the `harness` visual mode (the default), where ReactFlow gets no
 * edges at all: a per-edge component cannot know that 65 other cables share
 * its run, and sharing the run is the whole point (cable-route.ts). This layer
 * sees the full list and draws each run once.
 *
 * TWO CLOCKS, DELIBERATELY APART.
 *
 * Routing is a function of card geometry and links — `nodes` and `edges`,
 * which a pan or a zoom never touches. A drag re-keys the geometry every
 * frame, so the route waits SETTLE_MS for the drag to stop and then runs once
 * (41-51 ms on the live board). Every cable is routed, however long: which of
 * them is shown is the other clock's business.
 *
 * Showing is a function of the viewport (cable-view.ts): a cable longer than
 * a few screens at this zoom is a tab, not a run; a run with no end on stage
 * is not drawn; a hovered card's cables are drawn whatever their length. This
 * layer subscribes to the viewport through `viewportKey` — a string that
 * changes at quarter-stage tiles and half-octaves of zoom — so it re-renders
 * a few times per screen of panning and never per frame, which is what the
 * render-count gate (tests/perf/render-count.perf.ts) requires of everything
 * but the LOD leaf.
 *
 * Hover is tracked here, on the flow's own DOM node, rather than lifted into
 * App: a hover that re-rendered App would re-render the app shell on every
 * card the pointer crossed.
 */

/** A drag re-keys geometry every frame; route once it has been still this long. */
const SETTLE_MS = 120
/** How many far-partner tabs a card wears before the rest fold into a count. */
const TABS_PER_CARD = 6
const TAB_W = 132
const TAB_H = 34
/**
 * A tab straddles its own card's border — half in, half out. Placed wholly
 * outside, it lands on the neighbour in an 80 px gutter.
 */
const TAB_OVERHANG = TAB_W / 2
const INK = '#2D2A20'
const HOT = '#D97706'

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
  hot: boolean
}

/** A far partner becomes a tab on the side of the card that faces it. */
function chipsFor(tabs: readonly ViewTab[], rects: ReadonlyMap<string, CableRect>, names: ReadonlyMap<string, string>): Chip[] {
  const perCard = new Map<string, { partner: string; right: boolean; hot: boolean }[]>()
  for (const t of tabs) {
    const me = rects.get(t.card)
    const other = rects.get(t.partner)
    if (!me || !other) continue
    const right = other.x + other.width / 2 > me.x + me.width / 2
    const list = perCard.get(t.card)
    const entry = { partner: t.partner, right, hot: t.hot }
    if (list) list.push(entry)
    else perCard.set(t.card, [entry])
  }
  const chips: Chip[] = []
  for (const [card, partners] of perCard) {
    const r = rects.get(card)
    if (!r) continue
    const tabX = (right: boolean): number => (right ? r.x + r.width - TAB_OVERHANG : r.x - TAB_OVERHANG)
    const shown = partners.slice(0, partners.length > TABS_PER_CARD ? TABS_PER_CARD - 1 : TABS_PER_CARD)
    shown.forEach((p, i) => {
      chips.push({ card, x: tabX(p.right), y: r.y + 8 + i * (TAB_H + 6), label: names.get(p.partner) ?? '', more: false, hot: p.hot })
    })
    if (shown.length < partners.length) {
      const right = shown.filter((p) => p.right).length * 2 >= shown.length
      chips.push({
        card,
        x: tabX(right),
        y: r.y + 8 + shown.length * (TAB_H + 6),
        label: `+${partners.length - shown.length}`,
        more: true,
        hot: false
      })
    }
  }
  return chips
}

/** The id of the card under the pointer, read off the flow's own DOM — never lifted into App. */
function useHoveredCard(): string | null {
  const domNode = useStore((s) => s.domNode)
  const [hovered, setHovered] = useState<string | null>(null)
  useEffect(() => {
    if (!domNode) return
    const over = (e: Event): void => {
      const el = (e.target as Element | null)?.closest?.('.react-flow__node')
      const id = el?.getAttribute('data-id') ?? null
      setHovered((h) => (h === id ? h : id))
    }
    const leave = (): void => setHovered((h) => (h === null ? h : null))
    domNode.addEventListener('pointerover', over)
    domNode.addEventListener('pointerleave', leave)
    return () => {
      domNode.removeEventListener('pointerover', over)
      domNode.removeEventListener('pointerleave', leave)
    }
  }, [domNode])
  return hovered
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
  // One link per id. A duplicate edge id would collide in the router's run
  // lists and in this layer's React keys — and a key collision makes React
  // append rather than update, so the harness would grow on every re-render.
  const links = useMemo<CableLink[]>(() => {
    const seen = new Set<string>()
    const out: CableLink[] = []
    for (const e of edges) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push({ id: e.id, a: e.source, b: e.target })
    }
    return out
  }, [edges])
  const names = useMemo(() => {
    const out = new Map<string, string>()
    for (const n of nodes) {
      const data = n.data as { node?: { name?: unknown } } | undefined
      const name = data?.node?.name
      if (typeof name === 'string') out.set(n.id, name)
    }
    return out
  }, [nodes])
  const rectById = useMemo(() => new Map(rects.map((r) => [r.id, r])), [rects])

  // ---- clock one: geometry → routes, after the drag settles
  const key = useMemo(() => geometryKey(rects, links), [rects, links])
  const [settled, setSettled] = useState(key)
  useEffect(() => {
    if (settled === key) return
    const timer = setTimeout(() => setSettled(key), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [key, settled])
  const harness = useMemo(
    () => routeCables(rects, links, { farPx: Number.POSITIVE_INFINITY }),
    [settled] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ---- clock two: viewport → what is shown, a few times per screen
  const store = useStoreApi()
  const vkey = useStore((s) => viewportKey(s.transform, s.width, s.height))
  const stage = useMemo(() => {
    const s = store.getState()
    return stageOf(s.transform, s.width, s.height)
  }, [vkey, store]) // eslint-disable-line react-hooks/exhaustive-deps
  const hovered = useHoveredCard()
  const view = useMemo(() => harnessView(harness, rects, links, stage, hovered), [harness, rects, links, stage, hovered])
  const chips = useMemo(() => chipsFor(view.tabs, rectById, names), [view.tabs, rectById, names])

  if (view.trunks.length === 0 && chips.length === 0) return null
  const dimmed = hovered !== null
  return (
    <ViewportPortal>
      <svg
        className="cr-harness"
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <g strokeLinecap="round" fill="none">
          {view.stubs.map((s) => {
            const hot = view.hot.has(s.link)
            return (
              <line
                key={`${s.link}:${s.card}`}
                x1={s.from.x}
                y1={s.from.y}
                x2={s.to.x}
                y2={s.to.y}
                stroke={hot ? HOT : INK}
                strokeWidth={hot ? 2 : 1}
                strokeOpacity={hot ? 0.95 : dimmed ? 0.16 : 0.45}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
          {view.trunks.map((t) => (
            <line
              key={`${t.x1},${t.y1},${t.x2},${t.y2}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.hot ? HOT : INK}
              strokeWidth={trunkWidth(t.count) + (t.hot ? 1.2 : 0)}
              strokeOpacity={t.hot ? 0.95 : dimmed ? 0.18 : t.count > 1 ? 0.62 : 0.4}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <g fontFamily="ui-monospace, monospace" fontSize={17}>
          {chips.map((c, i) => (
            <g key={`${c.card}:${i}`} opacity={dimmed && !c.hot ? 0.35 : 1}>
              <rect x={c.x} y={c.y} width={TAB_W} height={TAB_H} rx={6} fill="#FAF7EF" stroke={c.hot ? HOT : INK} strokeWidth={c.hot ? 2.5 : 1.5} />
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
