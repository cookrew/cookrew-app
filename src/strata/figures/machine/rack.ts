// Machines that stand on the floor: the server (a tower; the portal is its
// front window), the cloud host (a server on a cloud plinth) and the cluster
// (linked pods on a shared plate; the front pod's window is the portal).
import { ellUV, on, PX, PY, PZ, rrUV, type V3 } from '../iso/geom'
import { byDepth, type Pen } from '../iso/pen'
import { DARK, METAL, mix, PALS, tone, toneI, type Mat } from '../iso/tone'
import type { Look, MachineModel } from './look'
import { body, led, portalScreen, sticker, vents } from './parts'

const CLOUD: Mat = { l: '#f7f9fc', m: '#dfe6ef', d: '#b4c0cf' }

// ── server: a tower, turned so its glass side panel (the portal) faces front ─
const TOWER = { d: 20, w: 40, h: 44, foot: 1.2 }

export const server: MachineModel = {
  shadowZ: 0,
  fit: [[0, 0, 0], [TOWER.d, TOWER.w, TOWER.h]],
  draw(p, look) {
    const m = look.mat(PALS.cobalt)
    const prof = rrUV(0, TOWER.foot, TOWER.w, TOWER.h, 2.4, 3)
    const b = body(p, prof, 0, TOWER.d, m)
    const F = TOWER.d + 0.02
    const L = TOWER.w + 0.02
    const bezel = tone([0, 1, 0], m)
    let svg = p.castShadow(b.pts, 0)
    for (const y of [3, TOWER.w - 6]) svg += p.box(1.5, y, 0, TOWER.d - 1.5, y + 3, TOWER.foot, look.mat(DARK), toneI, 0.8)
    svg += b.svg
    // the side window, the portal
    const screen = portalScreen(p, look, F, 4, 7, TOWER.w - 4, TOWER.h - 4.5)
    svg += screen.svg
    // the bezel on the shaded side: two drive bays, power button, LED
    for (const z of [35, 30.5]) {
      svg += p.shape(on(PY(L), rrUV(3, z, TOWER.d - 3, z + 3.2, 0.6, 2)), mix(bezel, '#ffffff', 0.12), 0.8)
    }
    svg += p.shape(on(PY(L), ellUV(TOWER.d - 5, 8, 1.6, 1.6, 10)), look.mat(METAL).m, 0.8)
    svg += led(p, look, F, TOWER.w - 2.2, 4, 0.7) + sticker(p, look, F, 6.5, 4, 1.3)
    svg += vents(p, L, 4, TOWER.d - 4, [14, 17, 20, 23])
    svg += b.ink
    return { svg, portal: screen.corners, body: b.pts }
  }
}

// ── cloud: a server on a cloud plinth ───────────────────────────────────────
const PLINTH = 6
/** Puffs: x, y, radius, height. The tall ones make the flat top the server stands on. */
const PUFFS: Array<[number, number, number, number]> = [
  [12, 12, 11, PLINTH],
  [14, 30, 11, PLINTH],
  [26, 21, 11, PLINTH],
  [2, 22, 7, PLINTH - 1.6],
  [28, 37, 6.5, PLINTH - 1.6],
  [32, 6, 6, PLINTH - 2]
]
const BOX = { x0: 10, x1: 26, y0: 6, y1: 36, h: 21 }

export const cloud: MachineModel = {
  shadowZ: 0,
  fit: [[1, -1, 0], [38, 44, 0], [-5, 22, 0], [BOX.x0, BOX.y0, PLINTH + BOX.h], [BOX.x0, BOX.y1, PLINTH + BOX.h]],
  draw(p, look) {
    const fluff = look.mat(CLOUD)
    const m = look.mat(PALS.mint)
    const ring = ([x, y, r]: [number, number, number, number], z: number) => on(PZ(z), ellUV(x, y, r, r, 12))
    const puffPts = PUFFS.flatMap((q) => [...ring(q, 0), ...ring(q, q[3])])
    const prof = rrUV(BOX.y0, PLINTH, BOX.y1, PLINTH + BOX.h, 2, 3)
    const b = body(p, prof, BOX.x0, BOX.x1, m, 2.6)
    let svg = p.castShadow(puffPts, 0)
    svg += byDepth(PUFFS.map((q) => ({ at: [q[0], q[1], q[3]] as V3, svg: p.cyl(q[0], q[1], 0, q[3], q[2], fluff, tone, 1.6, 12) })))
    const tops = PUFFS.filter((q) => q[3] === PLINTH).flatMap((q) => ring(q, PLINTH))
    svg += p.castShadow(b.pts, PLINTH, tops, 'opacity=".8"')
    svg += b.svg
    const F = BOX.x1 + 0.02
    const screen = portalScreen(p, look, F, BOX.y0 + 2.2, PLINTH + 3.6, BOX.y1 - 2.2, PLINTH + BOX.h - 2.2)
    svg += screen.svg + led(p, look, F, BOX.y0 + 1.3, PLINTH + 2, 0.6) + sticker(p, look, F, BOX.y1 - 4, PLINTH + 2, 1.2)
    svg += vents(p, BOX.y1 + 0.02, BOX.x0 + 3, BOX.x1 - 3, [PLINTH + 12, PLINTH + 14.5, PLINTH + 17])
    svg += b.ink
    return { svg, portal: screen.corners, body: [...puffPts, ...b.pts] }
  }
}

// ── cluster: linked pods on one plate ───────────────────────────────────────
interface Pod {
  x0: number
  x1: number
  y0: number
  y1: number
  h: number
}
const PLATE = { x0: 0, x1: 44, y0: 0, y1: 50, h: 2 }
const BACK_PODS: Pod[] = [
  { x0: 3, x1: 13, y0: 35, y1: 47, h: 19 },
  { x0: 3, x1: 13, y0: 3, y1: 15, h: 19 }
]
const FRONT_POD: Pod = { x0: 19, x1: 39, y0: 11, y1: 39, h: 26 }

export const cluster: MachineModel = {
  shadowZ: 0,
  fit: [[PLATE.x0, PLATE.y0, 0], [PLATE.x1, PLATE.y1, PLATE.h + 26]],
  draw(p, look) {
    const m = look.mat(PALS.mint)
    const z0 = PLATE.h
    const pod = (q: Pod, w: number) => body(p, rrUV(q.y0, z0, q.y1, z0 + q.h, 2, 2), q.x0, q.x1, m, w)
    const top = (q: Pod): V3 => [q.x1 - 2, (q.y0 + q.y1) / 2, z0 + q.h]
    const back = (q: Pod, y: number): V3 => [q.x0 + 2, y, z0 + q.h]
    const cable = (a: V3, b: V3) => p.tube(a, b, 2.5, 0.55, look.mat(DARK))
    const backs = BACK_PODS.map((q) => pod(q, 2.4))
    const front = pod(FRONT_POD, 2.8)
    const platePts = p.slabPts(PLATE.x0, PLATE.y0, PLATE.x1, PLATE.y1, 0, z0, 3)
    let svg = p.castShadow([...platePts, ...backs.flatMap((b) => b.pts), ...front.pts], 0)
    svg += p.slab(PLATE.x0, PLATE.y0, PLATE.x1, PLATE.y1, 0, z0, 3, look.mat(METAL), tone, 2.2)
    const clip = p.slabPts(PLATE.x0, PLATE.y0, PLATE.x1, PLATE.y1, z0, z0, 3)
    svg += BACK_PODS.map((q, i) => {
      const F = q.x1 + 0.02
      const cy = (q.y0 + q.y1) / 2
      return (
        p.castShadow(backs[i].pts, z0, clip, 'opacity=".55"') +
        backs[i].svg +
        p.shape(on(PX(F), rrUV(q.y0 + 2.5, z0 + 9, q.y1 - 2.5, z0 + q.h - 3, 1, 2)), look.hex('#3c4a44'), 1.1) +
        led(p, look, F, cy, z0 + 4.5, 0.7) +
        backs[i].ink
      )
    }).join('')
    svg += p.castShadow(front.pts, z0, clip, 'opacity=".55"') + front.svg
    const F = FRONT_POD.x1 + 0.02
    const screen = portalScreen(p, look, F, FRONT_POD.y0 + 2.4, z0 + 6.5, FRONT_POD.y1 - 2.4, z0 + FRONT_POD.h - 2.6)
    svg += screen.svg + led(p, look, F, FRONT_POD.y0 + 3.4, z0 + 3.4, 0.7) + sticker(p, look, F, FRONT_POD.y1 - 5, z0 + 3.4, 1.4)
    svg += vents(p, FRONT_POD.y1 + 0.02, FRONT_POD.x0 + 3, FRONT_POD.x1 - 3, [z0 + 12, z0 + 15, z0 + 18])
    svg += front.ink
    svg += cable(top(BACK_PODS[0]), back(FRONT_POD, FRONT_POD.y1 - 3)) + cable(top(BACK_PODS[1]), back(FRONT_POD, FRONT_POD.y0 + 3))
    return { svg, portal: screen.corners, body: [...platePts, ...front.pts] }
  }
}
