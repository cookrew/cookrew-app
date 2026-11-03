// Containers: every workspace is the same standard table (see chassis.ts),
// one to four 12-seat modules long, seating its agents in creation order. Its
// theme (materials and props) comes from the workspace's traits and name, its
// colour from the name; neither ever changes the geometry. All containers
// share one scale (CONTAINER_SCALE viewBox units per model unit), so a seat,
// and the avatar laid into it, is the same size in every workspace, on every
// screen: a phone shows the same table, smaller (the levels' loupe covers
// seats too small to tap).
//
// Anchors: slot:0…slot:n-1 (an avatar's whole viewBox goes here, see BALL),
// `tray` (loose notes and browsers), `label` (the name plaque). When the
// workspace has more agents than CAPACITY, the last slot holds the drawn "+K"
// token and `more` repeats its rect: lay no avatar there.
import type { FigureArt, Rect } from '../../../shared/strata'
import { finish, frameScale } from '../iso/frame'
import { hash, memo } from '../iso/memo'
import { deskPlan, drawDesk } from './chassis'
import { overflowToken, plaqueCorners, trayRect } from './common'
import { CAPACITY, modulesFor, overflowOf, SEAT_R, seatGrid, seatsFor, slotRect, tierFor } from './layout'
import { paletteOf, themesOf, type Theme } from './themes'

export { BALL, CAPACITY, MODULE, MODULE_SEATS, SEAT_R } from './layout'
export { paletteOf, THEMES, themesOf, type Theme } from './themes'

export const CONTAINER_SCALE = 3
const INK_K = 0.95
const WOBBLE = 0.7

export interface ContainerInput {
  name: string
  slots: number
  /** Words of WORKSPACE_TRAITS from the desktop, strongest first; unknown words are dropped. */
  traits?: readonly string[]
  /** Force one theme (the gallery shows every one); default: from the traits and the name. */
  theme?: Theme
}

/** theme = the strongest of `themes` (one or two) that dressed the table. */
export type ContainerArt = FigureArt & { theme: Theme; themes: Theme[]; modules: number; capacity: number }

export const containerArt = memo(({ name, slots, traits, theme }: ContainerInput): ContainerArt => {
  const themes = theme ? [theme] : themesOf(name, traits)
  const seats = seatsFor(slots)
  const overflow = overflowOf(slots)
  const modules = modulesFor(seats)
  const plan = deskPlan(modules, seatGrid(seats, tierFor(seats)))
  const seed = hash(name)
  const framed = frameScale({ scale: CONTAINER_SCALE, fit: plan.fit, shadowZ: 0, pad: 6, k: INK_K, wob: WOBBLE, wobStep: 20, seed: seed % 97 })
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
  return { ...finish(framed, drawDesk(p, plan, ctx, themes, seed) + token, anchors), theme: themes[0], themes, modules, capacity: CAPACITY }
})
