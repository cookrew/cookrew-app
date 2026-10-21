// Desktops in three forms, read from the hardware's model or label:
//   mini        a small box beside a display (Mac mini; Mac Studio as a taller box) — the default
//   tower       a tower standing beside a display (Mac Pro, workstations, PC towers)
//   all-in-one  the display is the computer (iMac), coloured chin, a keyboard in front
// The display's screen is the portal in every form.
import { on, PX, rectUV } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { BOARD, matOf, METAL, mix, PALS, tone, type Mat } from '../iso/tone'
import type { Look, MachineModel } from './look'
import { led, portalScreen, sticker, vents } from './parts'

export type DesktopForm = 'mini' | 'tower' | 'all-in-one'

/** The form from a model id or label ('Mac14,3', 'Mac mini', 'iMac (24-inch)', 'Precision 3660 Tower'). */
export const desktopFormOf = (model: string | null | undefined): DesktopForm => {
  const m = (model ?? '').toLowerCase()
  if (/imac|all[- ]?in[- ]?one|\baio\b/.test(m)) return 'all-in-one'
  if (/mac ?pro|macpro|tower|workstation|thinkstation|precision|optiplex|\bz[48]\b/.test(m)) return 'tower'
  return 'mini'
}

const MAT_H = 1.4
const BEZEL = '#2b2824'

const mat = (p: Pen, look: Look, x0: number, y0: number, x1: number, y1: number) =>
  p.board(x0, y0, x1, y1, MAT_H, 3, look.mat(BOARD))

interface Panel {
  x0: number
  x1: number
  y0: number
  y1: number
  /** Bottom and top of the panel above the mat. */
  z0: number
  z1: number
}

/** A display panel on a foot and neck; returns its screen corners (the portal). */
const display = (p: Pen, look: Look, d: Panel, m: Mat, chin = 0, chinMat?: Mat) => {
  const z = MAT_H
  const yc = (d.y0 + d.y1) / 2
  const panelPts = p.boxPts(d.x0, d.y0, z + d.z0, d.x1, d.y1, z + d.z1)
  let svg = p.slab(d.x0 - 4, yc - 8, d.x0 + 6, yc + 8, z, z + 0.7, 1.5, m, tone, 1.4)
  svg += p.box(d.x0 - 1.6, yc - 2.5, z + 0.7, d.x0, yc + 2.5, z + d.z0 + 4, m, tone, 1)
  svg += p.box(d.x0, d.y0, z + d.z0, d.x1, d.y1, z + d.z1, chinMat ?? m, tone, 1)
  const F = d.x1 + 0.01
  if (chin > 0 && chinMat) svg += p.fill(on(PX(F), rectUV(d.y0 + 0.3, z + d.z0 + 0.3, d.y1 - 0.3, z + d.z0 + chin)), tone([1, 0, 0], chinMat))
  svg += p.fill(on(PX(F), rectUV(d.y0 + 0.4, z + d.z0 + chin + 0.2, d.y1 - 0.4, z + d.z1 - 0.4)), look.hex(BEZEL))
  const screen = portalScreen(p, look, d.x1 + 0.03, d.y0 + 1.3, z + d.z0 + chin + 1.4, d.y1 - 1.3, z + d.z1 - 1.3)
  return { svg: svg + screen.svg + p.hullInk(panelPts, 2.6), portal: screen.corners, pts: panelPts }
}

// ── mini (and Mac Studio): a box beside the display ─────────────────────────
const MINI_PANEL: Panel = { x0: 9, x1: 10.6, y0: 2, y1: 48, z0: 9, z1: 36 }

const miniDesktop = (tall: boolean): MachineModel => ({
  shadowZ: MAT_H,
  fit: [[-2, -2, 0], [36, 52, MAT_H + MINI_PANEL.z1]],
  draw(p, look) {
    const z0 = MAT_H
    const metal = look.mat(METAL)
    const box = { x0: 19, x1: 33, y0: 1, y1: 15, z1: z0 + (tall ? 8.6 : 3.6) }
    const boxPts = p.slabPts(box.x0, box.y0, box.x1, box.y1, z0, box.z1, 2.6)
    const clip = p.boardTop(-2, -2, 36, 52, z0, 3)
    const shown = display(p, look, MINI_PANEL, metal)
    let svg = mat(p, look, -2, -2, 36, 52) + p.castShadow(shown.pts, z0, clip) + p.castShadow(boxPts, z0, clip)
    svg += shown.svg
    svg += p.slab(box.x0, box.y0, box.x1, box.y1, z0, box.z1, 2.6, metal, tone, 2.4)
    if (tall) svg += vents(p, box.y1 + 0.02, box.x0 + 3, box.x1 - 3, [z0 + 2])
    svg += led(p, look, box.x1 + 0.02, 4, z0 + 1.6, 0.5) + sticker(p, look, box.x1 + 0.02, 10.5, z0 + 1.8, 1.3)
    return { svg, portal: shown.portal, body: [...shown.pts, ...boxPts] }
  }
})

// ── tower beside the display ────────────────────────────────────────────────
const TOWER_PANEL: Panel = { x0: 9, x1: 10.6, y0: 12, y1: 52, z0: 9, z1: 33 }
const TOWER = { x0: 4, x1: 24, y0: -9, y1: 0, h: 24 }

const towerDesktop: MachineModel = {
  shadowZ: MAT_H,
  fit: [[-2, -12, 0], [30, 56, MAT_H + TOWER_PANEL.z1]],
  draw(p, look) {
    const z0 = MAT_H
    const metal = look.mat(METAL)
    const body = look.mat(matOf('#a9b0b4'))
    const t = TOWER
    const towerPts = p.boxPts(t.x0, t.y0, z0, t.x1, t.y1, z0 + t.h)
    const clip = p.boardTop(-2, -12, 30, 56, z0, 3)
    const shown = display(p, look, TOWER_PANEL, metal)
    let svg = mat(p, look, -2, -12, 30, 56) + p.castShadow(shown.pts, z0, clip) + p.castShadow(towerPts, z0, clip)
    svg += shown.svg
    svg += p.box(t.x0, t.y0, z0, t.x1, t.y1, z0 + t.h, body, tone, 1)
    // the front: a grille of slots, a drive slot, LED
    const F = t.x1 + 0.02
    svg += p.fill(on(PX(F), rectUV(t.y0 + 1.6, z0 + 4, t.y1 - 1.6, z0 + t.h - 2)), mix(tone([1, 0, 0], body), '#000000', 0.08))
    svg += [8, 11, 14, 17, 20].map((dz) => p.line([[F, t.y0 + 2.4, z0 + dz], [F, t.y1 - 2.4, z0 + dz]], 0.8, { extra: 'opacity=".6"' })).join('')
    svg += led(p, look, F, t.y1 - 2.2, z0 + 2, 0.6) + sticker(p, look, F, t.y0 + 3, z0 + 2, 1.2)
    svg += p.hullInk(towerPts, 2.6)
    return { svg, portal: shown.portal, body: [...shown.pts, ...towerPts] }
  }
}

// ── all-in-one: the display is the computer ─────────────────────────────────
const AIO_PANEL: Panel = { x0: 9, x1: 10.4, y0: 3, y1: 47, z0: 8, z1: 37 }
const CHIN = 5

const allInOne: MachineModel = {
  shadowZ: MAT_H,
  fit: [[-2, -2, 0], [34, 52, MAT_H + AIO_PANEL.z1]],
  draw(p, look) {
    const z0 = MAT_H
    const shell = look.mat(PALS.blush)
    const metal = look.mat(METAL)
    const kb = { x0: 20, x1: 27, y0: 10, y1: 38 }
    const kbPts = p.slabPts(kb.x0, kb.y0, kb.x1, kb.y1, z0, z0 + 0.8, 1)
    const clip = p.boardTop(-2, -2, 34, 52, z0, 3)
    const shown = display(p, look, AIO_PANEL, shell, CHIN, shell)
    let svg = mat(p, look, -2, -2, 34, 52) + p.castShadow(shown.pts, z0, clip)
    svg += shown.svg
    svg += led(p, look, AIO_PANEL.x1 + 0.03, AIO_PANEL.y0 + 3, z0 + AIO_PANEL.z0 + CHIN / 2, 0.5)
    svg += sticker(p, look, AIO_PANEL.x1 + 0.03, AIO_PANEL.y1 - 4, z0 + AIO_PANEL.z0 + CHIN / 2, 1.3)
    svg += p.slab(kb.x0, kb.y0, kb.x1, kb.y1, z0, z0 + 0.8, 1, metal, tone, 1.4)
    svg += [22.3, 24.6].map((x) => p.line([[x, kb.y0 + 1.4, z0 + 0.82], [x, kb.y1 - 1.4, z0 + 0.82]], 0.6, { color: look.hex('#9aa1a4') })).join('')
    return { svg, portal: shown.portal, body: [...shown.pts, ...kbPts] }
  }
}

const MINI = miniDesktop(false)
const STUDIO = miniDesktop(true)

export const desktopModel = (model: string | null | undefined): MachineModel => {
  const form = desktopFormOf(model)
  if (form === 'tower') return towerDesktop
  if (form === 'all-in-one') return allInOne
  return /studio/i.test(model ?? '') ? STUDIO : MINI
}
