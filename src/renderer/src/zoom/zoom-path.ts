/**
 * THE ZOOM PATH (owner, 2026-10-31; demo docs/brand-ink-2026-10-31/group-motion-pivot.html).
 * One value v, in one of two directions, says where the view is; everything
 * drawn follows from it, so motion is reversible mid-way and never a timer.
 *
 *   agents:   devices −2 · device −1 · (group 0, passed through) · crew 1 · card 2 · full 3
 *   browsers: devices −2 · device −1 · thumbs 0 · full 1
 *
 * The device is where the two meet: a workspace opens by its agents (the
 * crew) or by its browsers (their thumbnails). From the deep end of either,
 * a click on the other kind jumps straight across to its full view.
 */

export type ZoomDir = 'agents' | 'items'

export const RANGE: Record<ZoomDir, readonly [number, number]> = { agents: [-2, 3], items: [-2, 1] }
export const STOPS: Record<ZoomDir, readonly number[]> = { agents: [-2, -1, 1, 2, 3], items: [-2, -1, 0, 1] }
/**
 * THE BAR (owner, 2026-11-01): the stops it names. The card is a small thing
 * inside the crew, and a full view has its own way back, so neither gets a
 * stop of its own; the names are what each stop shows, not what it zooms.
 */
export const BAR_STOPS: Record<ZoomDir, readonly number[]> = { agents: [-2, -1, 1], items: [-2, -1, 0] }
export const BAR_NAMES: Record<ZoomDir, readonly string[]> = {
  agents: ['devices', 'workspaces', 'agents'],
  items: ['devices', 'workspaces', 'artifacts']
}
/** The stretch that is only a passage: the zoom never rests inside it. */
export const PASSAGE: Record<ZoomDir, readonly [number, number]> = { agents: [-1, 1], items: [-1, 0] }

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
export const ease = (t: number): number => t * t * (3 - 2 * t)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const ramp = (v: number, a: number, b: number): number => clamp01((v - a) / (b - a))

/** The zoom z, pivot P (0 agents, 1 items) and item zoom I a path value draws. */
export interface Derived {
  z: number
  P: number
  I: number
}

export function derive(dir: ZoomDir, v: number): Derived {
  if (dir === 'agents' || v <= -1) return { z: v, P: 0, I: 0 }
  // Device → thumbs: dive into the workspace first, then unfold its items.
  if (v <= 0) return { z: lerp(-1, 0, ease(ramp(v, -1, -0.35))), P: ramp(v, -0.55, 0), I: 0 }
  return { z: 0, P: 1, I: v }
}

export const clampTo = (dir: ZoomDir, v: number): number => Math.max(RANGE[dir][0], Math.min(RANGE[dir][1], v))

/** The stop nearest v on this side. */
export function nearestStop(dir: ZoomDir, v: number): number {
  return STOPS[dir].reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
}

/** The bar stop lit at v: the nearest, and the deepest one for anything past it (a card, a full view). */
export function barStop(dir: ZoomDir, v: number): number {
  const stops = BAR_STOPS[dir]
  const deepest = stops[stops.length - 1]
  if (v >= deepest) return deepest
  return stops.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
}

/**
 * THE SWITCH (owner, 2026-11-01): no slider; the bar's last stop is two,
 * agents | artifacts, the two ways into a workspace. In it, the other one is
 * the switch across; above it, each opens the workspace by its side.
 * THE GROUPS (owner, 2026-11-04; zoom/BarGroups.tsx): each side is a group of
 * what needs you, ARTIFACTS first, AGENTS next to the prompt's face.
 */
export const BAR_SIDES: readonly { dir: ZoomDir; v: number; name: string }[] = [
  { dir: 'items', v: 0, name: 'artifacts' },
  { dir: 'agents', v: 1, name: 'agents' }
]

/** The side lit at v: the one the view is on once it is in the workspace (a card, a full view too); none above it. */
export function barSide(dir: ZoomDir, v: number): ZoomDir | null {
  const stops = BAR_STOPS[dir]
  return barStop(dir, v) === stops[stops.length - 1] ? dir : null
}

/**
 * One stop out from v (owner, 2026-10-31: zoom in and out by CLICK): the next
 * stop below where the view is, never the passage inside it. At the outermost
 * stop there is nowhere further, so v stays.
 */
export function stepOut(dir: ZoomDir, v: number): number {
  const below = STOPS[dir].filter((s) => s < v - 0.001)
  return below.length ? Math.max(...below) : v
}

/** Where a zoom let go at v settles: inside the passage, on its nearer end; elsewhere, where it is. */
export function settle(dir: ZoomDir, v: number): number {
  const [a, b] = PASSAGE[dir]
  if (v > a + 0.001 && v < b - 0.001) return v - a < b - v ? a : b
  return v
}

/** What a click on an agent does, from where the view is (and which agent holds the focus). */
export type AgentClick = { kind: 'set'; v: number } | { kind: 'switch'; v: number } | { kind: 'refocus-full' } | { kind: 'jump-card' }
export function agentClick(dir: ZoomDir, v: number, isFocus: boolean): AgentClick {
  // From the artifacts, an agent opens its card first, not its full view (owner, 2026-11-03).
  if (dir === 'items' && v > -0.05) return { kind: 'jump-card' }
  if (v < -1.05) return { kind: 'set', v: -1 }
  if (v < 0.5) return { kind: 'set', v: 1 }
  if (isFocus) return { kind: 'set', v: v < 1.5 ? 2 : 3 }
  if (v > 2.02) return { kind: 'refocus-full' }
  return { kind: 'switch', v: 2 }
}

/** What a click on a browser or note does: open the thumbs from the device, its full view from deeper in. */
export type ItemClick = { kind: 'set'; dir: ZoomDir; v: number } | { kind: 'jump-full' } | { kind: 'item-full' } | { kind: 'none' }
export function itemClick(dir: ZoomDir, v: number): ItemClick {
  if (v < -1.05) return { kind: 'set', dir, v: -1 }
  if (dir === 'agents' && v > 0.6) return { kind: 'jump-full' }
  if (dir === 'items' && v > -0.05) return { kind: 'item-full' }
  if (v < 0.6) return { kind: 'set', dir: 'items', v: 0 }
  return { kind: 'none' }
}
