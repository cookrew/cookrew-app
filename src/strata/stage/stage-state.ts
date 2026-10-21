// What the stage has mounted and which flight it is in: a pure reducer, so the
// React side changes state only at take-off and at landing (two commits per
// transition, three for a scrub) and every interruption is testable.
import type { StrataPath } from '../../shared/strata'
import { depthOf, pathKey, planFlight, samePath, type FlightPlan } from './plan'

export type ActivePlan = Exclude<FlightPlan, { kind: 'none' }>

export interface Flight {
  id: number
  plan: ActivePlan
  /** 'scrub' waits for a gesture to drive it; 'auto' plays at once. */
  mode: 'auto' | 'scrub'
  /** A scrub whose target the history owner has taken (path === plan.to). */
  committed: boolean
  /** How the flight this one replaced gives way: played backwards, jumped to its end, or snapped back to its start. */
  replaces: { id: number; how: 'reverse' | 'finish' | 'cancel' } | null
}

export interface StageState {
  /** Where the camera rests (or rested before the current flight). */
  rest: StrataPath
  /** The last `path` prop handled. */
  seen: StrataPath
  flight: Flight | null
  /** Scenes of a replaced flight, kept mounted until the new one lands. */
  carry: StrataPath[]
  /** Pre-mounted, unseen, on pointer-down: where a click is about to go (paid before the click, not after). */
  warm: StrataPath | null
  nextId: number
}

export const initialStage = (path: StrataPath): StageState => ({ rest: path, seen: path, flight: null, carry: [], warm: null, nextId: 1 })

/** Pre-mount `target` (or drop the pre-mounted level with null); only at rest. */
export const onWarm = (st: StageState, target: StrataPath | null): StageState => {
  if (st.flight) return st
  if (target === null) return st.warm ? { ...st, warm: null } : st
  if (planFlight(st.rest, target).kind === 'none' || (st.warm && samePath(st.warm, target))) return st
  return { ...st, warm: target }
}

const fly = (st: StageState, plan: ActivePlan, mode: Flight['mode'], replaces: Flight['replaces'], carry: StrataPath[]): StageState => ({
  ...st,
  flight: { id: st.nextId, plan, mode, committed: false, replaces },
  carry,
  nextId: st.nextId + 1
})

/**
 * A new `path` prop. `browserAnimated` = the browser already showed this
 * change itself (iOS edge swipe, gesture navigation): land without a flight.
 */
export const onPath = (st: StageState, path: StrataPath, browserAnimated: boolean): StageState => {
  if (samePath(st.seen, path)) return st
  // Any take-off consumes the pre-mounted level: if it is the target it is already in the flight's scenes.
  const base = { ...st, seen: path, warm: null }
  const current = st.flight

  if (!current) {
    const plan = planFlight(st.rest, path)
    if (plan.kind === 'none') return base
    if (browserAnimated) return { ...base, rest: path }
    return fly(base, plan, 'auto', null, [])
  }

  if (browserAnimated) return { ...base, rest: path, flight: null, carry: [] }

  if (current.mode === 'scrub') {
    if (samePath(path, current.plan.to)) return { ...base, flight: { ...current, committed: true } }
    const plan = planFlight(current.plan.from, path)
    if (plan.kind === 'none') return { ...base, rest: current.plan.from, flight: null, carry: [] }
    return fly(base, plan, 'auto', { id: current.id, how: 'cancel' }, current.plan.scenes)
  }

  if (samePath(path, current.plan.from)) {
    const back = planFlight(current.plan.to, current.plan.from)
    if (back.kind !== 'none') return fly(base, back, 'auto', { id: current.id, how: 'reverse' }, current.plan.scenes)
  }
  const plan = planFlight(current.plan.to, path)
  if (plan.kind === 'none') return base
  return fly({ ...base, rest: current.plan.to }, plan, 'auto', { id: current.id, how: 'finish' }, current.plan.scenes)
}

/** A gesture wants to scrub toward `target`; only from rest. */
export const onScrubStart = (st: StageState, target: StrataPath): StageState => {
  if (st.flight) return st
  const plan = planFlight(st.rest, target)
  return plan.kind === 'none' ? st : fly({ ...st, warm: null }, plan, 'scrub', null, [])
}

/** The flight `id` finished at its end ('to') or snapped back to its start ('from'). */
export const onLand = (st: StageState, id: number, at: 'to' | 'from'): StageState => {
  if (st.flight?.id !== id) return st
  const rest = at === 'to' ? st.flight.plan.to : st.flight.plan.from
  const landed: StageState = { ...st, rest, flight: null, carry: [] }
  // The URL is the truth: a scrub the history owner did not follow, or a path that moved on, flies again from here.
  return samePath(rest, st.seen) ? landed : onPath({ ...landed, seen: rest }, st.seen, false)
}

/** Scenes to mount, deepest on top (a hop keeps its target above). */
export const mountedScenes = (st: StageState): StrataPath[] => {
  const all = [...st.carry, ...(st.flight?.plan.scenes ?? []), st.rest, ...(st.warm ? [st.warm] : [])]
  const unique = [...new Map(all.map((p) => [pathKey(p), p])).values()]
  return unique
    .map((p, i) => ({ p, i }))
    .sort((a, b) => depthOf(a.p) - depthOf(b.p) || a.i - b.i)
    .map(({ p }) => p)
}
