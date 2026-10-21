// Which flight a path change is (motion.html §3): in / out one level, dive /
// rise through several, a hop between unrelated stops, or nothing. Pure.
import { levelOf, type AnchorId, type StrataLevel, type StrataPath } from '../../shared/strata'

const DEPTH: Record<StrataLevel, number> = { machines: 0, workspaces: 1, agents: 2, terminal: 3 }

export const depthOf = (path: StrataPath): number => DEPTH[levelOf(path)]

/** Normalised: only the ids the level uses, so `{ machine: 'a', workspace: undefined }` equals `{ machine: 'a' }`. */
export const pathKey = (path: StrataPath): string => {
  const parts = [path.machine, path.workspace, path.agent].slice(0, depthOf(path))
  return parts.map((p) => encodeURIComponent(p ?? '')).join('/') || '·'
}

export const samePath = (a: StrataPath, b: StrataPath): boolean => pathKey(a) === pathKey(b)

const truncate = (path: StrataPath, depth: number): StrataPath =>
  depth <= 0 ? {} : depth === 1 ? { machine: path.machine } : depth === 2 ? { machine: path.machine, workspace: path.workspace } : { ...path }

/** True when `a` lies on the way down to `b` (a strict ancestor). */
export const isAncestor = (a: StrataPath, b: StrataPath): boolean => {
  const da = depthOf(a)
  return da < depthOf(b) && samePath(a, truncate(b, da))
}

/** One level step, always described shallow → deep. */
export interface Step {
  parent: StrataPath
  child: StrataPath
  /** Where the child sits in the parent scene, best first. */
  anchor: AnchorId[]
  /** The same thing as it stands in the child scene, best first; none = the child's whole viewport. */
  content: AnchorId[]
}

export const stepInto = (parent: StrataPath, child: StrataPath): Step => {
  const depth = depthOf(parent)
  if (depth === 0) return { parent, child, anchor: [`portal:${child.machine}`, `machine:${child.machine}`], content: [`portal:${child.machine}`] }
  if (depth === 1) return { parent, child, anchor: [`workspace:${child.workspace}`], content: [`workspace:${child.workspace}`] }
  return { parent, child, anchor: [`agent:${child.agent}`], content: ['terminal'] }
}

export type FlightKind = 'in' | 'out' | 'dive' | 'rise' | 'hop'

export type FlightPlan =
  | { kind: 'none' }
  | {
      kind: FlightKind
      from: StrataPath
      to: StrataPath
      /** Every scene the flight shows, shallow → deep (a hop: from, to). */
      scenes: StrataPath[]
      /** Level steps shallow → deep; empty for a hop. */
      steps: Step[]
      /** +1 flies deeper, -1 flies out; a hop is +1. */
      dir: 1 | -1
    }

/** The scenes from ancestor `a` down to `b`, both included. */
const chain = (a: StrataPath, b: StrataPath): StrataPath[] => {
  const from = depthOf(a)
  return Array.from({ length: depthOf(b) - from + 1 }, (_, i) => truncate(b, from + i))
}

export const planFlight = (from: StrataPath, to: StrataPath): FlightPlan => {
  if (samePath(from, to)) return { kind: 'none' }
  const down = isAncestor(from, to)
  const up = isAncestor(to, from)
  if (!down && !up) return { kind: 'hop', from, to, scenes: [from, to], steps: [], dir: 1 }
  const scenes = down ? chain(from, to) : chain(to, from)
  const steps = scenes.slice(1).map((child, i) => stepInto(scenes[i], child))
  const kind: FlightKind = steps.length === 1 ? (down ? 'in' : 'out') : down ? 'dive' : 'rise'
  return { kind, from, to, scenes, steps, dir: down ? 1 : -1 }
}
