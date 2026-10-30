import type { AgentRow } from '../agent-rows'

/**
 * WHICH AGENTS RIDE ON TOP OF EVERY PAGE, AND WHERE (AgentPets.tsx).
 *
 * A workspace can hold forty agents; forty pets is a swarm, not a troop. The
 * ones that ride along are the ones worth a glance: whoever needs you first,
 * then whoever is working, then whoever finished lately. When that leaves
 * fewer than a handful, the most recently active of the rest sit in as well,
 * asleep, so the troop never vanishes from a quiet workspace. Everyone else
 * is one tap away behind the "+N" coin. The browsers and notes ride the same
 * way, in a troop of their own (pickItems).
 *
 * Pure, so the order and the geometry are tested without a DOM.
 */

/** Pets on screen before the "+N" coin. */
export const PET_MAX = 8
/** A troop is never smaller than this while the workspace has agents. */
export const PET_MIN = 3
/** A finished turn this recent is still news. */
export const PET_DONE_FRESH_MS = 30 * 60_000

export type PetMood = 'needs' | 'working' | 'done' | 'asleep'

export interface Pet {
  readonly row: AgentRow
  readonly mood: PetMood
}

export interface PetTroop {
  /** On screen, in order. */
  readonly pets: readonly Pet[]
  /** Behind the "+N" coin, in the same order. */
  readonly more: readonly Pet[]
}

const RANK: Record<PetMood, number> = { needs: 0, working: 1, done: 2, asleep: 3 }

/** What a pet is up to, or null when it does not ride along on its own. */
export const moodOf = (row: AgentRow, now: number): PetMood | null => {
  if (!row.active) return null
  if (row.phase === 'waiting') return 'needs'
  if (row.phase === 'working') return 'working'
  if (row.phase === 'done' && now - row.lastActivityAt < PET_DONE_FRESH_MS) return 'done'
  return null
}

export const pickPets = (
  rows: readonly AgentRow[],
  options: { readonly workspaceId: string | null; readonly now: number; readonly max?: number }
): PetTroop => {
  const max = options.max ?? PET_MAX
  // The loaded workspace only: its agents are the ones a prompt can reach and
  // the live tracker knows about.
  const here = rows.filter((row) => row.active && (options.workspaceId === null || row.workspaceId === options.workspaceId))
  const awake = here
    .flatMap((row): Pet[] => {
      const mood = moodOf(row, options.now)
      return mood ? [{ row, mood }] : []
    })
    .sort((a, b) => RANK[a.mood] - RANK[b.mood] || b.row.lastActivityAt - a.row.lastActivityAt)
  const awakeIds = new Set(awake.map((pet) => pet.row.id))
  const asleep = here
    .filter((row) => !awakeIds.has(row.id))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((row): Pet => ({ row, mood: 'asleep' }))
  const fill = Math.max(0, Math.min(PET_MIN, max) - awake.length)
  const all = [...awake, ...asleep]
  const shown = Math.min(max, awake.length + fill)
  return { pets: all.slice(0, shown), more: all.slice(shown) }
}

/** Pets on a phone before the "+N" coin: its columns are shorter. */
export const PET_MAX_PHONE = 6

/** How many pets a troop shows on a screen this wide (the app's 700px phone breakpoint). */
export const petMax = (width: number): number => (width <= 700 ? PET_MAX_PHONE : PET_MAX)

/** A browser or note, as far as choosing it needs. */
export interface ItemLite {
  readonly id: string
  readonly kind: 'browser' | 'note'
}

/**
 * Which browsers and notes ride along: the ones of the agent on stage first,
 * then those of the agents that are working or need you (in that order),
 * then the newest of the workspace. Items carry no clock of their own, so
 * "newest" is the order `items` arrives in (newest first).
 */
export const pickItems = <T extends ItemLite>(
  items: readonly T[],
  options: {
    /** item id → the agents wired to it. */
    readonly owners: ReadonlyMap<string, readonly string[]>
    /** Agents that matter now, most first: the one on stage, then the busy ones. */
    readonly focus: readonly string[]
    readonly max?: number
  }
): { readonly shown: readonly T[]; readonly more: readonly T[] } => {
  const max = options.max ?? PET_MAX
  const rank = new Map(options.focus.map((id, index) => [id, index]))
  const scoreOf = (item: T): number =>
    Math.min(Infinity, ...(options.owners.get(item.id) ?? []).map((owner) => rank.get(owner) ?? Infinity))
  const ordered = items
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item)
  return { shown: ordered.slice(0, max), more: ordered.slice(max) }
}

/**
 * A browser's face when the Mac has no picture of its page: the site's own
 * icon. The Mac photographs only pages that are already running (a thumbnail
 * must never be what launches a browser), so after a restart most cards have
 * no picture until they are opened. Null for anything that has no site to
 * ask (about:blank, a file, a page on this machine).
 */
export const faviconOf = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    const host = parsed.hostname
    if (!host.includes('.') || host === 'localhost' || host.startsWith('127.')) return null
    // https only: an http icon on the https page is blocked as mixed content.
    return `https://${parsed.host}/favicon.ico`
  } catch {
    return null
  }
}

/** What a click on a face does: the first opens its card, the second (card open) opens it in full. */
export const petClick = (openId: string | null, id: string): 'card' | 'full' => (openId === id ? 'full' : 'card')

/** Where a troop sits: `x` in from its own side of the screen, `bottom` up from the bottom. */
export interface PetSpot {
  readonly x: number
  readonly bottom: number
}

/** Home: down its side of the screen, standing on the dock, wherever the stage ends. */
export const petHome = (stageBottomGap: number, width: number): PetSpot => ({
  x: width <= 700 ? 2 : 4,
  bottom: Math.max(6, Math.round(stageBottomGap) + 8)
})

/** Keep the troop on screen, whatever was saved or wherever it was dragged. */
export const clampSpot = (
  spot: PetSpot,
  troop: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): PetSpot => ({
  x: Math.round(Math.min(Math.max(spot.x, 4), Math.max(4, viewport.width - troop.width - 4))),
  bottom: Math.round(Math.min(Math.max(spot.bottom, 4), Math.max(4, viewport.height - troop.height - 4)))
})

/** A saved spot, or null when there is none or it is not one. */
export const readSpot = (raw: string | null): PetSpot | null => {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PetSpot>
    return typeof value.x === 'number' && typeof value.bottom === 'number' && Number.isFinite(value.x) && Number.isFinite(value.bottom)
      ? { x: value.x, bottom: value.bottom }
      : null
  } catch {
    return null
  }
}

/**
 * Where a pet's card opens: beside its face, toward the middle of the screen
 * (the troops stand in columns down the sides), level with the face where it
 * fits, and never off the screen.
 */
export const cardPlacement = (
  pet: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  side: 'left' | 'right',
  gap = 10
): { left: number; top: number } => {
  const beside = side === 'right' ? pet.left - gap - card.width : pet.left + pet.width + gap
  const left = Math.min(Math.max(8, beside), Math.max(8, viewport.width - card.width - 8))
  const level = pet.top + pet.height / 2 - card.height / 2
  const top = Math.min(Math.max(8, level), Math.max(8, viewport.height - card.height - 8))
  return { left: Math.round(left), top: Math.round(top) }
}
