// The laptop on its desk mat (its screen is the portal) and the unknown
// machine (a plain box). Desktops live in desktop.ts.
// Units are about a centimetre; x = depth (front at max x), y = width, z = up.
import { on, PX, PZ, rectUV, rrUV } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { BOARD, INK, matOf, METAL, tone } from '../iso/tone'
import type { Look, MachineModel } from './look'
import { led, portalScreen, sticker } from './parts'

const MAT_H = 1.4
const BEZEL = '#2b2824'

const mat = (p: Pen, look: Look, x0: number, y0: number, x1: number, y1: number) => p.board(x0, y0, x1, y1, MAT_H, 3, look.mat(BOARD))

// ── laptop ──────────────────────────────────────────────────────────────────
const LAP = { x0: 2, x1: 24, y0: 2, y1: 33, t: 1.6, lid: 21 }

export const laptop: MachineModel = {
  shadowZ: MAT_H,
  fit: [[-2, -2, 0], [28, 37, 0], [2, 2, MAT_H + LAP.t + LAP.lid], [2, 33, MAT_H + LAP.t + LAP.lid]],
  draw(p, look) {
    const z0 = MAT_H
    const zt = z0 + LAP.t
    const body = look.mat(METAL)
    const lid = { x0: LAP.x0, x1: LAP.x0 + 0.9, z1: zt + LAP.lid }
    const basePts = p.slabPts(LAP.x0, LAP.y0, LAP.x1, LAP.y1, z0, zt, 1.4)
    const lidPts = p.boxPts(lid.x0, LAP.y0, zt, lid.x1, LAP.y1, lid.z1)
    let svg = mat(p, look, -2, -2, 28, 37)
    svg += p.castShadow([...basePts, ...lidPts], z0, p.boardTop(-2, -2, 28, 37, z0, 3))
    // base, keyboard well, trackpad, LED
    svg += p.slab(LAP.x0, LAP.y0, LAP.x1, LAP.y1, z0, zt, 1.4, body, tone, 2.2)
    const top = PZ(zt + 0.02)
    const well = on(top, rectUV(4.6, 4.5, 13.6, 30.5))
    svg += p.fill(well, look.hex('#3a3632')) + p.ink(well, 0.8)
    for (const x of [6.8, 9.1, 11.4]) svg += p.line([[x, 4.9, zt + 0.03], [x, 30.1, zt + 0.03]], 0.6, { color: look.hex('#6d6862') })
    svg += p.shape(on(top, rrUV(15.6, 12, 21.6, 23, 0.8, 2)), body.m, 0.8)
    svg += led(p, look, LAP.x1 + 0.02, 6, z0 + LAP.t / 2, 0.45)
    // lid: back shell, bezel, screen
    svg += p.box(lid.x0, LAP.y0, zt, lid.x1, LAP.y1, lid.z1, body, tone, 1)
    svg += p.fill(on(PX(lid.x1 + 0.01), rectUV(LAP.y0 + 0.3, zt + 0.3, LAP.y1 - 0.3, lid.z1 - 0.3)), look.hex(BEZEL))
    const screen = portalScreen(p, look, lid.x1 + 0.03, LAP.y0 + 1.3, zt + 1.4, LAP.y1 - 1.3, lid.z1 - 1.3)
    svg += screen.svg + sticker(p, look, LAP.x1 + 0.02, 27, z0 + 0.8, 1.2)
    svg += p.hullInk([...lidPts], 2.4) + p.hullInk(basePts, 2.8)
    return { svg, portal: screen.corners, body: [...basePts, ...lidPts] }
  }
}

// ── unknown: a plain cardboard box ──────────────────────────────────────────
const CARD = '#d9b77e'

export const unknown: MachineModel = {
  shadowZ: 0,
  fit: [[0, 0, 0], [30, 30, 0], [0, 0, 26], [30, 30, 26], [0, 30, 26]],
  draw(p, look) {
    const card = look.mat(matOf(CARD))
    const pts = p.boxPts(0, 0, 0, 30, 30, 26)
    let svg = p.castShadow(pts, 0)
    svg += p.box(0, 0, 0, 30, 30, 26, card, tone, 1.2)
    // packing tape over the top, a "?" on the side
    svg += p.fill(on(PZ(26.02), rectUV(0, 12.5, 30, 17.5)), look.hex('#e8cf9c'), 'opacity=".9"')
    svg += p.fill(on(PX(30.02), rectUV(12.5, 21, 17.5, 26)), look.hex('#e8cf9c'), 'opacity=".9"')
    svg += p.txY(15, 30.05, 7, '?', 15, tone([0, 1, 0], card) === card.d ? card.l : INK, 900)
    const screen = portalScreen(p, look, 30.03, 4, 5, 26, 19)
    svg += screen.svg + led(p, look, 30.04, 23.5, 2.6, 0.7) + sticker(p, look, 30.04, 7, 2.6, 1.6)
    svg += p.hullInk(pts, 2.8)
    return { svg, portal: screen.corners, body: pts }
  }
}
