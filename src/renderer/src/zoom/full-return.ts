/**
 * BACK FROM A FULL VIEW GOES WHERE YOU CAME FROM (owner, 2026-11-17).
 *
 * A full view is opened from many places: its own card or thumbnail, the
 * bar's groups at any stop, a pet, the command box, a toast, the board, and
 * the other kind's full view (an agent's from an artifact's and back). One
 * stop out (zoom-path.ts · stepOut) only knew the first of these, so back from
 * a full view opened anywhere else landed on its card or thumbnails instead
 * of the page the person was on.
 *
 * The trail is a stack, newest last: each entry is the place a full view was
 * opened from and the full view it opened, so agent → artifact → agent unwinds
 * the way it was walked. An entry is only taken while the view stands on the
 * very full view it opened; anything else means the trail is stale, and back is
 * one stop out as it always was. Pure: the zoom store (zoom-store.ts) holds it.
 */
import { RANGE, STOPS, stepOut, type ZoomDir } from './zoom-path'

/** Where the view stands, with who holds the focus on each side. */
export interface ZoomSpot {
  readonly dir: ZoomDir
  readonly v: number
  readonly agent: string | null
  readonly item: string | null
}

export type FullKind = 'agent' | 'item'

/** A full view: whose. The id is null while the focus is the first card by default. */
export interface FullRef {
  readonly kind: FullKind
  readonly id: string | null
}

export interface ZoomReturn {
  readonly from: ZoomSpot
  readonly to: FullRef
}

/** Enough for any walk a person takes; past it the oldest step is forgotten. */
export const TRAIL_MAX = 24

const EPS = 0.001

/** The full view a spot stands on, or null. */
export function fullOf(spot: ZoomSpot): FullRef | null {
  if (spot.v < RANGE[spot.dir][1] - EPS) return null
  return spot.dir === 'agents' ? { kind: 'agent', id: spot.agent } : { kind: 'item', id: spot.item }
}

export const sameFull = (a: FullRef | null, b: FullRef | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id

/**
 * The stop a spot rests nearest, short of the full view unless it is one: a
 * pinch can leave v anywhere, and back must land on a place, not in between.
 */
export function restingSpot(spot: ZoomSpot): ZoomSpot {
  if (fullOf(spot) !== null) return spot
  const stops = STOPS[spot.dir].filter((s) => s < RANGE[spot.dir][1])
  const v = stops.reduce((a, b) => (Math.abs(b - spot.v) < Math.abs(a - spot.v) ? b : a))
  return v === spot.v ? spot : { ...spot, v }
}

/** The trail after the view sets off from `from` toward the full view `to`. */
export function pushReturn(trail: readonly ZoomReturn[], from: ZoomSpot, to: FullRef): readonly ZoomReturn[] {
  if (sameFull(fullOf(from), to)) return trail
  return [...trail, { from: restingSpot(from), to }].slice(-TRAIL_MAX)
}

export interface BackStep {
  /** Where the view goes. */
  readonly to: ZoomSpot
  /** The trail once it has gone there. */
  readonly trail: readonly ZoomReturn[]
  /** True when it is the page the full view was opened from; false for one stop out. */
  readonly previous: boolean
}

/** Where back goes from `here`, or null at the outermost stop, where there is nowhere further. */
export function backFrom(trail: readonly ZoomReturn[], here: ZoomSpot): BackStep | null {
  const full = fullOf(here)
  const top = trail[trail.length - 1]
  if (full !== null && top !== undefined && sameFull(top.to, full)) {
    // Only a full view has a way back of its own; on a stop or a card the walk is over.
    return { to: top.from, trail: fullOf(top.from) !== null ? trail.slice(0, -1) : [], previous: true }
  }
  const v = stepOut(here.dir, here.v)
  if (v === here.v) return null
  return { to: { ...here, v }, trail: [], previous: false }
}

/** Is this spot's focus a card that still exists? A spot with no focus of its own always is. */
export type KnownCard = (kind: FullKind, id: string) => boolean

const isCard = (spot: ZoomSpot): boolean => spot.dir === 'agents' && spot.v >= 1.5 - EPS && spot.v < RANGE.agents[1] - EPS

const spotKnown = (spot: ZoomSpot, known: KnownCard): boolean => {
  if (spot.dir === 'agents' && spot.v >= 1.5 - EPS) return spot.agent === null || known('agent', spot.agent)
  if (spot.dir === 'items' && spot.v >= 0.5 - EPS) return spot.item === null || known('item', spot.item)
  return true
}

/**
 * The trail with the cards that are gone (closed, or of a workspace no longer
 * loaded) taken out of it. A gone agent's card falls back to its crew; a gone
 * full view drops out of the walk, so back from the one opened from it goes to
 * where IT was opened from.
 */
export function pruneTrail(trail: readonly ZoomReturn[], known: KnownCard): readonly ZoomReturn[] {
  const out: ZoomReturn[] = []
  for (const entry of trail) {
    if (spotKnown(entry.from, known)) {
      out.push(entry)
      continue
    }
    if (isCard(entry.from)) {
      out.push({ ...entry, from: { ...entry.from, v: 1 } })
      continue
    }
    const before = out[out.length - 1]
    if (before !== undefined && sameFull(before.to, fullOf(entry.from))) out[out.length - 1] = { ...before, to: entry.to }
  }
  return out.length === trail.length && out.every((entry, i) => entry === trail[i]) ? trail : out
}

/** What a place is called, in the bar's own words (zoom-path.ts · BAR_NAMES). */
export type PlaceKind = 'devices' | 'workspaces' | 'agents' | 'card' | 'artifacts' | 'agent-full' | 'item-full'

export function placeKind(spot: ZoomSpot): PlaceKind {
  const full = fullOf(spot)
  if (full !== null) return full.kind === 'agent' ? 'agent-full' : 'item-full'
  const { dir, v } = restingSpot(spot)
  if (v <= -2) return 'devices'
  if (v <= -1) return 'workspaces'
  if (dir === 'items') return 'artifacts'
  return v < 2 ? 'agents' : 'card'
}

/**
 * The words for where back goes: the bar's name for a stop, the agent's name or
 * the artifact's title for a full view. A card is inside the agents, as the bar
 * lights it (zoom-path.ts · barSide).
 */
export function placeWords(spot: ZoomSpot, nameOf: (kind: FullKind, id: string) => string | null): string {
  const kind = placeKind(spot)
  if (kind === 'card') return 'agents'
  if (kind === 'agent-full') return (spot.agent !== null ? nameOf('agent', spot.agent) : null) ?? 'agent'
  if (kind === 'item-full') return (spot.item !== null ? nameOf('item', spot.item) : null) ?? 'artifact'
  return kind
}
