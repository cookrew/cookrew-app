import type { AgentRow } from '../agent-rows'

/**
 * WHICH AGENTS RIDE ON TOP OF EVERY PAGE, AND WHERE (AgentPets.tsx).
 *
 * A workspace can hold forty agents; forty pets is a swarm, not a troop. The
 * ones that ride along are the ones worth a glance: whoever needs you first,
 * then whoever is working, then whoever finished lately. When that leaves
 * fewer than a handful, the most recently active of the rest sit in as well,
 * asleep, so the troop never vanishes from a quiet workspace. Everyone else
 * is one tap away behind the "+N" coin.
 *
 * Pure, so the order and the geometry are tested without a DOM.
 */

/** Pets on screen before the "+N" coin. */
export const PET_MAX = 5
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

/** Where the troop sits: its right and bottom offsets from the viewport's corner. */
export interface PetSpot {
  readonly right: number
  readonly bottom: number
}

/** Above the dock, in from the right edge. */
export const PET_HOME: PetSpot = { right: 18, bottom: 78 }
/** The phone: on the right edge, over the agents column, clear of the strip and the dock. */
export const PET_HOME_PHONE: PetSpot = { right: 7, bottom: 96 }

/** Home for a screen this wide (the phone breakpoint is the app's 700px). */
export const petHome = (width: number): PetSpot => (width <= 700 ? PET_HOME_PHONE : PET_HOME)

/** Keep the troop on screen, whatever was saved or wherever it was dragged. */
export const clampSpot = (
  spot: PetSpot,
  troop: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): PetSpot => ({
  right: Math.round(Math.min(Math.max(spot.right, 4), Math.max(4, viewport.width - troop.width - 4))),
  bottom: Math.round(Math.min(Math.max(spot.bottom, 4), Math.max(4, viewport.height - troop.height - 4)))
})

/** A saved spot, or home when there is none or it is not one. */
export const readSpot = (raw: string | null, home: PetSpot = PET_HOME): PetSpot => {
  if (!raw) return home
  try {
    const value = JSON.parse(raw) as Partial<PetSpot>
    return typeof value.right === 'number' && typeof value.bottom === 'number' && Number.isFinite(value.right) && Number.isFinite(value.bottom)
      ? { right: value.right, bottom: value.bottom }
      : home
  } catch {
    return home
  }
}

/**
 * Where a pet's card opens: above the pet when it fits (the troop lives near
 * the bottom), below it when it does not, and never off the side of the screen.
 */
export const cardPlacement = (
  pet: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  gap = 10
): { left: number; top: number; above: boolean } => {
  const above = pet.top - gap - card.height >= 8 || pet.top > viewport.height - (pet.top + pet.height)
  const top = above ? Math.max(8, pet.top - gap - card.height) : Math.min(viewport.height - card.height - 8, pet.top + pet.height + gap)
  const centred = pet.left + pet.width / 2 - card.width / 2
  const left = Math.min(Math.max(8, centred), Math.max(8, viewport.width - card.width - 8))
  return { left: Math.round(left), top: Math.round(top), above }
}
