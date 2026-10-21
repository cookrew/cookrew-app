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
import { CAPACITY, overflowOf, SEAT_R, seatGrid, seatsFor, slotRect, tierFor } from './layout'
import { archetypeOf, paletteOf, type Archetype } from './name'
import { bookshelf, drawers, house, lab, lockers, vault } from './shelves'
import { bleachers, crate, pipes, sandbox, workbench } from './surfaces'

export { ARCHETYPES, archetypeOf, paletteOf, type Archetype } from './name'
export { BALL, CAPACITY, SEAT_R } from './layout'

export const CONTAINER_SCALE = 3
const INK_K = 0.95
const WOBBLE = 0.7

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

export interface ContainerInput {
  name: string
  slots: number
  /** Force an archetype (the gallery shows every one); default: from the name. */
  archetype?: Archetype
}

export type ContainerArt = FigureArt & { archetype: string; capacity: number }

export const containerArt = memo(({ name, slots, archetype }: ContainerInput): ContainerArt => {
  const kind = archetype ?? archetypeOf(name)
  const def = DEFS[kind]
  const seats = seatsFor(slots)
  const overflow = overflowOf(slots)
  const plan = def.plan(tierFor(Math.max(1, seats)), seatGrid(seats, tierFor(Math.max(1, seats))))
  const framed = frameScale({ scale: CONTAINER_SCALE, fit: plan.fit, shadowZ: 0, pad: 6, k: INK_K, wob: WOBBLE, wobStep: 20, seed: hash(name) % 97 })
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
