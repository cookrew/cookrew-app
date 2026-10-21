// THE STAGE (motion lane): rests only on the four stops and flies between them.
// React state changes at take-off and at landing only (stage-state.ts); the
// flight itself is Web Animations on the scene layers, built from rects read
// once at take-off (measure.ts → timeline.ts → runner.ts). Gestures scrub the
// same animations (input.ts). Spec: docs/strata-2026-10-21/glide/motion.html.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { levelOf, parentOf, type StrataPath } from '../../shared/strata'
import type { StageProps } from '../seams'
import { SceneAnchorsProvider, createRegistry, type AnchorRegistry } from './anchors'
import { SPRING, cssOf } from './easing'
import { focusAfterLanding } from './focus'
import { decide, rubberBand, type Direction } from './gesture'
import { useStageInput, type GestureSink } from './input'
import { measureFlight } from './measure'
import { browserAnimatedNow } from './nav-signal'
import { pathKey, planFlight, samePath } from './plan'
import { createRunner, type Landing, type Runner } from './runner'
import { initialStage, mountedScenes, onLand, onPath, onScrubStart, type Flight, type StageState } from './stage-state'
import { recordLanding, recordTakeoff } from './telemetry'
import { durationOf, easingOf } from './timeline'
import './stage.css'

interface Active {
  runner: Runner
  flight: Flight
}

type Gesture =
  | { mode: 'rubber'; dir: Direction; x: number }
  | { mode: 'scrub'; dir: Direction; target: StrataPath; p: number; release: { commit: boolean; speed: number } | null }

const LEVEL_LABEL = { machines: 'Machines', workspaces: 'Workspaces', agents: 'Agents', terminal: 'Terminal' } as const
const RUBBER_HOME_MS = 300
const EDGE_SHADE_MS = 120
const MAX_SPEED = 3

export function Stage({ path, scene, inTarget, onCommit, reducedMotion }: StageProps) {
  const [st, setSt] = useState<StageState>(() => initialStage(path))
  // Derived from the prop during render (no extra commit): a new path is a take-off.
  let state = st
  if (!samePath(st.seen, path)) {
    state = onPath(st, path, browserAnimatedNow())
    setSt(state)
  }

  const rootRef = useRef<HTMLDivElement>(null)
  const coarseRef = useRef<HTMLDivElement>(null)
  const fineRef = useRef<HTMLDivElement>(null)
  const edgeRefs = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({ left: null, right: null })
  const sceneEls = useRef(new Map<string, HTMLElement>())
  const registries = useRef(new Map<string, AnchorRegistry>())
  const sceneRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>())
  const scrollMemo = useRef(new Map<string, number>())
  const activeRef = useRef<Active | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const landedRef = useRef<{ flight: Flight; at: Landing } | null>(null)
  const restKeyRef = useRef(pathKey(state.rest))
  const stateRef = useRef(state)
  const propsRef = useRef({ inTarget, onCommit, reducedMotion })
  const sinkRef = useRef<GestureSink | null>(null)

  const scenes = mountedScenes(state)
  const restKey = pathKey(state.rest)

  const registryOf = (key: string): AnchorRegistry => {
    const known = registries.current.get(key)
    if (known) return known
    const made = createRegistry()
    registries.current.set(key, made)
    return made
  }
  const sceneRef = (key: string) => {
    const known = sceneRefs.current.get(key)
    if (known) return known
    const made = (el: HTMLDivElement | null) => (el ? sceneEls.current.set(key, el) : sceneEls.current.delete(key))
    sceneRefs.current.set(key, made)
    return made
  }

  const land = useCallback((id: number, at: Landing) => {
    const active = activeRef.current
    if (active?.flight.id === id) landedRef.current = { flight: active.flight, at }
    setSt((s) => onLand(s, id, at))
  }, [])

  /** Start the flight React just mounted: measure once, then hand it to the compositor. */
  const takeOff = (flight: Flight) => {
    const root = rootRef.current
    const coarse = coarseRef.current
    const fine = fineRef.current
    if (!root || !coarse || !fine) return
    const previous = activeRef.current
    // Every style the flight needs is set before the one read, so the first frame has no layout of its own.
    root.dataset.flying = ''
    for (const el of [...sceneEls.current.values(), coarse, fine]) {
      el.dataset.flying = ''
      el.style.willChange = 'transform, opacity'
    }

    if (previous && flight.replaces?.how === 'reverse' && previous.flight.id === flight.replaces.id) {
      recordLanding(previous.flight.id, 'replaced')
      recordTakeoff({ ...describe(flight, previous.runner), planned: previous.runner.duration })
      activeRef.current = { runner: previous.runner, flight }
      previous.runner.reverse().then(() => land(flight.id, 'to'))
      return
    }
    // Everything back to identity before the one read; the new animations exist before the next frame.
    if (previous) {
      previous.runner.release()
      recordLanding(previous.flight.id, 'replaced')
    }
    const lookup = { el: (k: string) => sceneEls.current.get(k), registry: (k: string) => registries.current.get(k), scroll: scrollMemo.current }
    const geometry = measureFlight(root, flight.plan, lookup, propsRef.current.reducedMotion)
    const layers = flight.plan.scenes.map((p) => sceneEls.current.get(pathKey(p))).filter((el): el is HTMLElement => !!el)
    if (layers.length !== flight.plan.scenes.length) return void land(flight.id, 'to')
    const runner = createRunner(flight.id, geometry, { scenes: layers, coarse, fine }, durationOf(geometry), easingOf(geometry), flight.mode === 'scrub')
    // Scenes of a replaced flight that this one does not show stay out of sight until landing unmounts them.
    for (const el of sceneEls.current.values()) if (!runner.elements.has(el)) el.style.opacity = '0'
    activeRef.current = { runner, flight }
    recordTakeoff(describe(flight, runner))
    if (flight.mode === 'auto') runner.play().then((at) => land(flight.id, at))
    else settleScrub()
  }

  /** A scrub's runner and its release can arrive in either order. */
  const settleScrub = () => {
    const g = gestureRef.current
    const active = activeRef.current
    if (!g || g.mode !== 'scrub' || !active || active.flight.mode !== 'scrub') return
    active.runner.scrub(g.p)
    if (!g.release) return
    const { commit, speed } = g.release
    gestureRef.current = null
    const id = active.flight.id
    active.runner.settle(commit, speed).then((at) => land(id, at))
    if (commit) propsRef.current.onCommit(g.target)
  }

  const afterLanding = () => {
    const root = rootRef.current
    const el = sceneEls.current.get(restKey)
    const active = activeRef.current
    activeRef.current = null
    active?.runner.release()
    if (active) recordLanding(active.flight.id, landedRef.current?.flight.id === active.flight.id ? landedRef.current.at : 'replaced')
    if (root) delete root.dataset.flying
    for (const layer of [coarseRef.current, fineRef.current]) layer?.style.removeProperty('will-change')
    if (el) {
      el.style.removeProperty('will-change')
      delete el.dataset.flying
      el.style.opacity = ''
      el.dataset.landed = ''
      window.setTimeout(() => delete el.dataset.landed, 220)
    }
    const landed = landedRef.current
    landedRef.current = null
    // A spring-back went nowhere: focus stays where it was.
    if (root && el && landed?.at !== 'from') focusAfterLanding(root, el, registries.current.get(restKey), state.rest, landed?.flight.plan ?? null)
    for (const key of [...registries.current.keys()]) {
      if (key === restKey) continue
      registries.current.delete(key)
      sceneRefs.current.delete(key)
    }
  }

  useLayoutEffect(() => {
    stateRef.current = state
    propsRef.current = { inTarget, onCommit, reducedMotion }
  })

  const flightId = state.flight?.id ?? 0
  useLayoutEffect(() => {
    const flight = state.flight
    if (flight) {
      if (activeRef.current?.flight.id !== flight.id) takeOff(flight)
      return
    }
    const moved = restKeyRef.current !== restKey
    restKeyRef.current = restKey
    if (activeRef.current || moved) afterLanding()
    // the deps are the flight's identity and the resting stop; everything else is read through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightId, restKey])

  // ── gestures ──
  const rubberEl = () => sceneEls.current.get(pathKey(stateRef.current.rest))
  const sink: GestureSink = {
    edgeOnly: () => levelOf(stateRef.current.rest) === 'terminal',
    begin(dir) {
      const s = stateRef.current
      if (s.flight || gestureRef.current) return 'busy'
      const level = levelOf(s.rest)
      const target = dir === 'in' ? (level === 'terminal' ? null : propsRef.current.inTarget()) : level === 'machines' ? null : parentOf(s.rest)
      if (!target || planFlight(s.rest, target).kind === 'none') {
        gestureRef.current = { mode: 'rubber', dir, x: 0 }
        if (propsRef.current.reducedMotion) shadeEdge(dir)
        return 'rubber'
      }
      gestureRef.current = { mode: 'scrub', dir, target, p: 0, release: null }
      setSt((x) => onScrubStart(x, target))
      return 'scrub'
    },
    move(travel, progress) {
      const g = gestureRef.current
      if (!g) return
      if (g.mode === 'scrub') {
        gestureRef.current = { ...g, p: progress }
        const active = activeRef.current
        if (active?.flight.mode === 'scrub') active.runner.scrub(progress)
        return
      }
      const el = rubberEl()
      if (!el || propsRef.current.reducedMotion) return
      const x = (g.dir === 'in' ? -1 : 1) * rubberBand(Math.max(0, travel), el.clientWidth)
      gestureRef.current = { ...g, x }
      el.style.transform = `translateX(${x}px)`
    },
    release(progress, velocity, flick, span) {
      const g = gestureRef.current
      if (!g) return
      if (g.mode === 'rubber') {
        gestureRef.current = null
        const el = rubberEl()
        if (!el || g.x === 0) return
        el.animate([{ transform: `translateX(${g.x}px)` }, { transform: 'none' }], { duration: RUBBER_HOME_MS, easing: cssOf(SPRING) })
        el.style.transform = ''
        return
      }
      const v = Math.min(MAX_SPEED, Math.max(-MAX_SPEED, velocity))
      gestureRef.current = { ...g, p: progress, release: { commit: decide(progress, v, flick), speed: v / Math.max(1, span) } }
      settleScrub()
    }
  }
  const shadeEdge = (dir: Direction) => {
    // Fingers left (in) pull the right edge into view; right (out) the left one.
    const edge = edgeRefs.current[dir === 'in' ? 'right' : 'left']
    edge?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], { duration: EDGE_SHADE_MS * 2 })
  }
  useLayoutEffect(() => {
    sinkRef.current = sink
  })
  useStageInput(rootRef, sinkRef)

  // The page itself must never turn a horizontal overscroll into history navigation.
  useEffect(() => {
    const targets = [document.documentElement, document.body]
    const before = targets.map((el) => el.style.overscrollBehaviorX)
    targets.forEach((el) => (el.style.overscrollBehaviorX = 'none'))
    return () => targets.forEach((el, i) => (el.style.overscrollBehaviorX = before[i]))
  }, [])

  return (
    <div ref={rootRef} className="glide-stage" data-level={levelOf(state.rest)} aria-busy={state.flight ? true : undefined}>
      <div className="glide-paper" aria-hidden="true">
        <div ref={coarseRef} className="glide-dots" />
        <div ref={fineRef} className="glide-dots glide-dots--fine" />
      </div>
      {scenes.map((p) => {
        const key = pathKey(p)
        return (
          <div key={key} ref={sceneRef(key)} className="glide-scene" role="region" aria-label={LEVEL_LABEL[levelOf(p)]} tabIndex={-1} data-scene={key}>
            <SceneSlot path={p} scene={scene} registry={registryOf(key)} />
          </div>
        )
      })}
      <div ref={(el) => (edgeRefs.current.left = el)} className="glide-edge glide-edge--left" aria-hidden="true" />
      <div ref={(el) => (edgeRefs.current.right = el)} className="glide-edge glide-edge--right" aria-hidden="true" />
    </div>
  )
}

/**
 * One level's content. Memoised on the scene function and the stop, so take-off
 * and landing commits never re-render a level that did not change (the landing
 * commit only unmounts the levels it left).
 */
const SceneSlot = memo(
  function SceneSlot({ path, scene, registry }: { path: StrataPath; scene: (path: StrataPath) => ReactNode; registry: AnchorRegistry }) {
    return <SceneAnchorsProvider registry={registry}>{scene(path)}</SceneAnchorsProvider>
  },
  (a, b) => a.scene === b.scene && a.registry === b.registry && pathKey(a.path) === pathKey(b.path)
)

const describe = (flight: Flight, runner: Runner) => {
  const g = runner.geometry
  return {
    id: flight.id,
    kind: flight.plan.kind,
    geometry: g.kind,
    mode: flight.mode,
    steps: flight.plan.steps.length,
    K: g.kind === 'zoom' ? g.steps.map((s) => Number(s.fit.K.toFixed(2))) : [],
    planned: runner.duration,
    easing: easingOf(g)
  }
}
