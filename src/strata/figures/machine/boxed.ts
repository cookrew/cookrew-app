// Machines inside something: the VM (a monitor in a glass box) and the
// sandbox (a toy computer in a sand tray). The inner machine's screen is the portal.
import { clipConvex, ellUV, hull, on, PX, PY, PZ, rectUV, rrUV } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { CLEAR, METAL, PALS, tone, toneI, WOOD, type Mat } from '../iso/tone'
import type { Look, MachineModel } from './look'
import { body, led, portalScreen, sticker } from './parts'

const BEZEL = '#2b2824'

/** A small monitor on a foot, its screen facing +x at x = px1. */
const monitor = (p: Pen, look: Look, m: Mat, at: { x: number; y0: number; y1: number; z: number; h: number }) => {
  const px0 = at.x
  const px1 = at.x + 1.4
  const yc = (at.y0 + at.y1) / 2
  const panelPts = p.boxPts(px0, at.y0, at.z + 6.4, px1, at.y1, at.z + 6.4 + at.h)
  let svg = p.slab(px0 - 3, yc - 5, px0 + 5, yc + 5, at.z, at.z + 0.6, 1.2, m, tone, 1.2)
  svg += p.box(px0 - 1.5, yc - 1.5, at.z + 0.6, px0, yc + 1.5, at.z + 9, m, tone, 0.9)
  svg += p.box(px0, at.y0, at.z + 6.4, px1, at.y1, at.z + 6.4 + at.h, m, tone, 1)
  svg += p.fill(on(PX(px1 + 0.01), rectUV(at.y0 + 0.3, at.z + 6.7, at.y1 - 0.3, at.z + 6.1 + at.h)), look.hex(BEZEL))
  const screen = portalScreen(p, look, px1 + 0.03, at.y0 + 1.1, at.z + 7.6, at.y1 - 1.1, at.z + 5.2 + at.h)
  svg += screen.svg + p.hullInk(panelPts, 2)
  return { svg, portal: screen.corners, pts: panelPts }
}

// ── vm: a machine in a glass box ────────────────────────────────────────────
const GLASS = { x0: 1, x1: 31, y0: 1, y1: 31, z0: 1.6, z1: 30 }

export const vm: MachineModel = {
  shadowZ: 0,
  fit: [[0, 0, 0], [32, 32, 0], [0, 32, 0], [GLASS.x0, GLASS.y0, GLASS.z1], [GLASS.x1, GLASS.y1, GLASS.z1], [GLASS.x0, GLASS.y1, GLASS.z1]],
  draw(p, look) {
    const G = GLASS
    const glass = look.mat(CLEAR)
    const basePts = p.slabPts(0, 0, 32, 32, 0, G.z0, 1.5)
    const boxPts = p.boxPts(G.x0, G.y0, G.z0, G.x1, G.y1, G.z1)
    let svg = p.castShadow(basePts, 0) + p.castShadow(boxPts, 0, null, 'opacity=".45"')
    svg += p.slab(0, 0, 32, 32, 0, G.z0, 1.5, look.mat(METAL), tone, 2)
    // far walls, seen through the near ones
    svg += p.fill(on(PX(G.x0), rectUV(G.y0, G.z0, G.y1, G.z1)), glass.l, 'opacity=".45"')
    svg += p.fill(on(PY(G.y0), rectUV(G.x0, G.z0, G.x1, G.z1)), glass.m, 'opacity=".45"')
    svg += p.line([[G.x0, G.y0, G.z0], [G.x0, G.y0, G.z1]], 0.8, { extra: 'opacity=".5"' })
    svg += p.line([[G.x0, G.y1, G.z0], [G.x0, G.y0, G.z0], [G.x1, G.y0, G.z0]], 0.8, { extra: 'opacity=".5"' })
    // the machine inside, with its own shadow on the floor
    const inner = monitor(p, look, look.mat(PALS.mustard), { x: 11, y0: 3, y1: 29, z: G.z0, h: 17 })
    svg += p.castShadow(inner.pts, G.z0, on(PZ(G.z0), rectUV(G.x0, G.y0, G.x1, G.y1)), 'opacity=".6"') + inner.svg
    svg += p.box(19, 9, G.z0, 25, 23, G.z0 + 0.7, look.mat(METAL), toneI, 0.8)
    // near walls: a light tint, two streaks, the edges
    svg += p.fill(on(PY(G.y1), rectUV(G.x0, G.z0, G.x1, G.z1)), glass.m, 'opacity=".22"')
    svg += p.fill(on(PX(G.x1), rectUV(G.y0, G.z0, G.y1, G.z1)), glass.l, 'opacity=".18"')
    svg += p.fill(on(PZ(G.z1), rectUV(G.x0, G.y0, G.x1, G.y1)), glass.l, 'opacity=".3"')
    for (const [a, w] of [[6, 2.2], [11, 1]] as const) {
      svg += p.fill(on(PX(G.x1 + 0.02), [[G.y1 - a, G.z1 - 1], [G.y1 - a - w, G.z1 - 1], [G.y1 - a - w - 9, G.z0 + 6], [G.y1 - a - 9, G.z0 + 6]]), '#ffffff', 'opacity=".38"')
    }
    svg += p.ink(on(PX(G.x1), rectUV(G.y0, G.z0, G.y1, G.z1)), 1.2)
    svg += p.ink(on(PZ(G.z1), rectUV(G.x0, G.y0, G.x1, G.y1)), 1.2)
    svg += p.line([[G.x1, G.y1, G.z0], [G.x0 + 0.02, G.y1, G.z0]], 1)
    svg += led(p, look, 32.02, 4, G.z0 / 2, 0.5) + sticker(p, look, 32.02, 27, G.z0 / 2, 0.75)
    svg += p.hullInk([...basePts, ...boxPts], 2.6)
    return { svg, portal: inner.portal, body: [...basePts, ...boxPts] }
  }
}

// ── sandbox: a toy machine in a sand tray ───────────────────────────────────
const SAND: Mat = { l: '#f1d9a0', m: '#dcbf80', d: '#b39557' }
const TRAY = { x1: 44, y1: 48, h: 5, rim: 2.6, sand: 3.4 }
const TOY = { x0: 12, x1: 28, y0: 9, y1: 35, h: 18 }

export const sandbox: MachineModel = {
  shadowZ: 0,
  fit: [[0, 0, 0], [TRAY.x1, TRAY.y1, 0], [0, TRAY.y1, 0], [0, 0, TRAY.h], [TOY.x0, TOY.y0, TRAY.sand + TOY.h], [TOY.x0, TOY.y1, TRAY.sand + TOY.h]],
  draw(p, look) {
    const wood = look.mat(WOOD)
    const sand = look.mat(SAND)
    const m = look.mat(PALS.tomato)
    const T = TRAY
    const trayPts = p.slabPts(0, 0, T.x1, T.y1, 0, T.h, 2.5)
    const opening = on(PZ(T.h), rrUV(T.rim, T.rim, T.x1 - T.rim, T.y1 - T.rim, 1.2, 2))
    const floor = on(PZ(T.sand), rrUV(T.rim, T.rim, T.x1 - T.rim, T.y1 - T.rim, 1.2, 2))
    const window2 = hull(opening.map(p.P))
    let svg = p.castShadow(trayPts, 0)
    svg += p.slab(0, 0, T.x1, T.y1, 0, T.h, 2.5, wood, tone, 2.6)
    svg += p.fill(opening, wood.m)
    svg += p.fill2(clipConvex(floor.map(p.P), window2), sand.l)
    svg += p.ink(opening, 1.1)
    // a pail in the back corner
    const pail = PALS.cobalt
    svg += p.castShadow(on(PZ(T.sand + 5), ellUV(8, 41, 3, 3, 10)).concat(on(PZ(T.sand), ellUV(8, 41, 2.5, 2.5, 10))), T.sand, opening, 'opacity=".7"')
    svg += p.cyl(8, 41, T.sand, T.sand + 5, 3, look.mat(pail), tone, 1.4, 14)
    svg += p.line([[8, 38, T.sand + 5], [8, 39, T.sand + 8], [8, 43, T.sand + 8], [8, 44, T.sand + 5]], 0.9)
    // the toy machine
    const prof = rrUV(TOY.y0, T.sand, TOY.y1, T.sand + TOY.h, 2.4, 3)
    const b = body(p, prof, TOY.x0, TOY.x1, m, 2.6)
    svg += p.castShadow(b.pts, T.sand, opening, 'opacity=".8"') + b.svg
    const F = TOY.x1 + 0.02
    const screen = portalScreen(p, look, F, TOY.y0 + 2, T.sand + 4, TOY.y1 - 2, T.sand + TOY.h - 2.2)
    svg += screen.svg + led(p, look, F, TOY.y0 + 2.2, T.sand + 2, 0.6) + sticker(p, look, F, TOY.y1 - 4, T.sand + 2, 1.2)
    svg += b.ink
    return { svg, portal: screen.corners, body: [...trayPts, ...b.pts] }
  }
}
