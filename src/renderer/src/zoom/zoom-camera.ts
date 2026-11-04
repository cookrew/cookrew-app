/**
 * THE ZOOM'S CAMERAS (moved out of zoom-frame.ts, which re-exports all of
 * this): where the scene is framed at the desk and on a phone, the open
 * card's and the thumbnails' cameras, the free spot for the workspace label
 * at the card stop, and the type scales the words are drawn at. Pure:
 * zoom-frame.ts paints with these, tests pin them.
 */
import { clamp01, ease, lerp } from './zoom-path'
import { fitScale, SWS, TILE, type Box, type crewOf, type deviceOf, type Pos, type stackOf, type thumbsOf } from './zoom-layout'
import { PHONE_TYPE, sceneWords, type RestScales, type SceneWords } from './scene-words'

export const GROUP_BOX: Box = { w: 430, h: 320, cy: 0 }
export { SWS }

export interface Layout {
  stack: ReturnType<typeof stackOf>
  crew: ReturnType<typeof crewOf>
  cardBox: Box
  thumbs: ReturnType<typeof thumbsOf>
  device: ReturnType<typeof deviceOf>
  devicesBox: Box
}

/** The scene's framing box at agent zoom z: the group, the crew, the card's room. */
export function boxAt(L: Layout, z: number): Box {
  const mix = (a: Box, b: Box, t: number): Box => ({ w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), cy: lerp(a.cy, b.cy, t) })
  if (z <= 1) return mix(GROUP_BOX, L.crew.box, ease(z))
  return mix(L.crew.box, L.cardBox, ease(clamp01(z - 1)))
}

/** A face's reach around its anchor: its labels below, its coins to the right (zoom.css). */
const FACE_REACH = { left: 100, right: 110, top: 56, bottom: 116 }
/** The open card around its agent's anchor (zoom.css · .zv-card: 260 × 244 from −34, −34). */
const CARD_RECT = { x: -34, y: -34, w: 260, h: 244 }
const PHONE_MARGIN = 12
/**
 * THE STOP BAR'S ROOM (owner, 2026-11-01, Samsung Browser: Probe5 and Probe6
 * stood under DEVICES / DEVICE / CREW / CARD / FULL and no scroll brought
 * them out). The bar floats over the bottom of the overview (zoom.css, a
 * phone: 8 from the edge, 5 + 40 + 5 tall with a finger's stops), so the
 * crew and the thumbnails end that far above the edge, not at it.
 */
export const PHONE_BAR = 58
/** The open card on a phone grows past 1:1 to fill the screen's width (2026-11-01 phone evals: at 1:1 it took 63%). */
const CARD_MAX = 1.5
/** The card and the remove mark over its corner (zoom.css · .zv-del: 222..244 across, 46 up): all of it stays on screen. */
const CARD_SEEN = { x: CARD_RECT.x, y: -46, w: 244 - CARD_RECT.x, h: CARD_RECT.y + CARD_RECT.h + 46 }
/**
 * THE DEVICE STOP'S WORDS (Gauge, 2026-11-01: on a desktop the workspaces'
 * names and counts read at ~6px; on a phone the hint ran off the right edge).
 * A tile is drawn at SWS inside a device the camera fits into the window, so a
 * word set in CSS px is seen smaller by both: each is drawn back to 1:1 on
 * screen and cut short inside its tile (owner, 2026-11-04: the labels ran over
 * each other, so a tile's words now live inside its frame).
 *   markK             a tile's words (workspace-tile.css cuts a name at the frame)
 *   density           which words a tile has room for: roomy, snug, compact, tiny
 *   titleK, titleMax  the machine's name over the tiles, short of the per-row pill on a phone
 */
export const DEVICE_TEXT_PX = 11
/** A tile as wide as this on screen keeps every word; then only its numbers; then their totals; under that, its name alone. */
const TILE_ROOMY_PX = 150
const TILE_SNUG_PX = 125
const TILE_COMPACT_PX = 92
/** The per-row pill and the margins either side of the title on a phone (zoom.css · .zv-cols). */
const PILL_ROOM = 178
export type TileDensity = 'roomy' | 'snug' | 'compact' | 'tiny'
export interface DeviceWords {
  cam: number
  markK: number
  density: TileDensity
  titleK: number
  titleMax: number
}
type Device = ReturnType<typeof deviceOf>
export function deviceWords(device: Device, w: number, h: number, narrow: boolean): DeviceWords {
  const cam = deviceCam(device, w, h, narrow).S
  // A phone draws them 1:1 on screen, at its own type; a desk only grows its 11px words to DEVICE_TEXT_PX.
  const markK = narrow ? 1 / (SWS * cam) : Math.max(1, DEVICE_TEXT_PX / (11 * SWS * cam))
  const titleK = narrow ? 1 / cam : Math.max(1, DEVICE_TEXT_PX / (11 * cam))
  const tilePx = TILE.w * SWS * cam
  const density: TileDensity = tilePx >= TILE_ROOMY_PX ? 'roomy' : tilePx >= TILE_SNUG_PX ? 'snug' : tilePx >= TILE_COMPACT_PX ? 'compact' : 'tiny'
  return { cam, markK, density, titleK, titleMax: narrow ? (w - PILL_ROOM) / (titleK * cam) : (device.box.w - 100) / titleK }
}

export interface Camera {
  S: number
  Ox: number
  Oy: number
  panMax: number
}

type Cam = Pick<Camera, 'S' | 'Ox' | 'Oy'>
/** Between two cameras: the scale in log space, so a zoom feels even; the origin straight. */
const lerpCam = (a: Cam, b: Cam, t: number): Cam => ({
  S: Math.exp(lerp(Math.log(a.S), Math.log(b.S), t)),
  Ox: lerp(a.Ox, b.Ox, t),
  Oy: lerp(a.Oy, b.Oy, t)
})

/** The open card (and its remove mark) centred in a w × h view, as large as fits up to `max`. */
function cardCam(L: Layout, focus: string | null, w: number, h: number, margin: number, max: number): Cam {
  const at = (focus && L.crew.at[focus]) || { x: 0, y: 0 }
  const cx = at.x + CARD_SEEN.x + CARD_SEEN.w / 2
  const cy = at.y + CARD_SEEN.y + CARD_SEEN.h / 2
  const S = Math.min(max, (w - margin * 2) / CARD_SEEN.w, (h - margin * 2) / CARD_SEEN.h)
  return { S, Ox: w / 2 - cx * S, Oy: h / 2 - cy * S }
}

/**
 * THE WORKSPACE'S LABEL AT THE CREW: over the crew's top-left corner. A phone
 * frames the faces, not the crew's box (phoneCamera), so there the label
 * stands over the leftmost face's reach, inside what the camera frames
 * (Gauge, 2026-11-01: on a phone's crew stop it stood off the left edge).
 */
export function crewLabelAt(L: Layout, narrow: boolean, k = 1): Pos {
  const top = Math.min(0, ...Object.values(L.crew.at).map((p) => p.y))
  if (!narrow) return { x: -L.crew.box.w / 2 + 70, y: top - 90 }
  // A phone's label wraps to two lines (zoom.css: 130px wide): it ends above the faces' reach,
  // as tall as it is drawn (k: its words at caption on screen, scene-words.ts).
  const spots = [...Object.values(L.crew.at), L.crew.next]
  return { x: Math.min(...spots.map((p) => p.x)) - FACE_REACH.left, y: top - FACE_REACH.top - 8 - PHONE_LABEL_H * k }
}
/** A phone's workspace label at most: seal over totals, two lines (zoom.css · .zv-grp at 759px). */
const PHONE_LABEL_H = 56

/**
 * THE OPEN CARD ON A DESKTOP (Gauge, 2026-11-01: at the card stop the card was
 * drawn at the crew's fit, ~0.6, and its words at ~7px). As on a phone, the
 * camera closes in on the card, up to DESK_CARD_S, centred above the stop
 * bar: its latest lines (zoom.css · .zv-body, 11.5px) read at 16px and its
 * state word (10px) at 14px. Up to the crew it frames the crew's box, as before.
 */
export const DESK_CARD_S = 1.4
/** The stop bar over the bottom of a desktop's overview (zoom.css · .zv-controls: 14 up, 46 tall). */
const DESK_BAR = 72
const DESK_MARGIN = 16
/**
 * THE WORKSPACES STOP'S CAMERA (owner, 2026-11-04). A phone reads it as a page:
 * the grid fills the width and starts at the top under the title and the
 * per-row pill, whatever the count, and ends above the stop bar (it used to
 * float in the middle, the title sliding under the pill). A desk centres it
 * above its bar. On both a taller grid keeps its scale and scrolls, as the crew
 * and the thumbnails do: shrunk to fit, its words would sit on its rings.
 */
export const PHONE_HEAD = 56
const PHONE_SIDE = 16
/** The rows a desk frames before the grid scrolls instead of shrinking. */
const DESK_DEVICE_ROWS = 3
export function deviceCam(device: Device, w: number, h: number, narrow: boolean, pan = 0): { S: number; Oy: number; panMax: number } {
  const { box } = device
  if (narrow) {
    const S = Math.min(1, (w - PHONE_SIDE * 2) / box.w)
    const panMax = Math.max(0, PHONE_HEAD + device.gridH * S + PHONE_MARGIN - (h - PHONE_BAR))
    return { S, Oy: PHONE_HEAD - device.gridTop * S - Math.min(Math.max(pan, 0), panMax), panMax }
  }
  // Three rows and the two gaps between them, the same whether there are three rows or thirty.
  const rows = (DESK_DEVICE_ROWS - 1) * device.rowH + SWS * device.tile.h
  const framed = box.h - device.gridH + Math.min(device.gridH, rows)
  const S = fitScale({ ...box, h: framed }, w, h - DESK_BAR)
  const panMax = framed < box.h ? Math.max(0, DESK_MARGIN + box.h * S - (h - DESK_BAR)) : 0
  if (panMax === 0) return { S, Oy: (h - DESK_BAR) / 2 - box.cy * S, panMax }
  return { S, Oy: DESK_MARGIN - (box.cy - box.h / 2) * S - Math.min(Math.max(pan, 0), panMax), panMax }
}

export function deskCamera(L: Layout, z: number, focus: string | null, w: number, h: number): Camera {
  const fitAt = (b: Box): Cam => {
    const S = fitScale(b, w, h)
    return { S, Ox: w / 2, Oy: h / 2 - b.cy * S }
  }
  if (z <= 1) return { ...fitAt(boxAt(L, z)), panMax: 0 }
  return { ...lerpCam(fitAt(L.crew.box), cardCam(L, focus, w, h - DESK_BAR, DESK_MARGIN, DESK_CARD_S), ease(clamp01(z - 1))), panMax: 0 }
}

/** Room kept between the workspace's label and the screen's edge. */
const LABEL_MARGIN = 12
/**
 * THE WORKSPACE'S LABEL STAYS ON SCREEN (Gauge, 2026-11-01: at a desktop's
 * card stop and a phone's crew stop it stood partly off the left edge). Its
 * box (scene units, scaled by k about its centre) is moved, as little as
 * needed, inside the view. A scrolled crew carries it off the top as it
 * carries the faces: `scrolled` px lower that bound.
 */
export function keepOnScreen(box: { x: number; y: number; w: number; h: number; k: number }, cam: Cam, w: number, h: number, scrolled = 0): Pos {
  const half = { x: (box.w * box.k * cam.S) / 2, y: (box.h * box.k * cam.S) / 2 }
  const into = (c: number, r: number, lo: number, hi: number): number => (hi - lo < 2 * r ? lo + r : Math.min(Math.max(c, lo + r), hi - r))
  const cx = into(cam.Ox + (box.x + box.w / 2) * cam.S, half.x, LABEL_MARGIN, w - LABEL_MARGIN)
  const cy = into(cam.Oy + (box.y + box.h / 2) * cam.S, half.y, LABEL_MARGIN - scrolled, h - LABEL_MARGIN)
  return { x: (cx - cam.Ox) / cam.S - box.w / 2, y: (cy - cam.Oy) / cam.S - box.h / 2 }
}

/** The camera the card stop rests at (z = 2): deskCamera's and phoneCamera's end. */
export function cardStopCamera(L: Layout, focus: string | null, w: number, h: number, narrow: boolean): Cam {
  return narrow ? cardCam(L, focus, w, h, PHONE_MARGIN, CARD_MAX) : cardCam(L, focus, w, h - DESK_BAR, DESK_MARGIN, DESK_CARD_S)
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}
const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** What the label must never cover at the card stop, on screen: every other agent's face, name and counts, the open card, the empty seat. */
export function cardStopTaken(L: Layout, focus: string | null, cam: Cam): Rect[] {
  const S = cam.S
  const at = (p: Pos): Pos => ({ x: cam.Ox + p.x * S, y: cam.Oy + p.y * S })
  const taken: Rect[] = []
  for (const [id, p] of Object.entries(L.crew.at)) {
    const a = at(p)
    taken.push(
      id === focus
        ? { left: a.x + CARD_SEEN.x * S, top: a.y + CARD_SEEN.y * S, right: a.x + (CARD_SEEN.x + CARD_SEEN.w) * S, bottom: a.y + (CARD_SEEN.y + CARD_SEEN.h) * S }
        : { left: a.x - FACE_REACH.left * S, top: a.y - FACE_REACH.top * S, right: a.x + FACE_REACH.right * S, bottom: a.y + FACE_REACH.bottom * S }
    )
  }
  const seat = at(L.crew.next)
  taken.push({ left: seat.x - 40 * S, top: seat.y - 40 * S, right: seat.x + 40 * S, bottom: seat.y + 40 * S })
  return taken
}

/**
 * THE WORKSPACE'S LABEL AT THE CARD STOP (Gauge, 2026-11-01: clamped into
 * the corner it sat on Moss's face on a desktop and on Forge's on a phone;
 * it must stay on screen and never cover a face or a name). The camera there
 * is known, so is every face it shows: the label takes the first free place
 * among the screen's corners, above and below the card, and along its top
 * and bottom edges. Its top-left corner on screen, or null when the screen
 * has no free place: then it fades rather than cover anyone.
 */
export function cardStopLabel(L: Layout, focus: string | null, w: number, h: number, narrow: boolean, label: { w: number; h: number }): Pos | null {
  const cam = cardStopCamera(L, focus, w, h, narrow)
  const taken = cardStopTaken(L, focus, cam)
  const lw = label.w * cam.S
  const lh = label.h * cam.S
  const M = LABEL_MARGIN
  const floor = h - (narrow ? PHONE_BAR : DESK_BAR)
  const card = taken[Object.keys(L.crew.at).indexOf(focus ?? '')] ?? null
  const spots: Pos[] = [
    { x: M, y: M },
    { x: w - M - lw, y: M }
  ]
  if (card) {
    spots.push({ x: card.left, y: card.top - 8 - lh }, { x: card.right - lw, y: card.top - 8 - lh }, { x: card.left, y: card.bottom + 8 }, { x: card.right - lw, y: card.bottom + 8 })
  }
  spots.push({ x: M, y: floor - M - lh }, { x: w - M - lw, y: floor - M - lh })
  const step = Math.max(24, lw / 3)
  for (let x = M + step; x < w - M - lw; x += step) spots.push({ x, y: M }, { x, y: floor - M - lh })
  const pad = 4
  return (
    spots.find((p) => {
      if (p.x < M - 0.5 || p.y < M - 0.5 || p.x + lw > w - M + 0.5 || p.y + lh > floor + 0.5) return false
      const r = { left: p.x - pad, top: p.y - pad, right: p.x + lw + pad, bottom: p.y + lh + pad }
      return !taken.some((t) => overlaps(r, t))
    }) ?? null
  )
}

/**
 * THE CAMERA ON A PHONE (owner, 2026-11-01: "too small"). The desktop camera
 * fits the crew's whole box, room for coins and a card to the right included,
 * into the window; on a 412px phone that drew every face at 0.4. Here:
 *   crew  the crew's own width fills the screen (at most 1:1), and a crew taller
 *         than the screen scrolls (`pan`, from the top), instead of shrinking;
 *   card  the open card itself fills the screen, at most 1:1.
 * Between the group and the crew, and the crew and the card, the camera moves
 * with the zoom value, as the desktop's does.
 */
export function phoneCamera(L: Layout, z: number, focus: string | null, w: number, h: number, pan: number): Camera {
  const spots = [...Object.values(L.crew.at), L.crew.next]
  // The workspace's label over the faces is framed with them (crewLabelAt): its
  // left edge sets the scale, and at that scale its words read at caption, as tall as that.
  const minX = Math.min(crewLabelAt(L, true).x, ...spots.map((p) => p.x - FACE_REACH.left))
  const maxX = Math.max(...spots.map((p) => p.x)) + FACE_REACH.right
  const S1 = Math.min(1, (w - PHONE_MARGIN * 2) / (maxX - minX))
  const label = crewLabelAt(L, true, Math.max(1, 1 / S1))
  const minY = Math.min(label.y, ...spots.map((p) => p.y - FACE_REACH.top))
  const maxY = Math.max(...spots.map((p) => p.y)) + FACE_REACH.bottom
  const panMax = Math.max(0, (maxY - minY) * S1 - (h - PHONE_BAR - PHONE_MARGIN * 2))
  const p = Math.min(Math.max(pan, 0), panMax)
  const crew = {
    S: S1,
    Ox: w / 2 - ((minX + maxX) / 2) * S1,
    Oy: panMax > 0 ? PHONE_MARGIN - minY * S1 - p : (h - PHONE_BAR) / 2 - ((minY + maxY) / 2) * S1
  }
  if (z <= 1) {
    const S0 = fitScale(GROUP_BOX, w, h)
    return { ...lerpCam({ S: S0, Ox: w / 2, Oy: h / 2 - GROUP_BOX.cy * S0 }, crew, ease(clamp01(z))), panMax }
  }
  return { ...lerpCam(crew, cardCam(L, focus, w, h, PHONE_MARGIN, CARD_MAX), ease(clamp01(z - 1))), panMax }
}

/**
 * THE THUMBNAILS ON A DESKTOP (owner, 2026-11-02: every artifact, scrolled up
 * and down, not the first twelve). The camera frames the shelf and the first
 * DESK_THUMB_ROWS rows as it framed the twelve before; a taller grid keeps
 * that scale and scrolls (pan, from its top), its end above the stop bar.
 */
const DESK_THUMB_ROWS = 4
export function deskThumbs(T: Layout['thumbs'], w: number, h: number, pan: number): Camera {
  const { box } = T
  const viewH = 520 + (DESK_THUMB_ROWS - 1) * T.rowH
  const S = fitScale({ ...box, h: Math.min(box.h, viewH) }, w, h)
  const panMax = box.h <= viewH ? 0 : Math.max(0, DESK_MARGIN + box.h * S - (h - DESK_BAR))
  if (panMax === 0) return { S, Ox: w / 2, Oy: h / 2 - box.cy * S, panMax }
  const p = Math.min(Math.max(pan, 0), panMax)
  return { S, Ox: w / 2, Oy: DESK_MARGIN - (box.cy - box.h / 2) * S - p, panMax }
}

/** The thumbnails' camera on this screen, scrolled `pan` px down. */
export const thumbsCamera = (L: Layout, w: number, h: number, narrow: boolean, pan: number): Camera =>
  narrow ? phoneThumbs(L.thumbs.box, w, h, pan) : deskThumbs(L.thumbs, w, h, pan)

/** THE THUMBNAILS ON A PHONE: as the crew, the grid fills the screen's width and a taller grid scrolls (pan, from its top). */
export function phoneThumbs(box: Box, w: number, h: number, pan: number): Camera {
  const S = Math.min(1, (w - PHONE_MARGIN * 2) / box.w)
  const panMax = Math.max(0, box.h * S - (h - PHONE_BAR - PHONE_MARGIN * 2))
  const p = Math.min(Math.max(pan, 0), panMax)
  return { S, Ox: w / 2, Oy: panMax > 0 ? PHONE_MARGIN - (box.cy - box.h / 2) * S - p : (h - PHONE_BAR) / 2 - box.cy * S, panMax }
}

/**
 * EACH STOP'S CAMERA SCALE AT REST, for the words that must read at a size on
 * screen there (scene-words.ts): the crew and the card (the cameras above),
 * the thumbnails, the devices layer at the devices stop (paint: vS at z = -2)
 * and a workspace's mark at the workspaces stop (SWS inside the device's fit).
 */
export function restScales(L: Layout, w: number, h: number, narrow: boolean): RestScales {
  return {
    crew: narrow ? phoneCamera(L, 1, null, w, h, 0).S : deskCamera(L, 1, null, w, h).S,
    card: cardStopCamera(L, null, w, h, narrow).S,
    thumbs: thumbsCamera(L, w, h, narrow, 0).S,
    devices: fitScale(L.devicesBox, w, h),
    marks: SWS * deviceCam(L.device, w, h, narrow).S
  }
}

/** The words of this screen, for the painter: the same layout and size give the same object. */
let wordsMemo: { L: Layout; w: number; h: number; narrow: boolean; words: SceneWords } | null = null
export function wordsOf(L: Layout, w: number, h: number, narrow: boolean): SceneWords {
  const m = wordsMemo
  if (m && m.L === L && m.w === w && m.h === h && m.narrow === narrow) return m.words
  const words = sceneWords(restScales(L, w, h, narrow), narrow)
  wordsMemo = { L, w, h, narrow, words }
  return words
}

