import { memo, useEffect, useMemo, useState } from 'react'
import { ViewportPortal, useStore, useStoreApi, type Edge, type Node } from '@xyflow/react'
import { geometryKey, routeCables, type CableLink, type CableRect } from './cable-route'
import { TAB_H, TAB_W, harnessView, stageOf, tabLayout, viewportKey } from './cable-view'

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
  /**
   * Each card's place in the workspace's node list — the order they were
   * created in, since the store appends. It is the only recency signal a card
   * carries today, and it is what puts the newest tab at the top of a stack.
   */
  const order = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes])
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
  // Cards whose fold has been clicked open. Kept here rather than in App: it
  // is this layer's own affordance and nothing else reads it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const chips = useMemo(
    () => tabLayout(view.tabs, rectById, names, order, expanded),
    [view.tabs, rectById, names, order, expanded]
  )

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
      </svg>
      {/*
        Tabs are real elements, not SVG. A 1 x 1 svg with overflow:visible
        paints outside its box but does not hit-test there, so a fold drawn as
        <rect> could never be clicked. As divs they get a true target, the
        canvas's own type rendering, and they ride the viewport transform like
        the paste ghosts do.
      */}
      {chips.map((c, i) => (
        <div
          key={`${c.card}:${c.partner ?? 'fold'}:${i}`}
          className={`cr-harness-tab${c.more ? ' fold' : ''}${c.hot ? ' hot' : ''}`}
          style={{
            transform: `translate(${c.x}px, ${c.y}px)`,
            width: TAB_W,
            height: TAB_H,
            opacity: dimmed && !c.hot ? 0.35 : 1,
            pointerEvents: c.more ? 'auto' : 'none'
          }}
          // Only the fold takes a click; a naming tab is a sign, not a control.
          onClick={
            c.more
              ? () =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(c.card)) next.delete(c.card)
                    else next.add(c.card)
                    return next
                  })
              : undefined
          }
          title={c.more ? undefined : c.label}
        >
          {c.label}
        </div>
      ))}
    </ViewportPortal>
  )
}

export const CableHarness = memo(CableHarnessComponent)
