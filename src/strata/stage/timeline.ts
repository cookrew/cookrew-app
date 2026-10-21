// A flight as data: from the rects read once at take-off to the keyframes the
// compositor plays (motion.html §2–3). Pure; the DOM side only hands rects in
// and keyframes out.
//
// Progress p runs 0 → 1 in the direction of travel. A zoom is described in the
// "in" direction (u, shallow → deep) and an out flight is the same flight with
// u = 1 − p, so out is exactly in played backwards.
import type { Rect } from '../../shared/strata'
import { aboutPoint, clampInto, fitStep, incomingAt, outgoingAt, pivotOf, pushOf, toCss, type Fit, type Point } from './camera'
import { DIVE, FLY, cssOf } from './easing'
import type { FlightPlan } from './plan'

export interface StepGeometry {
  fit: Fit
  /** The outgoing scene's scale at the end of the step. */
  push: number
  /** The paper's pivot (gridPivot); null = the step barely zooms and the paper stays still. */
  grid: Point | null
  /** Share of a multi-step timeline: its log-zoom. */
  weight: number
}

export type FlightGeometry =
  | { kind: 'zoom'; dir: 1 | -1; viewport: Rect; steps: StepGeometry[] }
  | { kind: 'hop'; viewport: Rect; from: number; to: number; count: number }
  | { kind: 'fade'; from: number; to: number; count: number }

/** The rects of one step as read at take-off; `content` null = the child's whole viewport. */
export interface StepRects {
  anchor: Rect | null
  content: Rect | null
}

export interface LayerState {
  transform: string
  opacity: number
}

export interface FrameState {
  scenes: LayerState[]
  coarse: LayerState
  fine: LayerState
}

export interface FlightFrames {
  scenes: Keyframe[][]
  coarse: Keyframe[]
  fine: Keyframe[]
}

/** Incoming fades in over this share of its step; outgoing fades out over the last share. */
export const IN_FADE: readonly [number, number] = [0, 0.25]
export const OUT_FADE: readonly [number, number] = [0.6, 1]
export const HOP_MS = 340
export const FADE_MS = 120
const HOP_DIP = 0.94
const GRID_STEP = 2
/** The paper's dot pitch (stage.css); the fine layer is half of it. */
export const GRID_CELL = 24
const SAMPLES_PER_STEP = 16

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const window01 = (v: number, [a, b]: readonly [number, number]) => clamp((v - a) / (b - a), 0, 1)
const IDENTITY = 'none'

export const geometryOf = (plan: Exclude<FlightPlan, { kind: 'none' }>, rects: StepRects[], viewport: Rect, reduced: boolean): FlightGeometry => {
  const count = plan.scenes.length
  const from = plan.dir > 0 ? 0 : count - 1
  const to = count - 1 - from
  if (reduced) return { kind: 'fade', from, to, count }
  if (plan.kind === 'hop') return { kind: 'hop', viewport, from: 0, to: 1, count }
  const steps = plan.steps.map((step, i): StepGeometry | null => {
    const r = rects[i]
    const fit = r?.anchor ? fitStep(r.anchor, r.content ?? viewport) : null
    if (!fit) return null
    const F = fit.K >= GRID_STEP ? pivotOf(fit) : null
    return { fit, push: pushOf(fit.K, step.opens), grid: F && gridPivot(F, viewport), weight: Math.max(0.35, Math.log(Math.min(fit.K, 12))) }
  })
  if (steps.some((s) => s === null)) return { kind: 'hop', viewport, from, to, count }
  return { kind: 'zoom', dir: plan.dir, viewport, steps: steps as StepGeometry[] }
}

/**
 * F kept inside the viewport (so a viewport-sized layer always covers) and put
 * on the dot lattice: the fine layer doubled about a lattice point lands
 * exactly on the coarse one, so the swap at the end of a step is invisible.
 */
export const gridPivot = (F: Point, viewport: Rect): Point => {
  const p = clampInto(F, viewport)
  return { x: Math.round(p.x / GRID_CELL) * GRID_CELL, y: Math.round(p.y / GRID_CELL) * GRID_CELL }
}

export const stepDuration = (K: number): number => clamp(400 + 75 * Math.log(K), 450, 650)

export const durationOf = (geom: FlightGeometry): number => {
  if (geom.kind === 'fade') return FADE_MS
  if (geom.kind === 'hop') return HOP_MS
  const sum = geom.steps.reduce((s, step) => s + stepDuration(step.fit.K), 0)
  if (geom.steps.length === 1) return Math.round(sum)
  if (geom.steps.length === 2) return Math.round(clamp(0.62 * sum, 560, 760))
  return Math.round(clamp(0.5 * sum, 700, 850))
}

export const easingOf = (geom: FlightGeometry): string =>
  geom.kind === 'fade' ? 'linear' : cssOf(geom.kind === 'zoom' && geom.steps.length > 1 ? DIVE : FLY)

/** Step boundaries on the u axis, by log-zoom weight: [0, b1, …, 1]. */
export const boundariesOf = (steps: StepGeometry[]): number[] => {
  const total = steps.reduce((s, step) => s + step.weight, 0)
  return steps.reduce<number[]>((acc, step) => [...acc, acc[acc.length - 1] + step.weight / total], [0]).map((b, i, all) => (i === all.length - 1 ? 1 : b))
}

const rest = (): LayerState => ({ transform: IDENTITY, opacity: 1 })
const gone = (transform: string): LayerState => ({ transform, opacity: 0 })
const STILL_GRID = { coarse: rest(), fine: { transform: IDENTITY, opacity: 0 } }

/** The zoom at in-direction u, evaluated inside step `seg` (explicit, so both sides of a boundary are reachable). */
const zoomState = (steps: StepGeometry[], bounds: number[], u: number, seg: number): FrameState => {
  const v = clamp((u - bounds[seg]) / (bounds[seg + 1] - bounds[seg]), 0, 1)
  const scenes = Array.from({ length: steps.length + 1 }, (_, j): LayerState => {
    if (j < seg) return gone(toCss(outgoingAt(steps[j].fit, steps[j].push, 1)))
    if (j > seg + 1) return gone(toCss(incomingAt(steps[j - 1].fit, 0)))
    const step = steps[seg]
    if (j === seg) return { transform: toCss(outgoingAt(step.fit, step.push, v)), opacity: 1 - window01(v, OUT_FADE) }
    return { transform: toCss(incomingAt(step.fit, v)), opacity: window01(v, IN_FADE) }
  })
  const g = steps[seg].grid
  if (!g) return { scenes, ...STILL_GRID }
  const paper = toCss(aboutPoint(g, Math.pow(GRID_STEP, v)))
  return { scenes, coarse: { transform: paper, opacity: 1 - v }, fine: { transform: paper, opacity: v } }
}

const segmentAt = (bounds: number[], u: number): number => {
  const last = bounds.length - 2
  for (let i = 0; i <= last; i++) if (u < bounds[i + 1]) return i
  return last
}

/** Every layer at progress p (0 → 1 along the direction of travel). */
export const stateAt = (geom: FlightGeometry, p: number): FrameState => {
  const t = clamp(p, 0, 1)
  if (geom.kind === 'fade') {
    const scenes = Array.from({ length: geom.count }, (_, j) => ({ transform: IDENTITY, opacity: j === geom.from ? 1 - t : j === geom.to ? t : 0 }))
    return { scenes, ...STILL_GRID }
  }
  if (geom.kind === 'hop') {
    const c = { x: geom.viewport.x + geom.viewport.w / 2, y: geom.viewport.y + geom.viewport.h / 2 }
    const out = window01(t, [0, 0.55])
    const inn = window01(t, [0.3, 1])
    const scenes = Array.from({ length: geom.count }, (_, j): LayerState => {
      if (j === geom.from) return { transform: toCss(aboutPoint(c, 1 - (1 - HOP_DIP) * out)), opacity: 1 - out }
      if (j === geom.to) return { transform: toCss(aboutPoint(c, HOP_DIP + (1 - HOP_DIP) * inn)), opacity: inn }
      return gone(IDENTITY)
    })
    return { scenes, ...STILL_GRID }
  }
  const bounds = boundariesOf(geom.steps)
  const u = geom.dir > 0 ? t : 1 - t
  return zoomState(geom.steps, bounds, u, segmentAt(bounds, u))
}

const toKeyframe = (offset: number, s: LayerState): Keyframe => ({ offset, transform: s.transform, opacity: s.opacity })

/**
 * Keyframes for progress p0 → p1 (either order; a spring-back runs p backwards).
 * Sampled densely so log-space zoom survives the browser's linear interpolation
 * between keyframes; step boundaries get both of their sides at one offset.
 */
export const framesFor = (geom: FlightGeometry, p0 = 0, p1 = 1): FlightFrames => {
  const span = p1 - p0
  const samples = geom.kind === 'zoom' ? SAMPLES_PER_STEP * geom.steps.length : geom.kind === 'hop' ? 8 : 1
  const n = Math.max(1, Math.ceil(samples * Math.abs(span)))
  const points: Array<{ offset: number; state: FrameState }> = []
  const push = (offset: number, state: FrameState) => points.push({ offset: clamp(offset, 0, 1), state })

  if (geom.kind !== 'zoom') {
    for (let i = 0; i <= n; i++) push(i / n, stateAt(geom, p0 + span * (i / n)))
  } else {
    const bounds = boundariesOf(geom.steps)
    const uOf = (p: number) => (geom.dir > 0 ? p : 1 - p)
    const u0 = uOf(p0)
    const u1 = uOf(p1)
    const rising = u1 >= u0
    const inner = bounds.slice(1, -1).filter((b) => (rising ? b > u0 && b < u1 : b < u0 && b > u1))
    const edges = inner.map((b) => ({ t: (b - u0) / (u1 - u0), boundary: bounds.indexOf(b) }))
    // A uniform sample sitting on a boundary would put a third keyframe at that offset; the boundary pair wins.
    const ts = Array.from({ length: n + 1 }, (_, i) => i / n).filter((t) => !edges.some((e) => Math.abs(e.t - t) < 1e-9))
    const events = [...ts.map((t) => ({ t, boundary: -1 })), ...edges].sort((a, b) => a.t - b.t)
    for (const ev of events) {
      const u = u0 + (u1 - u0) * ev.t
      if (ev.boundary < 0) {
        push(ev.t, zoomState(geom.steps, bounds, u, segmentAt(bounds, u)))
        continue
      }
      // Boundary b_i joins step i-1 (its end) and step i (its start): emit both, in travel order.
      const before = zoomState(geom.steps, bounds, u, ev.boundary - 1)
      const after = zoomState(geom.steps, bounds, u, ev.boundary)
      push(ev.t, rising ? before : after)
      push(ev.t, rising ? after : before)
    }
  }
  const count = points[0].state.scenes.length
  return {
    scenes: Array.from({ length: count }, (_, j) => points.map((pt) => toKeyframe(pt.offset, pt.state.scenes[j]))),
    coarse: points.map((pt) => toKeyframe(pt.offset, pt.state.coarse)),
    fine: points.map((pt) => toKeyframe(pt.offset, pt.state.fine))
  }
}
