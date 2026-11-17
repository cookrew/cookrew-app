/**
 * AGENTS ARE WHAT THE KEYS MOVE BY (owner, 2026-11-17: the agent is the unit Tab and the arrows move by).
 * At the devices stop and the workspaces stop, Tab and → step on to the next
 * agent, Shift-Tab and ← back, across workspaces and machines; ↑ and ↓ go to
 * the row above or below. The agent stood on pops its card with its reply box.
 *
 * Pure: the order, the step and which keys are ours. use-agent-keys.ts reads
 * the page and the DOM; this module only decides.
 */

/** This machine, among the account's (the others go by their machine id). */
export const LOCAL_MACHINE = 'local'

/** One agent the keys can stand on. */
export interface PickSpot {
  readonly machine: string
  readonly workspace: string
  readonly agent: string
}

/** A workspace's agents, in the order its faces are drawn. */
export interface PickGroup {
  readonly machine: string
  readonly workspace: string
  readonly agents: readonly string[]
}

/** The same agent: one machine's ids say nothing of another's. */
export const samePick = (a: PickSpot | null, b: PickSpot | null): boolean =>
  a !== null && b !== null && a.machine === b.machine && a.agent === b.agent

/** A spot as one string: a key for a face's element (data-pick) and a React key. */
export const pickKey = (spot: Pick<PickSpot, 'machine' | 'agent'>): string => `${spot.machine}|${spot.agent}`

/** Every agent in drawn order: machine by machine, workspace by workspace, face by face. */
export function ringOf(groups: readonly PickGroup[]): PickSpot[] {
  return groups.flatMap((g) => g.agents.map((agent) => ({ machine: g.machine, workspace: g.workspace, agent })))
}

/** One step on (1) or back (-1) from `at`, round from either end; from nowhere, the first or the last. */
export function stepRing(ring: readonly PickSpot[], at: PickSpot | null, by: 1 | -1): PickSpot | null {
  if (ring.length === 0) return null
  const here = at ? ring.findIndex((s) => samePick(s, at)) : -1
  if (here < 0) return by > 0 ? ring[0] : ring[ring.length - 1]
  return ring[(here + by + ring.length) % ring.length]
}

/** Where an agent stands in its workspace's row; 0 when it is not found. */
export function groupIndexOf(groups: readonly PickGroup[], spot: PickSpot): number {
  const g = groups.find((one) => one.machine === spot.machine && one.workspace === spot.workspace)
  return Math.max(0, g?.agents.indexOf(spot.agent) ?? 0)
}

/** A workspace's agent at `index` in its row, the last when the row is shorter; null for an empty one. */
export function spotAt(groups: readonly PickGroup[], machine: string, workspace: string, index: number): PickSpot | null {
  const g = groups.find((one) => one.machine === machine && one.workspace === workspace)
  if (!g || g.agents.length === 0) return null
  return { machine, workspace, agent: g.agents[Math.min(Math.max(0, index), g.agents.length - 1)] }
}

export type KeyMove = 'next' | 'prev' | 'up' | 'down'

/** What a key asks: on, back, a row up or down; null for any other key, a chord or an IME mid-word. */
export function keyMove(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }): KeyMove | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (e.key === 'Tab') return e.shiftKey ? 'prev' : 'next'
  if (e.key === 'ArrowRight') return 'next'
  if (e.key === 'ArrowLeft') return 'prev'
  if (e.key === 'ArrowDown') return 'down'
  if (e.key === 'ArrowUp') return 'up'
  return null
}

/**
 * Whether the keys take this one. `page`: nothing that types has the focus.
 * `box`: the open card's reply box, where Tab still steps on (its words stay
 * the agent's draft) and an arrow does only while the box is empty, when it has
 * no caret to move. `elsewhere`: another field, a terminal, another dialog.
 */
export function ownsKey(where: 'page' | 'box' | 'elsewhere', move: KeyMove, box: { empty: boolean; tab: boolean }): boolean {
  if (where === 'page') return true
  if (where === 'elsewhere') return false
  return (box.tab && (move === 'next' || move === 'prev')) || box.empty
}

/** A thing on screen the keys can go to: its centre. */
export interface Spot {
  readonly key: string
  readonly x: number
  readonly y: number
}

/** How far apart two centres may stand and still be one row, in px. */
const ROW_SLACK = 8

/** The nearest row up or down from `from`, and in it the spot most nearly in line; null past the last row. */
export function nearestToward(from: { x: number; y: number }, spots: readonly Spot[], dir: 'up' | 'down'): string | null {
  const ahead = spots.filter((s) => (dir === 'down' ? s.y > from.y + ROW_SLACK : s.y < from.y - ROW_SLACK))
  if (ahead.length === 0) return null
  const rowY = ahead.reduce((best, s) => (Math.abs(s.y - from.y) < Math.abs(best - from.y) ? s.y : best), ahead[0].y)
  const row = ahead.filter((s) => Math.abs(s.y - rowY) <= ROW_SLACK)
  return row.reduce((best, s) => (Math.abs(s.x - from.x) < Math.abs(best.x - from.x) ? s : best), row[0]).key
}
