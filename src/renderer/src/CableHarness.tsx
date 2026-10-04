import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ViewportPortal, useStore, useStoreApi, type Edge, type Node } from '@xyflow/react'
import { cookrew } from './api'
import { geometryKey, routeCables, type CableLink, type CableRect } from './cable-route'
import {
  SIGNAL_TTL_MS,
  connectSignalFeed,
  linkBetween,
  litLinks,
  pathD,
  signalFeed,
  signalPath,
  tabSignal,
  trunkSignal,
  type LiveSignal
} from './cable-signal'
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
 *
 * SIGNALS ride the same two clocks and add no third. When one agent asks
 * another, or answers, main mints one frame (shared/cable-signal.ts) and the
 * feed (cable-signal.ts) holds it for a few seconds. This layer subscribes
 * to the feed: a signal's arrival and expiry each cost one render of this
 * component — a class on the trunks that carry the cable, a tab lit as a
 * lamp when the far end is off the stage, and one <div> per signal whose
 * movement is a CSS `offset-distance` keyframe, which Chromium runs on the
 * compositor. Nothing is in the tree when nothing is in flight, and a pan
 * reads the feed's unchanged snapshot, so the render-count gate holds.
 */

/** A drag re-keys geometry every frame; route once it has been still this long. */
const SETTLE_MS = 120
const INK = '#2D2A20'
const HOT = '#D97706'
/** The pulse fades out over the last part of its lifetime; the travel takes the rest. */
const SIGNAL_FADE_MS = 200

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

  // ---- signals: arrival and expiry, never a frame
  useEffect(() => connectSignalFeed(cookrew()), [])
  const signals = useSyncExternalStore(signalFeed.subscribe, signalFeed.snapshot, signalFeed.snapshot)
  const lit = useMemo(() => litLinks(signals, links), [signals, links])
  const pulses = useMemo(() => signalPulses(signals, links, harness, view.drawn), [signals, links, harness, view.drawn])
  // Cards whose fold has been clicked open. Kept here rather than in App: it
  // is this layer's own affordance and nothing else reads it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const chips = useMemo(
    () => tabLayout(view.tabs, rectById, names, order, expanded),
    [view.tabs, rectById, names, order, expanded]
  )

  if (view.trunks.length === 0 && chips.length === 0) return null
  const dimmed = hovered !== null
  const signalClass = (kind: 'ask' | 'answer' | null): string => (kind ? ` sig sig-${kind}` : '')
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
            const kind = lit.get(s.link)?.kind ?? null
            return (
              <line
                key={`${s.link}:${s.card}`}
                className={`cr-harness-stub${signalClass(kind)}`}
                x1={s.from.x}
                y1={s.from.y}
                x2={s.to.x}
                y2={s.to.y}
                stroke={hot ? HOT : INK}
                strokeWidth={hot || kind ? 2 : 1}
                strokeOpacity={hot ? 0.95 : dimmed ? 0.16 : 0.45}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
          {view.trunks.map((t) => {
            const kind = trunkSignal(t, lit)
            return (
              <line
                key={`${t.x1},${t.y1},${t.x2},${t.y2}`}
                className={`cr-harness-trunk${signalClass(kind)}`}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke={t.hot ? HOT : INK}
                strokeWidth={trunkWidth(t.count) + (t.hot || kind ? 1.2 : 0)}
                strokeOpacity={t.hot ? 0.95 : dimmed ? 0.18 : t.count > 1 ? 0.62 : 0.4}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </g>
      </svg>
      {/*
        The pulses. One element per signal in flight, in flow coordinates
        like the tabs, moved by a keyframe on `offset-distance` — the
        compositor's work, not React's and not the main thread's. Keyed on
        the stamp, so a refreshed signal restarts its travel.
      */}
      {pulses.map((p) => (
        <div
          key={`${p.signal.from}:${p.signal.to}:${p.signal.kind}:${p.signal.at}`}
          className={`cr-sig-dot ${p.signal.kind}`}
          style={{
            offsetPath: `path("${p.d}")`,
            ['--cr-sig-ms' as string]: `${Math.max(400, SIGNAL_TTL_MS[p.signal.kind] - SIGNAL_FADE_MS)}ms`
          }}
          aria-hidden="true"
        />
      ))}
      {/*
        Tabs are real elements, not SVG. A 1 x 1 svg with overflow:visible
        paints outside its box but does not hit-test there, so a fold drawn as
        <rect> could never be clicked. As divs they get a true target, the
        canvas's own type rendering, and they ride the viewport transform like
        the paste ghosts do.
      */}
      {chips.map((c, i) => {
        // The tab is the lamp: the cable it names is not drawn at this
        // viewport, so the traffic on it has nowhere else to show.
        const kind = c.partner === null ? null : tabSignal(lit, links, c.card, c.partner)
        return (
        <div
          key={`${c.card}:${c.partner ?? 'fold'}:${i}`}
          className={`cr-harness-tab${c.more ? ' fold' : ''}${c.hot ? ' hot' : ''}${signalClass(kind)}`}
          style={{
            transform: `translate(${c.x}px, ${c.y}px)`,
            width: TAB_W,
            height: TAB_H,
            opacity: dimmed && !c.hot && !kind ? 0.35 : 1,
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
        )
      })}
    </ViewportPortal>
  )
}

interface Pulse {
  signal: LiveSignal
  d: string
}

/**
 * One pulse per signal whose cable is drawn as a run here — sender's edge to
 * receiver's edge through the trunks that carry it. A signal on a cable
 * that is a tab at this viewport, or that the router could not route, has
 * no pulse: the lamp or the lit trunks say what there is to say.
 */
function signalPulses(
  signals: readonly LiveSignal[],
  links: readonly CableLink[],
  harness: ReturnType<typeof routeCables>,
  drawn: ReadonlySet<string>
): Pulse[] {
  const out: Pulse[] = []
  for (const signal of signals) {
    const link = linkBetween(links, signal.from, signal.to)
    if (!link || !drawn.has(link.id)) continue
    const points = signalPath(harness, link.id, signal.from)
    if (points) out.push({ signal, d: pathD(points) })
  }
  return out
}

export const CableHarness = memo(CableHarnessComponent)
