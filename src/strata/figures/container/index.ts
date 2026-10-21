// Containers: a workspace as a piece of furniture whose look comes from its
// name, seating its agents evenly in creation order. All containers share one
// scale (CONTAINER_SCALE viewBox units per model unit), so a seat — and the
// avatar laid into it — is the same size in every workspace.
//
// Anchors: slot:0…slot:n-1 (an avatar's whole viewBox goes here, see BALL),
// `tray` (loose notes and browsers), `label` (the name plaque). When the
// workspace has more agents than CAPACITY, the last slot holds the drawn "+K"
// token and `more` repeats its rect: lay no avatar there.
import type { FigureArt, Rect } from '../../../shared/strata'
import { finish, frameScale } from '../iso/frame'
import { hash, memo } from '../iso/memo'
import { overflowToken, plaqueCorners, trayRect, type ArchetypeDef, type Plan } from './common'
import { CAPACITY, columnsHint, hintedTier, overflowOf, SEAT_R, seatGrid, seatsFor, slotRect, tierFor } from './layout'
import { archetypeOf, paletteOf, type Archetype } from './name'
import { bookshelf, drawers, house, lab, lockers, vault } from './shelves'
import { bleachers, crate, pipes, sandbox, workbench } from './surfaces'

export { ARCHETYPES, archetypeOf, paletteOf, type Archetype } from './name'
export { BALL, CAPACITY, SEAT_R } from './layout'

export const CONTAINER_SCALE = 3
const INK_K = 0.95
const WOBBLE = 0.7
/**
 * A hinted (phone) layout stacks tall and narrow, where a full cast shadow
 * would spend a third of the width the seats need: its shadow stops at this
 * height. The default tiers keep their full shadow.
 */
const HINTED_SHADOW_CAP = 24

const DEFS: Record<Archetype, ArchetypeDef<Plan>> = {
  workbench,
  bookshelf,
  house,
  crate,
  vault,
  lockers,
  pipes,
  sandbox,
  drawers,
  lab,
  bleachers
} as Record<Archetype, ArchetypeDef<Plan>>

/**
 * How many rows each archetype can stack before it stops reading as itself:
 * stepped ones (bleachers, the pipe rack) climb a step per row; surfaces get
 * deep; shelves just grow taller.
 */
export const MAX_ROWS: Record<Archetype, number> = {
  workbench: 8,
  bookshelf: 12,
  house: 12,
  crate: 8,
  vault: 12,
  lockers: 12,
  pipes: 6,
  sandbox: 8,
  drawers: 12,
  lab: 12,
  bleachers: 6
}

export interface ContainerInput {
  name: string
  slots: number
  /** Seats per row the level asks for (a phone asks for fewer, larger seats). Absent = the kit's own tiers. */
  columns?: number
  /** Force an archetype (the gallery shows every one); default: from the name. */
  archetype?: Archetype
}

export type ContainerArt = FigureArt & { archetype: string; capacity: number }

export const containerArt = memo(({ name, slots, archetype, columns }: ContainerInput): ContainerArt => {
  const kind = archetype ?? archetypeOf(name)
  const def = DEFS[kind]
  const seats = seatsFor(slots)
  const overflow = overflowOf(slots)
  const hint = columnsHint(columns)
  const tier = hint === null ? tierFor(Math.max(1, seats)) : hintedTier(seats, hint, MAX_ROWS[kind])
  const plan = def.plan(tier, seatGrid(seats, tier))
  const framed = frameScale({ scale: CONTAINER_SCALE, fit: plan.fit, shadowZ: 0, pad: 6, k: INK_K, wob: WOBBLE, wobStep: 20, seed: hash(name) % 97, shadowCap: hint === null ? undefined : HINTED_SHADOW_CAP })
  const p = framed.pen
  const ctx = { name, m: paletteOf(name), overflow }
  const R = SEAT_R * 1.2247 * CONTAINER_SCALE
  const slotsAt: Array<[string, Rect]> = plan.seats.map((at, i) => {
    const [cx, cy] = p.P(at)
    return [`slot:${i}`, slotRect(cx, cy, R)]
  })
  const last = plan.seats[plan.seats.length - 1]
  const token = overflow > 0 && last ? overflowToken(p, last, overflow) : ''
  const anchors: Record<string, Rect> = {
    ...Object.fromEntries(slotsAt),
    tray: trayRect(p, plan.tray),
    label: p.rectOf(plaqueCorners(plan.plaque)),
    ...(overflow > 0 && slotsAt.length ? { more: slotsAt[slotsAt.length - 1][1] } : {})
  }
  return { ...finish(framed, def.draw(p, plan, ctx) + token, anchors), archetype: kind, capacity: CAPACITY }
})
