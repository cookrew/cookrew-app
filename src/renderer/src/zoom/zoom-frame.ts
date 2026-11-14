/**
 * ONE FRAME OF THE ZOOM: everything drawn follows from the path value
 * (zoom-path.ts) and the layout (zoom-layout.ts). No React: ZoomView.tsx
 * builds the elements once and this writes only transform and opacity, and
 * only when they change, so a frame touches nothing else.
 *
 * Scene units are around the open workspace's centre. The device layer and
 * the devices layer ride the same camera: the open workspace's mark on the
 * device IS its group, and the device view IS the machine's screen.
 */
import { clamp01, derive, ease, lerp, ramp, type ZoomDir } from './zoom-path'
import { crewOf, deviceOf, fitScale, machineFrameOf, machinesAt, screenFit, shelfPage, stackOf, thumbsOf, DECK_POSE, SHELF_FACE, type Box, type Pos, NEW_POSE } from './zoom-layout'
import { near, pinned, SCENE_CSS, SCENE_TYPE, sceneWords, SHELF_NAME_S, UNDER_FACE, type RestScales, type SceneWords } from './scene-words'
import { fullPoses } from './full-poses'
/* The cameras, the card stop's label and the words' scales: zoom-camera.ts. */
export * from './zoom-camera'
import { GROUP_BOX, SWS, boxAt, type DeviceWords, cardStopLabel, crewLabelAt, deskCamera, deviceCam, deviceWords, keepOnScreen, phoneCamera, phoneThumbs, thumbsCamera, wordsOf, type Layout } from './zoom-camera'

export interface AgentModel {
  id: string
  name: string
  preset: string
  orch: boolean
  waiting: boolean
}
export interface ItemModel {
  id: string
  kind: 'browser' | 'note'
  owners: readonly string[]
}
export interface LinkModel {
  key: string
  agent: string
  item: string
  /** Its place among the agent's items, and among the item's agents. */
  k: number
  j: number
}
export interface TieModel {
  key: string
  a: string
  b: string
}
export interface FrameModel {
  agents: readonly AgentModel[]
  items: readonly ItemModel[]
  links: readonly LinkModel[]
  ties: readonly TieModel[]
  workspaces: readonly string[]
  /** How many machines the account lists besides this one: they sit under its screen. */
  otherMachines: number
  /** This machine's display, width over height (zoom-layout.ts · screenAspectOf); absent, a 16:10. */
  screenAspect?: number
  active: string
  /** The newest browser's link: at group zoom it stands beside the stack. */
  newest: string | null
  /** Agents per row, as the owner picked them (crew-cols.ts); absent, the form factor's default. */
  crewCols?: number
  /** Workspaces per row on the device, as the owner picked them (crew-cols.ts); absent, the form factor's default. */
  deviceCols?: number
}

type Put = HTMLElement & { _t?: string; _o?: number; _l?: number; _h?: string; _d?: number }
export interface AgentEls {
  node: Put
  cardl: Put
  card: Put
  av: Put
  nm: Put
  st: Put
  cnt: Put
  /** The words it has typed unsent, under its counts (ZoomParts · AgentNode); null where not mounted. */
  dft: Put | null
  /** The card's own parts, mounted for the open card only (ZoomView · cardIds): null elsewhere. */
  body: Put | null
  reply: Put | null
  emp: Put | null
  dot: Put | null
  nmW: number
  stW: number
  cntW: number
  /** Their heights: a word drawn larger on a phone keeps its top (scene-words.ts). */
  nmH?: number
  stH?: number
}
export interface FrameEls {
  devices: Put
  device: Put
  scene: Put
  panel: Put
  wash: Put
  label: Put
  labelW: number
  labelH: number
  newCap: Put
  agents: Map<string, AgentEls>
  links: Map<string, { node: Put; th: Put; coin: Put; badge: Put | null }>
  items: Map<string, { node: Put; ttl: Put }>
  ties: Map<string, Put>
  /** The fold's faces round a hovered agent, one drawing under the ties (ZoomView · .zv-fold); absent where nothing draws them. */
  fold?: Put | null
  /** The crew's light at rest, under the fold's (ZoomView · .zv-glow). */
  glow?: Put | null
  marks: Map<string, Put>
  /** The machine's title over its marks (ZoomView · .zv-device-label). */
  deviceLabel?: Put | null
  /** The tiles' words and the machines' names: drawn at one size on a phone (paintDeviceWords). */
  markLabels?: Put[]
  machineWords?: Put[]
  /** The share button among those words: a control, so it keeps a thumb's size (paintDeviceWords). */
  /** The empty seat at the end of the crew: the way a new agent is made. */
  next: Put | null
  /** An item's full-view head, crisp (ZoomView · zv-fv-ghost): the page's words arrive in it, never blown up. */
  fullHead?: Put | null
  /** The newest browser beside the stack when no coin carries it (ZoomView · NewestThumb). */
  newThumb?: Put | null
  /** The shelf's "+N" chip, which turns its page (ZoomView). */
  shelfMore?: Put | null
  machine: Put
}

export interface FrameState {
  dir: ZoomDir
  sv: number
  focus: string | null
  leaving: string | null
  leavingAmt: number
  focusItem: string | null
  w: number
  h: number
  narrow: boolean
  /** How far the crew (a narrow screen) or the thumbnails (any screen) are scrolled down, in px (the cameras clamp it). */
  pan?: number
  /** How far the workspaces' tiles are scrolled down, in px: their own, apart from the crew's (deviceCam clamps it). */
  tilesPan?: number
  /** The page of the shelf over the thumbnails: taps on its "+N" chip, wrapping (zoom-layout.ts · shelfPage). */
  shelf?: number
  /** The agent the pointer rests on, and how far the fold round it has come (0–1, use-zoom-motion eases it). */
  hover?: { id: string; amt: number } | null
  /** How the crew is lit at rest (FoldLight); hover only when absent. */
  light?: FoldLight
  /** An agent's face being dragged at the crew, and how far from where it stands, in px on screen (use-zoom-motion). */
  drag?: { id: string; dx: number; dy: number } | null
}

/**
 * THE FOLD (owner 2026-11-12: "hovering an agent bends the space along its
 * ties, a slight, angled fold; the others move with it, so the agent and its
 * ties stand out in depth"). The hovered agent is a peak, its ties the ridges
 * running down from it, each tied agent part-way up its ridge; between two
 * ridges the ground is one flat face, so the fold creases along the ties.
 * Seen from above in perspective, centred on the peak: what stands higher
 * grows and moves out from it, the far ground sinks a little and draws in.
 */
export interface Fold {
  /** How far a point moves, in the crew's units. */
  readonly dx: number
  readonly dy: number
  /** How much what stands there grows. */
  readonly k: number
  /** How high it stands: the peak 1, a tied agent its ridge, the far ground below 0. */
  readonly h: number
}

/** Heights: the peak, a tied agent on its ridge, and the ground the fold sinks to. */
/** How near a dragged face must come to another's place for a drop to swap them, in the crew's units. */
const DROP_REACH = 56

export const FOLD = { peak: 1, ridge: 0.55, ground: -0.3, depth: 0.16, reach: 260 } as const

/** The fold's height at p: on the face between the two ridges p lies between, or a cone where no two close round it. */
export function foldHeight(p: Pos, peak: Pos, ridges: readonly Pos[]): number {
  const vx = p.x - peak.x
  const vy = p.y - peak.y
  const far = Math.hypot(vx, vy)
  if (far < 1e-6) return FOLD.peak
  const spokes = ridges
    .map((r) => ({ r, ang: Math.atan2(r.y - peak.y, r.x - peak.x), len: Math.hypot(r.x - peak.x, r.y - peak.y) }))
    .filter((q) => q.len > 1)
    .sort((m, n) => m.ang - n.ang)
  const reach = spokes.length ? spokes.reduce((t, q) => t + q.len, 0) / spokes.length : FOLD.reach
  const cone = FOLD.peak - ((FOLD.peak - FOLD.ridge) * far) / reach
  if (spokes.length < 2) return Math.max(FOLD.ground, cone)
  const ang = Math.atan2(vy, vx)
  // The two ridges either side of p, going round.
  const next = spokes.findIndex((q) => q.ang > ang)
  const one = spokes[next <= 0 ? spokes.length - 1 : next - 1]
  const two = spokes[next === -1 ? 0 : next]
  const gap = (two.ang - one.ang + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI
  // A face wider than a half turn is the fold's open side: a cone there, not a plane run off to the sky.
  if (gap >= Math.PI - 0.05) return Math.max(FOLD.ground, cone)
  // The plane through the peak and the two ridges' agents: z = peak + g·(p − peak), with g·r1 = g·r2 = ridge − peak.
  const ax = one.r.x - peak.x
  const ay = one.r.y - peak.y
  const bx = two.r.x - peak.x
  const by = two.r.y - peak.y
  const det = ax * by - ay * bx
  if (Math.abs(det) < 1e-6) return Math.max(FOLD.ground, cone)
  const drop = FOLD.ridge - FOLD.peak
  const gx = (drop * by - drop * ay) / det
  const gy = (ax * drop - bx * drop) / det
  return Math.max(FOLD.ground, FOLD.peak + gx * vx + gy * vy)
}

/** Where the fold carries a point, and how much it grows there, seen from above the peak. */
export function foldAt(p: Pos, peak: Pos, ridges: readonly Pos[]): Fold {
  const h = foldHeight(p, peak, ridges)
  const k = 1 / (1 - FOLD.depth * h)
  return { dx: (p.x - peak.x) * (k - 1), dy: (p.y - peak.y) * (k - 1), k, h }
}

/**
 * THE FOLD'S FACES, IN LIGHT (owner 2026-11-12: "imagine a space of more
 * dimensions: the light on these prism faces shows it"; then "the same colour
 * as the ground, no colours"). The faces the fold raises round the hovered
 * agent, where the agents now stand: one between each two of its ties that
 * close an angle, and a narrow one on a tie's open side, so every ridge has a
 * face either way. Each face turns its own way in depth, so each catches its
 * own light, and its light is all its colour (foldFacesSvg).
 */
export interface FoldFace {
  readonly pts: readonly [Pos, Pos, Pos]
  /** How squarely it faces the light: 0 to 1. */
  readonly light: number
}

/** The fold's height in px, to turn heights into slopes; and where the light comes from (top left, in front). */
const FACE_DEPTH = 140
const LIGHT_3D = (() => {
  const v = [-0.5, -0.7, 0.6]
  const n = Math.hypot(v[0], v[1], v[2])
  return v.map((c) => c / n)
})()

/** A face through three points at their heights, lit by the way it turns (see foldFaces). */
function litFace(p0: Pos, z0: number, p1: Pos, z1: number, p2: Pos, z2: number): FoldFace {
  const u = [p1.x - p0.x, p1.y - p0.y, (z1 - z0) * FACE_DEPTH]
  const v = [p2.x - p0.x, p2.y - p0.y, (z2 - z0) * FACE_DEPTH]
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const m = Math.hypot(n[0], n[1], n[2]) || 1
  n = n.map((c) => c / m)
  if (n[2] < 0) n = n.map((c) => -c)
  const light = Math.max(0, n[0] * LIGHT_3D[0] + n[1] * LIGHT_3D[1] + n[2] * LIGHT_3D[2])
  return { pts: [p0, p1, p2], light: Math.round(light * 100) / 100 }
}

export function foldFaces(peak: Pos, ridges: readonly Pos[]): FoldFace[] {
  const spokes = ridges
    .map((r) => ({ r, ang: Math.atan2(r.y - peak.y, r.x - peak.x), len: Math.hypot(r.x - peak.x, r.y - peak.y) }))
    .filter((q) => q.len > 1)
    .sort((m, n) => m.ang - n.ang)
  const out: FoldFace[] = []
  const face = (p0: Pos, z0: number, p1: Pos, z1: number, p2: Pos, z2: number): void => void out.push(litFace(p0, z0, p1, z1, p2, z2))
  const sliver = (s: (typeof spokes)[number], side: 1 | -1): void => {
    const w = Math.min(46, Math.max(14, s.len * 0.22))
    const normal = s.ang + (side * Math.PI) / 2
    const tip = { x: (peak.x + s.r.x) / 2 + w * Math.cos(normal), y: (peak.y + s.r.y) / 2 + w * Math.sin(normal) }
    face(peak, FOLD.peak, s.r, FOLD.ridge, tip, (FOLD.peak + FOLD.ridge) / 2 - 0.35)
  }
  if (spokes.length === 1) {
    sliver(spokes[0], 1)
    sliver(spokes[0], -1)
    return out
  }
  spokes.forEach((one, i) => {
    const two = spokes[(i + 1) % spokes.length]
    const gap = (two.ang - one.ang + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI
    if (gap < Math.PI - 0.05) face(peak, FOLD.peak, one.r, FOLD.ridge, two.r, FOLD.ridge)
    else {
      sliver(one, 1)
      sliver(two, -1)
    }
  })
  return out
}

/**
 * THE CREW AS ONE TERRAIN (owner 2026-11-12, to compare with every agent its
 * own peak): one space for the whole crew, each agent as high as it has ties
 * (a hub is a peak), and in each angle two of an agent's ties close a face out
 * to their middles, so the faces from a tie's two ends meet on it. Lit as the
 * fold's faces are, so its light and shade show the crew's shape.
 */
export function terrainFaces(at: Readonly<Record<string, Pos>>, ties: readonly { a: string; b: string }[]): FoldFace[] {
  const near = new Map<string, string[]>()
  for (const t of ties) {
    if (t.a === t.b || !at[t.a] || !at[t.b]) continue
    near.set(t.a, [...(near.get(t.a) ?? []), t.b])
    near.set(t.b, [...(near.get(t.b) ?? []), t.a])
  }
  const top = Math.max(1, ...[...near.values()].map((n) => n.length))
  const z = (id: string): number => (near.get(id)?.length ?? 0) / top
  const out: FoldFace[] = []
  for (const [id, list] of near) {
    if (list.length < 2) continue
    const p = at[id]
    const spokes = list.map((n) => ({ id: n, r: at[n], ang: Math.atan2(at[n].y - p.y, at[n].x - p.x) })).sort((m, n) => m.ang - n.ang)
    spokes.forEach((one, i) => {
      const two = spokes[(i + 1) % spokes.length]
      const gap = (two.ang - one.ang + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI
      if (gap >= Math.PI - 0.05) return
      const h1 = { x: (p.x + one.r.x) / 2, y: (p.y + one.r.y) / 2 }
      const h2 = { x: (p.x + two.r.x) / 2, y: (p.y + two.r.y) / 2 }
      out.push(litFace(p, z(id), h1, (z(id) + z(one.id)) / 2 - 0.15, h2, (z(id) + z(two.id)) / 2 - 0.15))
    })
  }
  return out
}

/** How the crew is lit at rest: only the hovered agent's fold, every agent its own peak, or one terrain. */
export type FoldLight = 'hover' | 'every' | 'terrain'
/** How strong the light at rest is, under a hovered fold's. */
const AT_REST: Readonly<Record<Exclude<FoldLight, 'hover'>, number>> = { every: 0.55, terrain: 0.85 }

const c1 = (n: number): string => n.toFixed(1)

/** How a face lying flat is lit (LIGHT_3D's height): the paper's own tone, neither lighter nor darker. */
const FLAT_LIGHT = LIGHT_3D[2]

/**
 * The faces as a drawing, in the page's own paper (owner 2026-11-12: "the
 * same colour as the ground, no colours"): a face turned to the light is the
 * paper a little lighter, one turned away a little darker, one lying flat the
 * paper itself, each strongest at its peak and gone into the paper at its rim.
 * Folded paper: depth from light and shade alone.
 */
export function foldFacesSvg(faces: readonly FoldFace[], prefix = 'zv-fold'): string {
  let defs = ''
  let body = ''
  faces.forEach((f, i) => {
    const [p0, p1, p2] = f.pts
    const rim = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const tone = Math.max(-1, Math.min(1, (f.light - FLAT_LIGHT) * 2.4))
    const toward = tone >= 0 ? '#fff' : '#000'
    const share = Math.round(Math.abs(tone) * (tone >= 0 ? 55 : 35))
    const color = `color-mix(in srgb, var(--zv-paper, var(--sumi-paper, #f4efe4)) ${100 - share}%, ${toward} ${share}%)`
    const stop = (at: string, alpha: number): string => `<stop offset="${at}" style="stop-color:${color};stop-opacity:calc(${alpha.toFixed(2)} * var(--zv-fold-a, 1))"/>`
    defs += `<linearGradient id="${prefix}-${i}" gradientUnits="userSpaceOnUse" x1="${c1(p0.x)}" y1="${c1(p0.y)}" x2="${c1(rim.x)}" y2="${c1(rim.y)}">${stop('0', 0.9)}${stop('.6', 0.55)}${stop('1', 0.1)}</linearGradient>`
    body += `<path d="M${c1(p0.x)} ${c1(p0.y)}L${c1(p1.x)} ${c1(p1.y)}L${c1(p2.x)} ${c1(p2.y)}Z" fill="url(#${prefix}-${i})"/>`
  })
  return faces.length ? `<defs>${defs}</defs>${body}` : ''
}

/** What the view reports after a frame: how opaque it still is (it hands over to the real full view), and the scene's scale. */
export interface FrameOut {
  cover: number
  scale: number
  /** How far the crew (a narrow screen) or the thumbnails can scroll, in px: 0 when they fit. */
  panMax: number
  /** How far the workspaces' tiles can scroll, in px: 0 when they fit. */
  tilesMax: number
  /** The agent a dragged face is over, which a drop swaps it with (crew-slots.ts); null when none. */
  dropOn: string | null
}

const f1 = (n: number): string => n.toFixed(1)
const f4 = (n: number): string => n.toFixed(4)

export function put(el: Put | null | undefined, transform: string | null, opacity?: number): void {
  if (!el) return
  if (transform !== null && el._t !== transform) {
    el.style.transform = transform
    el._t = transform
  }
  const o = opacity === undefined ? 1 : Math.round(opacity * 1000) / 1000
  if (el._o !== o) {
    el.style.opacity = String(o)
    el._o = o
    // What cannot be seen cannot be pressed, nor painted. Every part rides a
    // layer of its own (will-change), and a layer at opacity 0 keeps its tiles:
    // with enough of them Chromium runs out of tile memory and leaves holes in
    // the parts that ARE shown (owner's screenshots, 2026-11-01). Hidden, a
    // part draws nothing; its layer stays, so showing it again is one raster.
    el.style.pointerEvents = o < 0.05 ? 'none' : ''
    el.style.visibility = o === 0 ? 'hidden' : ''
  }
}

/**
 * How much of a picture's words show (its thumbnails' titles, lines, hosts):
 * --zv-wo on the picture, read by phone-type.css. Written only when it changes.
 */
export function wordsSeen(el: (HTMLElement & { _w?: string }) | null | undefined, seen: number): void {
  if (!el) return
  const v = (Math.round(seen * 100) / 100).toString()
  if (el._w === v) return
  el._w = v
  el.style.setProperty('--zv-wo', v)
}

/**
 * THE DEVICE LAYERS' WORDS (scene-words.ts): the machine's title over its
 * tiles, the tiles' words and the machines' names. A desk scales them once
 * with the tile; a phone draws each at its size on screen on every frame, and
 * those that would stand over the next tile (toward the devices) fade.
 */
function paintDeviceWords(L: Layout, els: FrameEls, d: { live: boolean; zIn: number; dS: number; vS: number; camD: number; camDD: number; dw: DeviceWords; shown: number }): void {
  const back = d.live ? d.camD / d.dS : 1
  const seen = d.live ? ramp(d.zIn, -1.5, -1.15) : 1
  // On a phone it stands in the head over the grid, beside the per-row pill, whatever the camera's scale.
  const titleY = d.live ? L.device.gridTop - TITLE_LIFT_PX / d.camD : L.device.titleBottom
  put(els.deviceLabel, `translate(${f1(L.device.left)}px, ${f1(titleY)}px) scale(${f4(d.dw.titleK * back)}) translateY(-100%)`, seen)
  // Past the tiles the layer is gone: nothing to write on a frame nobody sees.
  if (d.shown > 0) for (const word of els.markLabels ?? []) put(word, `scale(${f4(d.dw.markK * back)})`, seen)
  // The words shrink with the machine they name; a thumb does not. Scaled back to 1:1 on screen.
  if (!d.live) return
  for (const word of els.machineWords ?? []) put(word, `scale(${f4(d.camDD / d.vS)})`)
}
/** The title's foot over the first row of tiles on a phone, in px: centred on the per-row pill (zoom.css · .zv-cols). */
const TITLE_LIFT_PX = 12

/** Between these zooms the tile has left (the device layer's fade, paint): what it stood for comes only then, or two sets of words stand on each other. */
const TILE_GONE = [-0.3, -0.05] as const

/** A coin's width and its count badge's type (zoom.css · .zv-coin, .zv-badge). */
const COIN_PX = 22
const BADGE_PX = 8

/** The machine's screen holds the device view at this scale: one frame for every machine (zoom-layout.ts · machineFrameOf). */
const screenKOf = (device: Layout['device'], narrow: boolean): number => screenFit(device, machineFrameOf(device, narrow))
const WASH = { w: 1200, h: 540 }


export function layoutOf(model: FrameModel, narrow: boolean): Layout {
  // A tree under the leads, by the cables between agents (zoom-layout.ts · crewRows).
  const crew = crewOf(model.agents, narrow, model.crewCols, model.ties)
  const device = deviceOf(model.workspaces, narrow, model.screenAspect, model.deviceCols)
  // Every machine of the account in one row, this one first, each the one frame: the devices stop frames them all (zoom-layout.ts · machinesAt).
  const machines = machinesAt(model.otherMachines, machineFrameOf(device, narrow), narrow)
  return {
    stack: stackOf(model.agents),
    crew,
    cardBox: { ...crew.box, w: crew.box.w + 240, h: crew.box.h + 252, cy: crew.box.cy + 60 },
    thumbs: thumbsOf(model.items, model.agents, narrow),
    device,
    devicesBox: machines.box
  }
}

/** A coin docks under an item whose slot is on screen or this near it, in px (paint · the links). */
const COIN_ROOM = 160
/** The camera box at agent zoom z ≥ 0. */

export function paint(model: FrameModel, L: Layout, els: FrameEls, st: FrameState): FrameOut {
  const { z: zIn, P, I } = derive(st.dir, st.sv)
  const z = Math.max(0, zIn)
  const pc = ease(P)
  const iz = ease(I)
  const { w, h } = st
  const fit = (b: Box): number => fitScale(b, w, h)

  // ── the camera: agent framing, the device dive below 0, the pivot to the thumbs ──
  const bA = boxAt(L, z)
  const cam = st.narrow ? phoneCamera(L, z, st.focus, w, h, st.pan ?? 0) : deskCamera(L, z, st.focus, w, h)
  let aS = cam.S
  let aOx = cam.Ox
  let aOy = cam.Oy
  let panMax = cam.panMax
  const slot: Pos = L.device.at[model.active] ?? { x: 0, y: 0 }
  const dc = deviceCam(L.device, w, h, st.narrow, st.tilesPan ?? 0)
  const screenK = screenKOf(L.device, st.narrow)
  const camD = dc.S
  let dS: number
  let dOx: number
  let dOy: number
  if (zIn < -1) {
    // From all devices into the machine's screen: its centre holds the device view's centre.
    const k = ease(zIn + 2)
    const camDD = fit(L.devicesBox)
    const s0 = camDD * screenK
    dS = Math.exp(lerp(Math.log(s0), Math.log(camD), k))
    // The row's centre at the view's, this machine's screen at the view's centre once inside it.
    dOx = lerp(w / 2 - camDD * L.devicesBox.cx, w / 2, k)
    dOy = lerp(h / 2 - camDD * L.devicesBox.cy - s0 * L.device.box.cy, dc.Oy, k)
    aS = dS * SWS
    aOx = dOx + dS * slot.x
    aOy = dOy + dS * slot.y
  } else {
    if (zIn < 0) {
      const k = ease(zIn + 1)
      aS = Math.exp(lerp(Math.log(camD * SWS), Math.log(aS), k))
      aOx = lerp(w / 2 + camD * slot.x, aOx, k)
      aOy = lerp(dc.Oy + camD * slot.y, aOy, k)
    }
    dS = aS / SWS
    dOx = aOx - dS * slot.x
    dOy = aOy - dS * slot.y
  }
  const pk = ease(ramp(P, 0.15, 0.9))
  const tc = thumbsCamera(L, w, h, st.narrow, st.pan ?? 0)
  const iS = tc.S
  const iOy = tc.Oy
  panMax = lerp(panMax, tc.panMax, pk)
  const S = lerp(aS, iS, pk)
  const Ox = lerp(aOx, w / 2, pk)
  const Oy = lerp(aOy, iOy, pk)
  put(els.scene, `translate(${f1(Ox)}px, ${f1(Oy)}px) scale(${f4(S)})`)
  const deviceSeen = (1 - ramp(zIn, -0.4, -0.05)) * (1 - pc)
  put(els.device, `translate(${f1(dOx)}px, ${f1(dOy)}px) scale(${f4(dS)})`, deviceSeen)
  // Out at the devices the tiles are a picture on the machine's screen: the doors must not take its click.
  const doors = zIn < -1.05 || deviceSeen < 0.05 ? 'none' : ''
  if (els.device.style.pointerEvents !== doors) els.device.style.pointerEvents = doors
  const vS = dS / screenK
  put(els.devices, `translate(${f1(dOx)}px, ${f1(dOy + dS * L.device.box.cy)}px) scale(${f4(vS)})`, (1 - ramp(zIn, -1.4, -1.05)) * (1 - pc))
  put(els.machine, null, 1)
  // A phone draws every word at one size on screen, whatever the camera does this frame (scene-words.ts).
  const sw = wordsOf(L, w, h, st.narrow)
  const live = sw.live
  paintDeviceWords(L, els, { live, zIn, dS, vS, camD, camDD: fit(L.devicesBox), dw: deviceWords(L.device, w, h, st.narrow), shown: deviceSeen })

  // ── the wash: the workspace's own ground ──
  // At the workspaces stop its tile is its ground and its name: the group's own come as the tile goes.
  const inTile = ramp(zIn, -0.6, TILE_GONE[1])
  const wb = zIn < 0 ? GROUP_BOX : bA
  // A grid that scrolls has the screenful under it, not a sheet as tall as the grid: the grid slides over it.
  const tb: Box = tc.panMax > 0 ? { w: L.thumbs.box.w, h: h / iS, cy: (h / 2 - iOy) / iS } : L.thumbs.box
  const wsx = lerp(lerp(0.2, wb.w / WASH.w, ease(z)), tb.w / WASH.w, pc)
  const wsy = lerp(lerp(0.42, wb.h / WASH.h, ease(z)), tb.h / WASH.h, pc)
  // The ground lies over the sheet now (the sheet is under the scene): it goes as a full view comes.
  const sheetIn = st.dir === 'agents' ? ramp(z, 2, 2.4) : ramp(I, 0, 0.4)
  put(els.wash, `translate(0px, ${f1(lerp(lerp(-10, wb.cy, ease(z)), tb.cy, pc))}px) scale(${f4(wsx)}, ${f4(wsy)})`, lerp(0.6, 0.55, ease(z)) * (1 - sheetIn) * inTile)

  // ── the agents ──
  // The open card's words are set for the card stop's scale (phone-type.css · --zv-k-card): drawn at kc / S they read the same on every frame.
  const kc = sw.rest.card
  const cardK = live ? kc / S : 1
  const gone = 1 - ramp(P, 0, 0.25)
  const cardAmt = (id: string): number => (id === st.focus ? clamp01(z - 1) : id === st.leaving ? st.leavingAmt : 0)
  const zOf = (id: string): number => (z <= 1 ? z : 1 + cardAmt(id))
  const agentAt: Record<string, Pos & { s: number }> = {}
  const zm: Record<string, number> = {}
  const toFull = ease(ramp(z, 2, 2.85))
  // INTO THE FULL VIEW (draft · full()): no part fades into an empty sheet;
  // each goes where the full view draws it (full-poses.ts). `into` is how far.
  const into = st.dir === 'agents' && st.focus !== null ? ease(ramp(z, 2, 2.75)) : 0
  const FV = fullPoses(w, h, st.narrow)
  /** A spot on screen, in the scene's units, relative to (x, y) in it. */
  const local = (X: number, Y: number, x = 0, y = 0): Pos => ({ x: (X - Ox) / S - x, y: (Y - Oy) / S - y })
  const others = model.agents.filter((a) => a.id !== st.focus)
  const dockAt = new Map(others.map((a, k) => [a.id, k] as const))
  // A phone's head is the bar's, above this view: the face and words are seen rising to it, gone just as the real view arrives.
  const headOut = FV.headFades ? 1 - ramp(z, 2.6, 2.86) : 1
  // The shelf's page: the faces it shows, and where the others wait (behind its "+N" chip).
  const shelf = shelfPage(L.thumbs.shelf, st.shelf ?? 0)
  // THE FOLD round the hovered agent (foldAt): at the crew only, never on the way to a card, the
  // thumbnails or the full view. Reckoned on the crew's own places, so nothing it moves moves it.
  // A DRAGGED FACE (crew-slots.ts): it stands where the pointer has taken it, and the fold is worked
  // out from there, so its prism changes under the hand; over another agent, a drop swaps them.
  const drag = st.drag && L.crew.at[st.drag.id] && z > 0.8 && z < 1.2 ? st.drag : null
  const rest: Record<string, Pos> = drag
    ? { ...L.crew.at, [drag.id]: { x: L.crew.at[drag.id].x + drag.dx / S, y: L.crew.at[drag.id].y + drag.dy / S } }
    : L.crew.at
  let dropOn: string | null = null
  if (drag) {
    const p = rest[drag.id]
    let best = DROP_REACH
    for (const [id, q] of Object.entries(L.crew.at)) {
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (id !== drag.id && d < best) {
        best = d
        dropOn = id
      }
    }
  }
  const hov = st.hover && st.hover.amt > 0.001 && rest[st.hover.id] ? st.hover : null
  const fw = hov ? hov.amt * ramp(z, 0.8, 0.98) * (1 - ramp(z, 1.05, 1.3)) * (1 - pc) : 0
  const peak = hov ? rest[hov.id] : null
  const onFold = new Set<string>(hov ? model.ties.flatMap((t) => (t.a === hov.id ? [t.b] : t.b === hov.id ? [t.a] : [])) : [])
  const ridges = [...onFold].flatMap((id) => rest[id] ?? [])
  model.agents.forEach((a, i) => {
    const e = els.agents.get(a.id)
    if (!e) return
    const zi = zOf(a.id)
    zm[a.id] = zi
    const far = L.stack[a.id] ?? { x: 0, y: 0, s: 0.84, r: 0 }
    const mid = rest[a.id] ?? { x: 0, y: 0 }
    const t = ease(ramp(z, Math.min(i, 6) * 0.03, 0.8 + Math.min(i, 6) * 0.03))
    let x = lerp(far.x, mid.x, t)
    let y = lerp(far.y, mid.y, t)
    let s = lerp(far.s, 1, t) * lerp(1, 0.62, ease(clamp01(zi - 1)))
    const r = lerp(far.r, 0, t)
    // The fold carries the agent where its place on the crew lies, and grows it as it stands higher;
    // one neither hovered nor tied to it steps back.
    let lift = 0
    if (fw > 0 && peak) {
      const fold = foldAt(mid, peak, ridges)
      x += fw * fold.dx
      y += fw * fold.dy
      s *= 1 + fw * (fold.k - 1)
      lift = Math.max(0, fold.h) * fw
    }
    // In the hand: a little larger, and off the page.
    if (drag && a.id === drag.id) {
      s *= 1.06
      lift = 1
    }
    const back = fw > 0 && hov && a.id !== hov.id && !onFold.has(a.id) ? 1 - 0.45 * fw : 1
    // To the shelf as the thumbs unfold.
    const shown = a.id in shelf.x
    const sh = { x: shown ? shelf.x[a.id] : shelf.more?.x ?? 0, y: L.thumbs.shelf.y }
    const pm = ease(ramp(P, 0.02 * Math.min(i, 8), 0.44 + 0.02 * Math.min(i, 8)))
    // Off this page an agent goes into the "+N" chip and fades (a tap on the chip brings it).
    const onShelf = lerp(1, shown ? 1 : 0, pm)
    x = lerp(x, sh.x, pm)
    y = lerp(y, sh.y, pm)
    s = lerp(s, 0.5, pm)
    agentAt[a.id] = { x, y, s }
    const focused = a.id === st.focus
    // Into the full view: the open card's face goes to the head; the others
    // dock as the troop beside the sheet (a phone: in the row at its top).
    const dock = !focused && into > 0 ? FV.dock(dockAt.get(a.id) ?? 0, others.length) : null
    const dockP = dock ? local(dock.x, dock.y) : null
    // The troop gathers quicker than the head settles: by the time the sheet is up, it is docked.
    const docked = ease(ramp(z, 2, 2.5))
    const nodeX = dockP ? lerp(x, dockP.x, docked) : x
    const nodeY = dockP ? lerp(y, dockP.y, docked) : y
    put(e.node, `translate(${f1(nodeX)}px, ${f1(nodeY)}px)`, (dock ? lerp(1, dock.o, ramp(docked, 0, 0.6)) : 1) * onShelf * back)
    const avAt = focused && into > 0 ? local(FV.avatar.x, FV.avatar.y, x, y) : { x: 0, y: 0 }
    const avS = focused ? lerp(s, FV.avatar.size / (64 * S), into) : dock ? lerp(s, dock.size / (64 * S), docked) : s
    const avMove = focused && into > 0 ? `translate(${f1(avAt.x * into)}px, ${f1(avAt.y * into)}px) ` : ''
    put(e.av, `${avMove}rotate(${r.toFixed(2)}deg) scale(${f4(avS)})`, ramp(zIn, -1, -0.6) * (1 - ramp(iz * pc, 0, 0.35)) * (focused ? headOut : 1))
    // What the fold lifts casts its shadow on the page below it (zoom.css · .zv-av, --zv-lift).
    const raised = Math.round(lift * 20) / 20
    if (e.av._l !== raised) {
      e.av.style.setProperty('--zv-lift', String(raised))
      e.av._l = raised
    }
    // The face a dragged one is over is ringed: a drop there swaps them.
    const target = a.id === dropOn ? 1 : 0
    if (e.av._d !== target) {
      e.av.style.setProperty('--zv-drop', String(target))
      e.av._d = target
    }
    const cBase = ramp(zi, 1.3, 1.85) * gone
    const ce = ease(cBase)
    put(e.cardl, `translate(${f1(x)}px, ${f1(y)}px)`, focused ? 1 - ramp(z, 2.04, 2.14) : 1 - ramp(z, 2, 2.3))
    put(e.card, `scale(${f4(lerp(64 / 260, 1, ce) * lerp(1, 0.5, pm))}, ${f4(lerp(64 / 244, 1, ce) * lerp(1, 0.5, pm))})`, cBase)
    const n = zi <= 1 ? 0 : zi - 1
    const nx = ease(ramp(n, 0, 0.6))
    const ny = ease(ramp(n, 0.4, 1))
    const nmIn = ramp(z, 0.5, 0.95)
    // A phone's name never pops in at a smaller size: it fades in at its own.
    const pop = live ? 1 : lerp(0.7, 1, nmIn)
    // The open card's words travel to the head; the others' fade as they dock.
    const words = focused ? headOut : 1 - ramp(z, 2, 2.2)
    // The words' factors: on a phone their size on screen over this frame's camera, the same at
    // the crew, on the card, on the way between and on the shelf; 1 on a desk.
    const fN = live ? pinned(SCENE_TYPE.name, SCENE_CSS.name, S) : 1
    const fS = live ? pinned(SCENE_TYPE.small, SCENE_CSS.small, S) : 1
    // Drawn at f about its centre, a word keeps the top (and, in the card's head, the left) it has at 1.
    const grow = (f: number, s0: number, wd: number, ht: number, left: number): { dx: number; dy: number } => ({ dx: left * (wd / 2) * s0 * (f - 1), dy: (ht / 2) * s0 * (f - 1) })
    const U = UNDER_FACE
    const stTop = U.nameTop + U.toStatus * fN
    // THE CREW SHOWS NO STATE WORD (owner, 2026-11-03: "the agents page needs no done / idle under
    // them"): the face's ink says it. The word shows in the open card's head and the full view's;
    // under a face, the counts take its line.
    const cntTop = stTop
    const nA = { x: lerp(-e.nmW / 2, 30, nx), y: lerp(U.nameTop, -24, ny) + (1 - nmIn) * -14, s: pop, o: nmIn * words }
    // The troop's faces carry no names: a face's title says who it is (ZoomParts · AgentNode).
    const nB = { x: -e.nmW / 2, y: 22, s: SHELF_NAME_S, o: 0 }
    // On a phone the name keeps its size onto the shelf too, where it fades.
    const ns = live ? 1 : lerp(nA.s, nB.s, pm)
    const ng = grow(fN, ns, e.nmW, e.nmH ?? 18, nx)
    const nm = { x: lerp(nA.x, nB.x, pm) + ng.dx, y: lerp(nA.y, nB.y, pm) + ng.dy, k: ns * fN }
    if (focused && into > 0) {
      // Scaled about its centre: the head's top-left is where its corner lands.
      const k = FV.name.px / (15 * S)
      const at = local(FV.name.x, FV.name.y, x, y)
      nm.x = lerp(nm.x, at.x - (e.nmW / 2) * (1 - k), into)
      nm.y = lerp(nm.y, at.y - ((e.nmH ?? 18) / 2) * (1 - k), into)
      nm.k = lerp(nm.k, k, into)
    }
    put(e.nm, `translate(${f1(nm.x)}px, ${f1(nm.y)}px) scale(${nm.k.toFixed(3)})`, lerp(nA.o, nB.o, pm))
    const stIn = ramp(z, 0.62, 1)
    const sg = grow(fS, 1, e.stW, e.stH ?? 13, nx)
    const stP = { x: lerp(-e.stW / 2, 30, nx) + sg.dx, y: lerp(stTop, -2, ny) + (1 - stIn) * -18 + sg.dy, k: fS }
    if (focused && into > 0) {
      const at = local(FV.line.x, FV.line.y, x, y)
      const k = live ? fS : 1 / S
      stP.x = lerp(stP.x, at.x - (e.stW / 2) * (1 - k), into)
      stP.y = lerp(stP.y, at.y - ((e.stH ?? 13) / 2) * (1 - k), into)
      stP.k = lerp(stP.k, k, into)
    }
    put(e.st, `translate(${f1(stP.x)}px, ${f1(stP.y)}px)${stP.k === 1 ? '' : ` scale(${f4(stP.k)})`}`, stIn * gone * words * nx)
    const cntIn = ramp(z, 0.62, 0.95)
    // Where the crew has no room for the counts' line, they show in the open card's head only.
    const cntRoom = sw.counts ? 1 : nx
    const cg = grow(fS, 1, e.cntW, 11, nx)
    const cP = { x: lerp(-e.cntW / 2, 30 + (e.stW + 10) * fS, nx) + cg.dx, y: lerp(cntTop, -1, ny) + (1 - cntIn) * -10 + cg.dy, k: fS }
    if (focused && into > 0) {
      const at = local(FV.line.x + e.stW + 10, FV.line.y, x, y)
      const k = live ? fS : 1 / S
      cP.x = lerp(cP.x, at.x - (e.cntW / 2) * (1 - k), into)
      cP.y = lerp(cP.y, at.y - (11 / 2) * (1 - k), into)
      cP.k = lerp(cP.k, k, into)
    }
    put(e.cnt, `translate(${f1(cP.x)}px, ${f1(cP.y)}px)${cP.k === 1 ? '' : ` scale(${f4(cP.k)})`}`, cntIn * gone * words * cntRoom)
    // The typed words: centred by their own CSS (their width moves with every
    // key, the measured ones only with the model), on the counts' line when
    // there are none. The open card's reply box holds them, so they go there.
    const dftTop = e.cntW > 0 && sw.counts ? cntTop + U.toDraft * fS : stTop
    put(e.dft, `translate(0px, ${f1(dftTop + (1 - cntIn) * -10)}px)${fS === 1 ? '' : ` scale(${f4(fS)})`}`, cntIn * gone * words * (1 - nx))
    const b = ramp(zi, 1.6, 1.97)
    // The last words go to the transcript's top, and hand over to it; the
    // reply box goes down to the prompt it becomes.
    const bodyAt = focused && into > 0 ? local(FV.transcript.x, FV.transcript.y, x, y) : null
    const bodyK = live ? cardK : bodyAt ? lerp(1, 1 / S, into) : 1
    // On the card (AgentCard.tsx draws the floating card from the same spot).
    const bodyCard = { x: -18, y: 32 + (1 - b) * 10 }
    const bx = bodyAt ? lerp(bodyCard.x, bodyAt.x, into) : bodyCard.x
    const by = bodyAt ? lerp(bodyCard.y, bodyAt.y, into) : bodyCard.y
    put(e.body, `translate(${f1(bx)}px, ${f1(by)}px)${bodyK === 1 ? '' : ` scale(${f4(bodyK)})`}`, b * gone * (focused ? 1 - ramp(z, 2.88, 2.99) : words))
    put(e.emp, live ? `scale(${f4(cardK)})` : null, ramp(zi, 1.6, 1.97) * gone * (focused ? 1 - toFull : words))
    const replyAt = focused && into > 0 ? local(FV.reply.x, FV.reply.y, x, y) : null
    const rk = live ? cardK : replyAt ? lerp(1, 1 / S, into) : 1
    // .zv-reply sits at (-18, 170), 228x30, scaled about its centre.
    const rMove = replyAt
      ? `translate(${f1(lerp(0, replyAt.x + 18 - 114 * (1 - rk), into))}px, ${f1(lerp(0, replyAt.y - 170 - 15 * (1 - rk), into))}px) scale(${f4(rk)})`
      : live && Math.abs(rk - 1) > 1e-3
        ? `scale(${f4(rk)})`
        : null
    put(e.reply, rMove ?? (e.reply?._t ? 'none' : null), ramp(zi, 1.7, 2) * gone * (focused ? 1 - ramp(z, 2.2, 2.6) : words))
    if (e.dot) {
      const k = ease(ramp(z, 0.15, 0.7))
      const dx = lerp(38, x + 22 * s, k)
      const dy = lerp(-52, y - 22 * s, k)
      // At the workspaces stop the tile's count says who waits.
      put(e.dot, `translate(${f1(dx)}px, ${f1(dy)}px)`, ramp(zIn, TILE_GONE[0], TILE_GONE[1]) * (1 - ramp(iz * pc, 0, 0.35)) * onShelf * (focused ? 1 - toFull : 1 - ramp(z, 2, 2.2)))
    }
  })

  // ── the links: coins in orbit, thumbnails on a card, docked under their item in the thumbs ──
  const linkAt = new Map<string, { x: number; y: number; s: number; grow: number }>()
  const agentLink = (l: LinkModel, zz: number): { x: number; y: number; s: number; o: number; grow: number; th: number; thsx: number; thsy: number; cx: number; cy: number; cs: number } => {
    const p = agentAt[l.agent] ?? { x: 0, y: 0, s: 1 }
    const zi = zz <= 1 ? zz : zm[l.agent] ?? 1
    const a = ((-28 + l.k * 32) * Math.PI) / 180
    const sat = { x: 50 * Math.cos(a), y: 50 * Math.sin(a) }
    const slot = { x: 17 + 79 * l.k, y: 136 }
    const out = ease(clamp01((zz - 0.7 - l.k * 0.05) / 0.25)) * (l.k < 4 ? 1 : 0)
    const grow = ease(ramp(zi, 1.3 + l.k * 0.04, 1.85)) * (l.k < 3 ? 1 : 0)
    let r = {
      x: p.x + lerp(lerp(0, sat.x, out), slot.x, grow),
      y: p.y + lerp(lerp(0, sat.y, out), slot.y, grow),
      s: lerp(0.3, 1, out),
      o: out * (l.k >= 3 ? 1 - ramp(zi, 1.2, 1.5) : 1),
      grow,
      th: ramp(grow, 0, 0.5),
      thsx: lerp(22 / 70, 1, grow),
      thsy: lerp(22 / 46, 1, grow),
      cx: lerp(0, -27, grow),
      cy: lerp(0, -18, grow),
      cs: lerp(1, 0.45, grow)
    }
    if (l.key === model.newest && zz < 0.95) {
      const wN = 1 - ease(ramp(zz, 0.3, 0.95))
      r = {
        ...r,
        x: lerp(r.x, NEW_POSE.x, wN),
        y: lerp(r.y, NEW_POSE.y, wN),
        s: lerp(r.s, NEW_POSE.s, wN),
        o: Math.max(r.o, ramp(wN, 0, 0.05)),
        grow: lerp(r.grow, 1, wN),
        th: lerp(r.th, 1, wN),
        thsx: lerp(r.thsx, 1, wN),
        thsy: lerp(r.thsy, 1, wN),
        cx: lerp(r.cx, -27, wN),
        cy: lerp(r.cy, -18, wN),
        cs: lerp(r.cs, 0.45, wN)
      }
    }
    return r
  }
  const firstLink = new Map<string, LinkModel>()
  for (const l of model.links) if (!firstLink.has(l.item)) firstLink.set(l.item, l)
  for (const l of model.links) {
    const el = els.links.get(l.key)
    if (!el) continue
    const A = agentLink(l, z)
    linkAt.set(l.key, A)
    const first = firstLink.get(l.item) ?? l
    const G = first === l ? A : agentLink(first, z)
    const gs = lerp(0.34, 0.42, G.grow)
    // A coin whose item the grid does not draw, or draws past the screen the
    // thumbs open on, stays with its agent and fades as the thumbs unfold (it
    // would streak off the screen); it is docked when its row is scrolled to.
    const home = L.thumbs.at[l.item] ?? { x: 0, y: 0 }
    const homeY = tc.Oy + (home.y + 46) * iS
    const docks = l.item in L.thumbs.at && homeY > -COIN_ROOM && homeY < h + COIN_ROOM
    const k1 = docks ? ease(ramp(P, 0.06 + l.j * 0.03, 0.46)) : 0
    const k2 = docks ? ease(ramp(P, 0.5, 0.94)) : 0
    const flip = docks ? ease(ramp(P, 0.12 + l.j * 0.03, 0.48)) : 0
    const B = { x: home.x + 84 - 16 - l.j * 21, y: home.y + 46 }
    const x = lerp(lerp(A.x, G.x + 84 * gs - 16 - l.j * 21, k1), B.x, k2)
    const y = lerp(lerp(A.y, G.y + 46 * gs, k1), B.y, k2)
    const focusedAgent = l.agent === st.focus
    // The open card's thumbnails go to the browsers-and-notes column, and hand over to it.
    const cell = focusedAgent && into > 0 && A.grow > 0.5 ? FV.cell(l.k) : null
    const fade = (cell ? cell.o * (1 - ramp(z, 2.88, 2.99)) : focusedAgent ? 1 - toFull : 1 - ramp(z, 2, 2.25)) * (1 - ramp(iz * pc, 0, 0.3))
    const seen = docks ? lerp(A.o, 1, ramp(P, 0, 0.3)) : A.o * (1 - ramp(P, 0, 0.25))
    // The newest's thumbnail beside the stack, as its caption: out of the tile's deck, which stands for it at the workspaces stop.
    const newIn = l.key === model.newest ? ramp(zIn, TILE_GONE[0], TILE_GONE[1]) : 1
    // The focused item's agents: from under its thumbnail to the page's "used by".
    const usedAt = st.dir === 'items' && l.item === st.focusItem && docks && iz > 0 ? local(FV.usedBy(l.j).x, FV.usedBy(l.j).y) : null
    const cellAt = cell ? local(cell.x, cell.y) : usedAt
    const ls = lerp(lerp(A.s, 1, k1), 1.2, k2)
    const go = usedAt ? ease(ramp(I, 0, 0.85)) : into
    const lx = cellAt ? lerp(x, cellAt.x, go) : x
    const ly = cellAt ? lerp(y, cellAt.y, go) : y
    const lsTo = cell ? cell.w / (70 * S) : 20 / (22 * S)
    const lFade = usedAt ? (1 - ramp(I, 0.86, 0.99)) * (1 - ramp(z, 2, 2.25)) : fade
    const nodeK = cellAt ? lerp(ls, lsTo, go) : ls
    const thx = lerp(A.thsx, 22 / 70, k1)
    const thy = lerp(A.thsy, 22 / 46, k1)
    put(el.node, `translate(${f1(lx)}px, ${f1(ly)}px) scale(${f4(nodeK)})`, seen * lFade * newIn)
    put(el.th, `scale(${f4(thx)}, ${f4(thy)})`, A.th * (1 - ramp(P, 0, 0.25)))
    // Its words are set for the open card (--zv-k-card): a phone shows them only at that size.
    if (live) wordsSeen(el.th, near(S * nodeK * Math.min(thx, thy), kc) * (1 - ramp(P, 0, 0.1)))
    // A cell has no coin: it folds away on the way.
    put(el.coin, `translate(${f1(lerp(A.cx, 0, k1))}px, ${f1(lerp(A.cy, 0, k1))}px) perspective(240px) rotateY(${(180 * flip).toFixed(1)}deg) scale(${lerp(A.cs, 1, k1).toFixed(3)})`, cell ? 1 - ramp(into, 0, 0.5) : 1)
    // A phone draws the count at caption, on a coin large enough to carry it (dense crews: none).
    const coinPx = COIN_PX * S * nodeK
    const badgeK = live ? ` scale(${f4(pinned(SCENE_TYPE.small, BADGE_PX, S * nodeK))})` : null
    if (el.badge) put(el.badge, badgeK && badgeK.trim(), A.o * (1 - ramp(z, 1.25, 1.55)) * (1 - ramp(P, 0, 0.25)) * (live ? ramp(coinPx, 14, 18) : 1))
  }

  // ── the items' own thumbnails: dealt out of the tile's deck into the grid (only the artifacts' path shows them) ──
  const pageIn = st.dir === 'items' && st.focusItem !== null ? ease(ramp(I, 0, 0.85)) : 0
  const asideAt = new Map(model.items.filter((i) => i.id !== st.focusItem).map((i, k) => [i.id, k] as const))
  for (const it of model.items) {
    const el = els.items.get(it.id)
    if (!el) continue
    const grid = L.thumbs.at[it.id] ?? { x: 0, y: 0 }
    const k2 = ease(ramp(P, 0.5, 0.94))
    const sx = lerp(DECK_POSE.s, 1, k2)
    const sy = sx
    const mine = it.id === st.focusItem
    // Into its full view (draft · ifull()): the thumbnail grows into the page;
    // the others step aside to the left (a phone: they only fade).
    let nx = lerp(DECK_POSE.x, grid.x, k2)
    let ny = lerp(DECK_POSE.y, grid.y, k2)
    let nsx = sx
    let nsy = sy
    // Grown, the thumbnail's words would be blown up: it fades by half-way, into the crisp head.
    let out = mine ? 1 - ramp(iz, 0.3, 0.6) : 1 - ramp(iz, 0, 0.3)
    if (pageIn > 0 && mine) {
      const at = local(FV.page.x + FV.page.w / 2, FV.page.y + FV.page.h / 2)
      nx = lerp(nx, at.x, pageIn)
      ny = lerp(ny, at.y, pageIn)
      // Evenly, and no more than 2.4 times its size on screen: its words grow a
      // little, never stretched or blown up; the sheet under it carries the rest.
      const k = Math.min(FV.page.w / 168, FV.page.h / 108, 2.4) / S
      nsx = lerp(nsx, k, pageIn)
      nsy = lerp(nsy, k, pageIn)
    } else if (pageIn > 0) {
      const to = FV.aside(asideAt.get(it.id) ?? 0)
      if (to) {
        const at = local(to.x, to.y)
        const k = ease(ramp(I, 0, 0.6))
        nx = lerp(nx, at.x, k)
        ny = lerp(ny, at.y, k)
        nsx = lerp(nsx, to.s / S, k)
        nsy = lerp(nsy, to.s / S, k)
        out = lerp(1, to.o, k) * (1 - ramp(I, 0.86, 0.99))
      }
    }
    put(el.node, `translate(${f1(nx)}px, ${f1(ny)}px) scale(${f4(nsx)}, ${f4(nsy)})`, ramp(P, 0.04, 0.3) * out)
    // Its words are set for the grid (--zv-k-thumbs): a phone shows them only at that size,
    // so a thumbnail growing out of its coin or into its page carries none.
    const gridWords = live ? near(S * Math.min(nsx, nsy), sw.rest.thumbs) : 1
    if (live) wordsSeen(el.node, gridWords)
    put(el.ttl, null, ramp(P, 0.7, 0.96) * (1 - ramp(iz, 0, 0.25)) * gridWords)
  }

  // ── ties: the cables between terminals, at the crew ──
  const tieIn = (z <= 1 ? ramp(z, 0.55, 0.95) * 0.9 : 0.9) * (1 - ramp(P, 0, 0.25)) * (1 - ramp(z, 2, 2.2))
  for (const tie of model.ties) {
    const el = els.ties.get(tie.key)
    const a = agentAt[tie.a]
    const b = agentAt[tie.b]
    if (!el || !a || !b) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const cut = 36 * Math.min(a.s, b.s)
    const shown = Math.max(0, len - 2 * cut)
    put(el, `translate(${f1(a.x + Math.cos(ang) * cut)}px, ${f1(a.y + Math.sin(ang) * cut)}px) rotate(${f4(ang)}rad) scale(${f4(shown / 400)}, 1)`, len < 2 * cut + 4 ? 0 : tieIn)
  }
  // THE CREW'S LIGHT AT REST, every agent its own peak or one terrain. Drawn where the agents rest
  // on the crew, not where this frame has them: the drawing then changes only when the crew does,
  // never on each frame of a zoom (a phone's raster could not keep up and left the page undrawn,
  // 2026-11-13). It gives way while a hovered fold stands out of it, so the two never disagree.
  if (els.glow) {
    const mode = st.light ?? 'hover'
    let drawn = ''
    if (mode !== 'hover' && tieIn > 0.01) {
      if (mode === 'terrain') drawn = foldFacesSvg(terrainFaces(rest, model.ties), 'zv-glow')
      else {
        const near = new Map<string, Pos[]>()
        for (const t of model.ties) {
          const a = rest[t.a]
          const b = rest[t.b]
          if (!a || !b || t.a === t.b) continue
          near.set(t.a, [...(near.get(t.a) ?? []), b])
          near.set(t.b, [...(near.get(t.b) ?? []), a])
        }
        drawn = [...near].map(([id, spokes], k) => foldFacesSvg(foldFaces(rest[id], spokes), `zv-glow-${k}`)).join('')
      }
    }
    if (els.glow._h !== drawn) {
      els.glow.innerHTML = drawn
      els.glow._h = drawn
    }
    put(els.glow, null, mode === 'hover' || !drawn ? 0 : AT_REST[mode] * tieIn * (1 - fw))
  }
  // The fold's faces, drawn once where the fold takes the agents when it is all the way up, and
  // brought in by their opacity alone: easing in or out they are the same drawing, so the page is
  // not drawn again on every frame of it (the same phone, 2026-11-13).
  if (els.fold) {
    const up = (p: Pos): Pos => {
      const f = foldAt(p, peak ?? p, ridges)
      return { x: p.x + f.dx, y: p.y + f.dy }
    }
    const drawn = fw > 0 && peak ? foldFacesSvg(foldFaces(peak, ridges.map(up))) : ''
    if (els.fold._h !== drawn) {
      els.fold.innerHTML = drawn
      els.fold._h = drawn
    }
    put(els.fold, null, fw * tieIn)
  }

  // The empty seat: at the end of the crew, gone at group zoom and past the cards.
  {
    const seat = L.crew.next
    const seen = ramp(z, 0.85, 1.05) * (1 - ramp(z, 2.05, 2.3)) * (1 - pc)
    put(els.next, `translate(${f1(seat.x)}px, ${f1(seat.y)}px) scale(${f4(lerp(0.7, 1, ease(ramp(z, 0.85, 1.05))))})`, seen)
  }

  // ── the label: under the ring, then the crew's corner, then above the shelf ──
  // A phone draws it at caption on screen on every frame, from the group to the artifacts.
  // At the workspaces stop the tile wears the name: this one comes as the tile goes.
  const lk = live ? pinned(SCENE_TYPE.small, SCENE_CSS.small, S) : 1
  const labIn = ramp(zIn, TILE_GONE[0], TILE_GONE[1])
  const la = { x: -els.labelW / 2, y: 108 + (lk - 1) * 10 }
  const lb = crewLabelAt(L, st.narrow, sw.label.crew)
  const lc = { x: -L.thumbs.box.w / 2 + 50, y: L.thumbs.shelfY - 70 }
  const lt = ease(clamp01(z))
  const lab = keepOnScreen(
    { x: lerp(lerp(la.x, lb.x, lt), lc.x, pc), y: lerp(lerp(la.y, lb.y, lt), lc.y, pc), w: els.labelW, h: els.labelH, k: lk },
    { S, Ox, Oy },
    w,
    h,
    Math.min(st.pan ?? 0, panMax)
  )
  // Toward the card stop it goes, on screen, to the free place that stop leaves it (cardStopLabel), or fades.
  let labAt = lab
  let labSeen = 1
  if (z > 1 && st.dir === 'agents') {
    const k = ease(clamp01(z - 1))
    const lc = sw.label.card
    const spot = cardStopLabel(L, st.focus, w, h, st.narrow, { w: els.labelW * lc, h: els.labelH * lc })
    if (spot) {
      // The spot is the label's top-left on screen; drawn at lk about its centre, it starts that much further in.
      const kk = live ? lk : lc
      const sx = lerp(Ox + lab.x * S, spot.x - ((1 - kk) * els.labelW * S) / 2, k)
      const sy = lerp(Oy + lab.y * S, spot.y - ((1 - kk) * els.labelH * S) / 2, k)
      labAt = { x: (sx - Ox) / S, y: (sy - Oy) / S }
    } else labSeen = 1 - k
  }
  put(els.label, `translate(${f1(labAt.x)}px, ${f1(labAt.y)}px)${Math.abs(lk - 1) < 1e-4 ? '' : ` scale(${f4(lk)})`}`, labSeen * labIn * (1 - toFull) * (1 - ramp(iz * pc, 0, 0.3)))
  // The caption shows from the group out of the device: at the workspaces stop the tile's deck says it.
  const capIn = ramp(zIn, TILE_GONE[0], TILE_GONE[1])
  const newSeen = (1 - ramp(z, 0.05, 0.3)) * (1 - pc) * capIn
  const capK = live ? ` scale(${f4(pinned(SCENE_TYPE.small, SCENE_CSS.newCap, S))})` : ''
  put(els.newCap, `translate(${f1(NEW_POSE.x - 52)}px, ${f1(NEW_POSE.y + 40)}px)${capK}`, model.newest || els.newThumb ? newSeen : 0)
  // Carried by nobody's coin, it stands there on its own and goes as the group opens (draft · newestPose).
  put(els.newThumb, null, model.newest ? 0 : newSeen)
  // A phone shows it as a picture: the caption beside it says what it is.
  if (live && els.newThumb) wordsSeen(els.newThumb, 0)

  // ── the full-view panel: in screen space, from the focused card (or thumbnail) to the whole view ──
  let fromRect: { x: number; y: number; w: number; h: number } | null = null
  let amt = 0
  if (st.dir === 'agents' && st.focus && agentAt[st.focus]) {
    const p = agentAt[st.focus]
    fromRect = { x: Ox + (p.x - 34) * S, y: Oy + (p.y - 34) * S, w: 260 * S, h: 244 * S }
    amt = toFull
    put(els.panel, null, ramp(z, 2, 2.08))
  } else if (st.dir === 'items' && st.focusItem && L.thumbs.at[st.focusItem]) {
    const g = L.thumbs.at[st.focusItem]
    fromRect = { x: Ox + (g.x - 84) * S, y: Oy + (g.y - 54) * S, w: 168 * S, h: 108 * S }
    amt = ease(ramp(I, 0, 0.85))
    put(els.panel, null, ramp(I, 0, 0.08))
  } else put(els.panel, null, 0)
  if (fromRect) {
    const tx = lerp(fromRect.x, 12, amt)
    const ty = lerp(fromRect.y, 12, amt)
    const sw = lerp(fromRect.w, w - 24, amt) / Math.max(1, w - 24)
    const shh = lerp(fromRect.h, h - 24, amt) / Math.max(1, h - 24)
    put(els.panel, `translate(${f1(tx)}px, ${f1(ty)}px) scale(${f4(sw)}, ${f4(shh)})`, (els.panel._o ?? 0) > 0 ? els.panel._o : 0)
  }
  put(els.fullHead, null, st.dir === 'items' && st.focusItem !== null ? ramp(I, 0.4, 0.7) : 0)
  const cover = st.dir === 'agents' ? 1 - ramp(z, 2.86, 2.99) : 1 - ramp(I, 0.86, 0.99)
  // The shelf's "+N" chip: after its page's last face, as the thumbnails unfold, gone into an item's full view.
  const more = shelf.more
  put(els.shelfMore, more ? `translate(${f1(more.x - SHELF_FACE / 2)}px, ${f1(L.thumbs.shelf.y - SHELF_FACE / 2)}px)` : null, more ? ease(ramp(P, 0.4, 0.9)) * (1 - ramp(iz * pc, 0, 0.35)) : 0)
  return { cover, scale: S, panMax, tilesMax: dc.panMax, dropOn }
}
