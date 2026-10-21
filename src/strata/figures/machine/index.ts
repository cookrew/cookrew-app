// Machines, drawn from their real hardware, in one 240 × 180 viewBox each so a
// fleet lines up. Anchors: `portal` (the screen or window the miniature of its
// workspaces sits on) and `body` (the object without its shadow, for hit areas).
import type { FigureArt, MachineKind, Rect } from '../../../shared/strata'
import { finish, frameFit } from '../iso/frame'
import type { V3 } from '../iso/geom'
import { hash, memo } from '../iso/memo'
import { sandbox, vm } from './boxed'
import { desktop, laptop, unknown } from './desk'
import { lookOf, stateOf, type MachineInput, type MachineModel } from './look'
import { cloud, cluster, server } from './rack'

export type { MachineInput, MachineState } from './look'
export { stateOf } from './look'

export const MACHINE_VIEW = { w: 240, h: 180 } as const

const MODELS: Record<MachineKind, MachineModel> = {
  laptop,
  desktop,
  server,
  cloud,
  vm,
  cluster,
  sandbox,
  unknown
}

const WOBBLE = 0.6

/** Frame on the 8 corners of the fit points' box, so no corner of a board or plate is cut. */
const boxOf = (pts: readonly V3[]): V3[] => {
  const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])))
  const hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])))
  return [lo[0], hi[0]].flatMap((x) => [lo[1], hi[1]].flatMap((y) => [lo[2], hi[2]].map((z) => [x, y, z] as V3)))
}
const INK_K = 0.85

export const machineArt = memo((input: MachineInput): FigureArt => {
  const model = MODELS[input.kind] ?? MODELS.unknown
  const look = lookOf(stateOf(input))
  const framed = frameFit({
    vw: MACHINE_VIEW.w,
    vh: MACHINE_VIEW.h,
    fit: boxOf(model.fit),
    shadowZ: model.shadowZ,
    pad: 8,
    k: INK_K,
    wob: look.ghost ? 0 : WOBBLE,
    seed: hash(input.kind) % 97,
    ghost: look.ghost
  })
  const { svg, portal, body } = model.draw(framed.pen, look)
  const drawn = look.ghost ? `<g stroke-dasharray="4 3" opacity=".75">${svg}</g>` : svg
  return finish(framed, drawn, { portal: framed.pen.rectOf(portal), body: framed.pen.rectOf(body) })
})

/**
 * Every portal lies on a front plane, so its face is the bounding rect skewed:
 * a box `width × height` placed at the rect's bottom-left corner with
 * `transform-origin: 0 100%` and this transform covers the screen exactly.
 */
export const portalSkew = (portal: Rect) => ({
  width: portal.w,
  height: portal.h - portal.w * Math.tan(Math.PI / 6),
  transform: 'skewY(-30deg)',
  transformOrigin: '0 100%'
})
