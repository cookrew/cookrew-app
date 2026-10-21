// Parts every machine shares: the portal screen on a front plane, the status
// LED, the "outdated" sticker and the padlock of an unpaired machine.
import { ellUV, on, PX, rectUV, rrUV, type UV, type V3 } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { AMBER, INK, tone, type Mat } from '../iso/tone'
import type { Look } from './look'

const LOCK = '#e9e2cf'

/**
 * The portal: a screen on the front plane x, from (y0, z0) to (y1, z1). Its
 * four corners are the anchor's face; the miniature of the workspaces sits on it.
 */
export const portalScreen = (p: Pen, look: Look, x: number, y0: number, z0: number, y1: number, z1: number) => {
  const corners = on(PX(x), rectUV(y0, z0, y1, z1))
  const w = y1 - y0
  const h = z1 - z0
  const streak = on(PX(x + 0.02), [
    [y1 - w * 0.12, z1],
    [y1 - w * 0.3, z1],
    [y1 - w * 0.62, z0],
    [y1 - w * 0.5, z0]
  ])
  let svg = p.fill(corners, look.screen) + p.fill(streak, '#ffffff', 'opacity=".07"')
  if (look.lock) {
    const cy = (y0 + y1) / 2
    const cz = (z0 + z1) / 2
    const bw = Math.min(w, h) * 0.22
    const body = on(PX(x + 0.05), rrUV(cy - bw, cz - bw * 0.9, cy + bw, cz + bw * 0.35, bw * 0.15, 2))
    const shackle = on(PX(x + 0.05), [
      [cy - bw * 0.62, cz + bw * 0.35],
      [cy - bw * 0.62, cz + bw * 0.9],
      [cy - bw * 0.4, cz + bw * 1.25],
      [cy + bw * 0.4, cz + bw * 1.25],
      [cy + bw * 0.62, cz + bw * 0.9],
      [cy + bw * 0.62, cz + bw * 0.35]
    ])
    svg += p.line(shackle, 1.3, { color: LOCK }) + p.fill(body, LOCK)
    svg += p.fill(on(PX(x + 0.08), ellUV(cy, cz - bw * 0.2, bw * 0.18, bw * 0.18, 8)), INK)
  }
  svg += p.ink(corners, 1.3, { keep: true })
  return { svg, corners }
}

/** A status LED on the front plane x. */
export const led = (p: Pen, look: Look, x: number, y: number, z: number, r = 0.8): string => {
  const dot = on(PX(x), ellUV(y, z, r, r, 8))
  return p.fill(dot, look.led) + p.ink(dot, 0.6)
}

/** The amber "outdated" sticker: the desktop answers, without the levels API. */
export const sticker = (p: Pen, look: Look, x: number, y: number, z: number, size = 3.4): string => {
  if (!look.sticker) return ''
  const pts: V3[] = on(PX(x), rrUV(y - size, z - size * 0.7, y + size, z + size * 0.7, size * 0.3, 2))
  return p.shape(pts, AMBER, 0.9) + p.tx(x + 0.05, y, z - size * 0.38, '!', size * 1.25, INK, 900)
}

/** A rounded body: a (y, z) profile swept along x, front cap, silhouette. */
export const body = (p: Pen, prof: readonly UV[], x0: number, x1: number, m: Mat, w = 2.8) => {
  const pts = [...on(PX(x0), prof), ...on(PX(x1), prof)]
  const svg = p.extrude(prof, x0, x1, m) + p.fill(on(PX(x1), prof), tone([1, 0, 0], m))
  return { pts, svg, ink: p.ink(on(PX(x1), prof), 1.8) + p.hullInk(pts, w) }
}

/** Side vents: a few slots on the side plane y. */
export const vents = (p: Pen, y: number, x0: number, x1: number, zs: number[]) =>
  zs.map((z) => p.line([[x0, y, z], [x1, y, z]], 1, { extra: 'opacity=".55"' })).join('')
