// THE SELECTION MODEL: one highlight per level. A highlight is a StrataPath —
// where "in" goes from here — so a machine or workspace means "go in" and an
// agent (at any level) means "dive". Pure: the levels hand in their items'
// rects from the pure layouts, never the DOM.
import type { Rect, StrataMachine, StrataPath } from '../../shared/strata'
import { center } from './geometry'

export interface LevelItem {
  target: StrataPath
  rect: Rect
}

export type Direction = 'left' | 'right' | 'up' | 'down'

export const samePath = (a: StrataPath | null | undefined, b: StrataPath | null | undefined): boolean =>
  !!a && !!b && a.machine === b.machine && a.workspace === b.workspace && a.agent === b.agent

/** Stable string key of a path (for maps, React keys and DOM ids). */
export const pathKey = (p: StrataPath): string => [p.machine ?? '', p.workspace ?? '', p.agent ?? ''].join('/')

/** Left/right walk the items in order (row-major = creation order); up/down go to the nearest item that way. */
export const nextItem = (items: readonly LevelItem[], current: StrataPath | null, dir: Direction): StrataPath | null => {
  if (items.length === 0) return null
  const index = items.findIndex((it) => samePath(it.target, current))
  if (index < 0) return items[0].target
  if (dir === 'left') return items[Math.max(0, index - 1)].target
  if (dir === 'right') return items[Math.min(items.length - 1, index + 1)].target
  const from = center(items[index].rect)
  const sign = dir === 'down' ? 1 : -1
  let best: { target: StrataPath; cost: number } | null = null
  for (const it of items) {
    const c = center(it.rect)
    const along = (c.y - from.y) * sign
    if (along <= 1) continue
    const cost = along + 2 * Math.abs(c.x - from.x)
    if (!best || cost < best.cost) best = { target: it.target, cost }
  }
  return best?.target ?? items[index].target
}

/** The machine or workspace item an agent highlight belongs to at this level. */
export const itemOf = (items: readonly LevelItem[], highlight: StrataPath | null): StrataPath | null => {
  if (!highlight) return null
  return (
    items.find((it) => samePath(it.target, highlight))?.target ??
    items.find((it) => it.target.machine === highlight.machine && (!it.target.workspace || it.target.workspace === highlight.workspace))?.target ??
    null
  )
}

/** Shift+arrows: walk the agents inside a machine or workspace, in creation order. */
export const nextAgentWithin = (agents: readonly StrataPath[], current: StrataPath | null, dir: Direction): StrataPath | null => {
  if (agents.length === 0) return null
  const index = agents.findIndex((a) => samePath(a, current))
  if (index < 0) return dir === 'left' || dir === 'up' ? agents[agents.length - 1] : agents[0]
  const step = dir === 'left' || dir === 'up' ? -1 : 1
  return agents[Math.max(0, Math.min(agents.length - 1, index + step))]
}

/**
 * Where the highlight starts on entering a level: the item you came out of,
 * else the first item holding a waiting agent, else the first item.
 */
export const defaultHighlight = (items: readonly LevelItem[], cameFrom: StrataPath | null, waiting: (target: StrataPath) => boolean): StrataPath | null => {
  if (items.length === 0) return null
  const back = cameFrom && items.find((it) => samePath(it.target, cameFrom))
  if (back) return back.target
  return (items.find((it) => waiting(it.target)) ?? items[0]).target
}

/** The child of `parent` that `previous` sat in: where the highlight lands after going out. */
export const childToward = (parent: StrataPath, previous: StrataPath): StrataPath | null => {
  if (!parent.machine) return previous.machine ? { machine: previous.machine } : null
  if (!parent.workspace) return previous.machine === parent.machine && previous.workspace ? { machine: parent.machine, workspace: previous.workspace } : null
  if (!parent.agent) return previous.workspace === parent.workspace && previous.agent ? { ...parent, agent: previous.agent } : null
  return null
}

/** Every agent of a machine (or one of its workspaces), as dive paths, in creation order. */
export const agentPaths = (machine: StrataMachine, workspaceId?: string): StrataPath[] =>
  (machine.levels?.workspaces ?? [])
    .filter((w) => !workspaceId || w.id === workspaceId)
    .flatMap((w) => w.agents.map((a) => ({ machine: machine.id, workspace: w.id, agent: a.id })))
