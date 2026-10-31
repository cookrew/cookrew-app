// THE EMBED ROOT: the companion as ONE agent's terminal full view inside
// cookrew.dev's shell. Same TerminalOverlayLayer → TerminalOverlayFor →
// TerminalOverlay chain, same Dock in its zoomed state, same app classes
// around them — only the canvas, the header and the workspace load are gone.
//
// It never asks the desktop to switch workspaces: the agent comes from
// GET api/levels/agents/<id>, and the terminal stream already works for an
// agent in a background workspace. Leaving (the overlay's back or close, Esc)
// is strata:out, and the shell pops one level; nothing here closes a card.
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TerminalActivity } from '../../../shared/turn'
import { activityStore, ACTIVITY_SEED_DEADLINE_MS, markActivitySeeded } from '../activity-thumb-store'
import { cookrew } from '../api'
import { CanvasUiContext, type CanvasUi } from '../canvas-ui'
import { Dock } from '../Dock'
import { tuningStore } from '../tuning-store'
import { mergeActivity } from '../turn-view-model'
import type { LodLayout, ScreenRect } from '../zoom-lod'
import { AttachmentRails } from './AttachmentRails'
import { scaleFor } from './rail-layout'
import { fetchAgentDetail, nodeOfDetail, type EmbedDetail } from './embed-boot'
import { createDetailLoader } from './detail-loader'
import { listenToShell, tellShell } from './embed-bridge'
import type { EmbedMode } from './embed-mode'
import './embed.css'

const loadOverlay = () => import('../TerminalOverlay')
const TerminalOverlayLayer = lazy(() => loadOverlay().then((m) => ({ default: m.TerminalOverlayLayer })))

interface Target {
  agentId: string
  attachmentId: string | null
}

const NO_PICKS: ReadonlySet<string> = new Set()
const noop = (): void => undefined

/** The activity and dials feeds, exactly as App runs them: one snapshot, then pushes. */
function useAgentFeeds(): void {
  useEffect(() => {
    void cookrew()
      .listActivity()
      .then((list) => activityStore.seed(list.map((a) => [a.terminalId, a] as [string, TerminalActivity]), true))
      .catch(() => undefined)
      .finally(markActivitySeeded)
    const seedDeadline = setTimeout(markActivitySeeded, ACTIVITY_SEED_DEADLINE_MS)
    const offActivity = cookrew().onTerminalActivity((activity) => {
      activityStore.set(activity.terminalId, mergeActivity(activityStore.get(activity.terminalId), activity))
    })
    const snapshot = cookrew().listTuning
    if (snapshot) {
      void snapshot()
        .then((rows) => tuningStore.seed(Object.entries(rows), true))
        .catch(() => undefined)
    }
    const offTuning = cookrew().onTerminalTuning?.((row) => tuningStore.set(row.terminalId, row.tuning))
    return () => {
      clearTimeout(seedDeadline)
      offActivity()
      offTuning?.()
    }
  }, [])
}

const sameRect = (a: ScreenRect | null, b: ScreenRect): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * The stage's rect twice: `layout` is what the overlay is placed with — the
 * remote full view's own rule (zoom-lod.ts), the whole pane, never less — and
 * `screen` is where it lands on screen, which the rails lay out around. They
 * differ only under D9's preview-only scale, where the overlay sits inside the
 * transformed app (its fixed position then counts from it) at full layout size.
 */
function useStageRects(stage: React.RefObject<HTMLDivElement | null>, scaled: boolean): { layout: ScreenRect | null; screen: ScreenRect | null } {
  const [layout, setLayout] = useState<ScreenRect | null>(null)
  const [screen, setScreen] = useState<ScreenRect | null>(null)
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      const onScreen = { x: box.left, y: box.top, width: box.width, height: box.height }
      const placed = scaled ? { x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight } : onScreen
      setScreen((now) => (sameRect(now, onScreen) ? now : onScreen))
      setLayout((now) => (sameRect(now, placed) ? now : placed))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [stage, scaled])
  return { layout, screen }
}

/** D9 'scale' (preview only): the factor for this viewport, or null to draw at 1. */
function useScale(mode: EmbedMode['rails']): number | null {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    if (mode !== 'scale') return
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode])
  return mode === 'scale' ? scaleFor(width) : null
}

/** Fires once the lazy overlay has actually committed: the moment the shell may show the frame. */
function Mounted({ onMount }: { onMount: () => void }): null {
  useEffect(onMount, [onMount])
  return null
}

export default function EmbedRoot({ mode }: { mode: EmbedMode }): React.JSX.Element {
  const [target, setTarget] = useState<Target | null>(mode.agentId ? { agentId: mode.agentId, attachmentId: null } : null)
  const [detail, setDetail] = useState<EmbedDetail | null>(null)
  /** Details this document reads: one in flight at a time, the latest wins (detail-loader.ts). */
  const loader = useMemo(() => createDetailLoader(fetchAgentDetail), [])
  const shownId = useRef<string | null>(null)
  shownId.current = detail?.agent.id ?? null
  const stageRef = useRef<HTMLDivElement>(null)
  const scale = useScale(mode.rails)
  const { layout: rect, screen } = useStageRects(stageRef, scale !== null)
  useAgentFeeds()

  // Listening first, then say so: a prewarm tells the shell it may focus now.
  useEffect(() => {
    const off = listenToShell((message) => {
      if (message.type === 'strata:blur') setTarget(null)
      else if (message.type === 'strata:prefetch') loader.prefetch(message.agentId)
      else if (message.agentId === shownId.current) {
        // Refocused on the agent still mounted (a close the shell took back
        // inside the fade): nothing to load, it is ready as it stands.
        setTarget({ agentId: message.agentId, attachmentId: message.attachmentId ?? null })
        tellShell({ type: 'strata:ready', agentId: message.agentId })
      } else setTarget({ agentId: message.agentId, attachmentId: message.attachmentId ?? null })
    })
    if (!mode.agentId) tellShell({ type: 'strata:warm' })
    // The overlay's chunk is the cold part of a dive; a warm document has it already.
    void loadOverlay().catch(() => undefined)
    return off
  }, [mode.agentId, loader])

  useEffect(() => {
    if (!target) {
      setDetail(null)
      return
    }
    // Same agent, new attachment: the terminal stays mounted, only the rail moves.
    if (shownId.current === target.agentId) return
    // An agent read before (a prefetch on hover, or an earlier dive) mounts
    // at once and is read again behind it, so the rails and the card catch up
    // within one request.
    const known = loader.known(target.agentId)
    if (known) setDetail(known)
    let live = true
    void loader.load(target.agentId).then((result) => {
      if (!live) return
      if (result.ok) {
        setDetail(result.detail)
        return
      }
      if (result.detail === 'aborted') return
      setDetail(null)
      tellShell({ type: 'strata:error', code: result.code, ...(result.detail ? { detail: result.detail } : {}) })
    })
    return () => {
      live = false
    }
  }, [target, loader])

  // No Esc handler here, on purpose: Esc inside the terminal is the agent's
  // interrupt and goes to the PTY. Leaving is the full view's own Back (and its
  // close), which the CanvasUi below turns into strata:out.
  const out = useCallback(() => tellShell({ type: 'strata:out' }), [])

  const ui = useMemo<CanvasUi>(
    () => ({
      tool: 'move',
      clipping: false,
      interactiveBrowser: null,
      zoomToNode: noop,
      jumpToNode: async () => 'missed',
      zoomBack: out,
      requestClose: out,
      picked: NO_PICKS,
      togglePick: noop
    }),
    [out]
  )

  const node = useMemo(() => (detail ? nodeOfDetail(detail) : null), [detail])
  const lod = useMemo<LodLayout | null>(
    () => (node && rect ? { activeIds: new Set([node.id]), rects: { [node.id]: rect }, primaryId: node.id } : null),
    [node, rect]
  )
  const terminals = useMemo(() => (node ? [node] : []), [node])
  const readyFor = useCallback(() => {
    if (node) tellShell({ type: 'strata:ready', agentId: node.id })
  }, [node])

  return (
    <CanvasUiContext.Provider value={ui}>
      <div
        className="cr cr-app tool-move cr-embed"
        style={scale !== null ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}
      >
        <div className="cr-stage" ref={stageRef} />
        <Dock
          tool="move"
          onSelect={noop}
          clipping={false}
          onToggleClipping={noop}
          presets={[]}
          preset=""
          onPreset={noop}
          roles={[]}
          role={null}
          onRole={noop}
          orch={false}
          onOrch={noop}
          connectHint={null}
          onMake={noop}
          voiceFor={node ? { id: node.id, remote: node.servedSession != null } : null}
          browserFor={null}
          boardFor={null}
        />
        {lod && (
          <Suspense fallback={null}>
            <TerminalOverlayLayer terminals={terminals} lod={lod} />
            <Mounted key={node?.id} onMount={readyFor} />
          </Suspense>
        )}
        {target && !detail && <div className="cr-embed-status">OPENING…</div>}
      </div>
      {/* Outside the app on purpose: under D9's scale the rails stay full size in the freed columns. */}
      {detail && <AttachmentRails detail={detail} terminal={screen} focusAttachmentId={target?.attachmentId ?? null} />}
    </CanvasUiContext.Provider>
  )
}
