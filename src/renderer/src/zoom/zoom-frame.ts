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
import { crewOf, deviceOf, fitScale, machinesAt, shelfRow, stackOf, thumbsOf, type Box, type Pos, NEW_POSE } from './zoom-layout'
import { sceneWords, SHELF_NAME_S, UNDER_FACE, type RestScales, type SceneWords } from './scene-words'
import { fullPoses } from './full-poses'
/* The cameras, the card stop's label and the words' scales: zoom-camera.ts. */
export * from './zoom-camera'
import { GROUP_BOX, SWS, boxAt, cardStopLabel, crewLabelAt, deskCamera, deviceWords, keepOnScreen, phoneCamera, phoneThumbs, thumbsCamera, wordsOf, type Layout } from './zoom-camera'

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

type Put = HTMLElement & { _t?: string; _o?: number }
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
  ring: Put
  label: Put
  labelW: number
  labelH: number
  newCap: Put
  agents: Map<string, AgentEls>
  links: Map<string, { node: Put; th: Put; coin: Put; badge: Put | null }>
  items: Map<string, { node: Put; ttl: Put }>
  ties: Map<string, Put>
  marks: Map<string, Put>
  /** The empty seat at the end of the crew: the way a new agent is made. */
  next: Put | null
  /** An item's full-view head, crisp (ZoomView · zv-fv-ghost): the page's words arrive in it, never blown up. */
  fullHead?: Put | null
  /** The newest browser beside the stack when no coin carries it (ZoomView · NewestThumb). */
  newThumb?: Put | null
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
  /** How far the shelf over the thumbnails is scrolled sideways, in px from its left end (shelfFrame clamps it). */
  shelf?: number
}

/** The shelf over the thumbnails on screen: how far it scrolls sideways (0 when it fits), and the band it is drawn in. */
export interface ShelfOut {
  max: number
  top: number
  bottom: number
}

/** What the view reports after a frame: how opaque it still is (it hands over to the real full view), and the scene's scale. */
export interface FrameOut {
  cover: number
  scale: number
  /** How far the crew (a narrow screen) or the thumbnails can scroll, in px: 0 when they fit. */
  panMax: number
  shelf: ShelfOut
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

/** The machine's screen holds the device view at this scale. */
const SDEV = 0.5
const WASH = { w: 1200, h: 540 }


export function layoutOf(model: FrameModel, narrow: boolean): Layout {
  // A tree under the leads, by the cables between agents (zoom-layout.ts · crewRows).
  const crew = crewOf(model.agents, narrow, model.crewCols, model.ties)
  const device = deviceOf(model.workspaces, narrow, model.screenAspect, model.deviceCols)
  const screen = { w: device.screen.w * SDEV + 28, h: device.screen.h * SDEV + 28 }
  const machines = machinesAt(model.otherMachines, device.screen, narrow)
  // The other machines are part of the devices stop: the camera must frame them too.
  const mTop = device.screen.h / 2 + 120
  const mBottom = machines.rows ? mTop + machines.rows * 260 : -Infinity
  const half = Math.max(screen.h / 2 + 60, mBottom)
  return {
    stack: stackOf(model.agents),
    crew,
    cardBox: { ...crew.box, w: crew.box.w + 240, h: crew.box.h + 252, cy: crew.box.cy + 60 },
    thumbs: thumbsOf(model.items, model.agents, narrow),
    device,
    devicesBox: { w: Math.max(screen.w + 200, machines.rows ? 3 * 420 + 200 : 0), h: half * 2 + 200, cy: 40 }
  }
}

/** A coin docks under an item whose slot is on screen or this near it, in px (paint · the links). */
const COIN_ROOM = 160
/** The shelf's strip on screen: this far in from each side, and an agent past it fades over SHELF_FADE px (half out, half seen). */
const SHELF_EDGE = { wide: 32, narrow: 12 }
const SHELF_FADE = 48
/** The shelf's band around its row, in scene px: the faces above, the names below (where a wheel or a drag scrolls it). */
const SHELF_BAND = { top: 36, bottom: 60 }
interface ShelfFrame {
  /** Each agent's x on the shelf, in scene px, scrolled. */
  x: Record<string, number>
  /** Each agent's opacity at the strip's ends. */
  o: Record<string, number>
  max: number
}
/** The row is measured once per set of elements (their names' widths) and scale of the names. */
const shelfMemo = new WeakMap<FrameEls, { L: Layout; k: number; row: ReturnType<typeof shelfRow> }>()
/**
 * THE SHELF ON SCREEN (owner, 2026-11-02): one row at the thumbnails' scale
 * S. A row that fits is centred; a longer one starts at the strip's left end
 * and scrolls sideways (`pan` px), its agents fading out past either end.
 */
function shelfFrame(L: Layout, els: FrameEls, nameK: number, w: number, S: number, narrow: boolean, pan: number): ShelfFrame {
  const memo = shelfMemo.get(els)
  const row = memo && memo.L === L && memo.k === nameK
    ? memo.row
    : shelfRow(L.thumbs.shelf, (id) => (els.agents.get(id)?.nmW ?? 0) * SHELF_NAME_S * nameK)
  if (!memo || memo.row !== row) shelfMemo.set(els, { L, k: nameK, row })
  const edge = narrow ? SHELF_EDGE.narrow : SHELF_EDGE.wide
  const max = Math.max(0, row.w * S - (w - edge * 2))
  const p = Math.min(Math.max(pan, 0), max)
  // The camera puts scene x 0 at the screen's centre: the row's left end goes to the strip's, less the scroll.
  const shift = max > 0 ? (edge - p - w / 2) / S + row.w / 2 : 0
  const x: Record<string, number> = {}
  const o: Record<string, number> = {}
  for (const id of L.thumbs.shelf.order) {
    x[id] = (row.x[id] ?? 0) + shift
    const sx = w / 2 + x[id] * S
    const half = ((row.slot[id] ?? 0) * S) / 2
    const out = Math.max(0, edge - (sx - half), sx + half - (w - edge))
    o[id] = clamp01(1 - out / SHELF_FADE)
  }
  return { x, o, max }
}

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
  const camD = fit(L.device.box)
  let dS: number
  let dOx: number
  let dOy: number
  if (zIn < -1) {
    // From all devices into the machine's screen: its centre holds the device view's centre.
    const k = ease(zIn + 2)
    const camDD = fit(L.devicesBox)
    const s0 = camDD * SDEV
    dS = Math.exp(lerp(Math.log(s0), Math.log(camD), k))
    dOx = w / 2
    dOy = lerp(h / 2 - camDD * L.devicesBox.cy - s0 * L.device.box.cy, h / 2 - camD * L.device.box.cy, k)
    aS = dS * SWS
    aOx = dOx + dS * slot.x
    aOy = dOy + dS * slot.y
  } else {
    if (zIn < 0) {
      const k = ease(zIn + 1)
      aS = Math.exp(lerp(Math.log(camD * SWS), Math.log(aS), k))
      aOx = lerp(w / 2 + camD * slot.x, aOx, k)
      aOy = lerp(h / 2 + camD * (slot.y - L.device.box.cy), aOy, k)
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
  put(els.device, `translate(${f1(dOx)}px, ${f1(dOy)}px) scale(${f4(dS)})`, (1 - ramp(zIn, -0.4, -0.05)) * (1 - pc))
  const vS = dS / SDEV
  put(els.devices, `translate(${f1(dOx)}px, ${f1(dOy + dS * L.device.box.cy)}px) scale(${f4(vS)})`, (1 - ramp(zIn, -1.4, -1.05)) * (1 - pc))
  put(els.machine, null, 1)

  // ── the wash and the ring: the workspace's own ground ──
  const wb = zIn < 0 ? GROUP_BOX : bA
  // A grid that scrolls has the screenful under it, not a sheet as tall as the grid: the grid slides over it.
  const tb: Box = tc.panMax > 0 ? { w: L.thumbs.box.w, h: h / iS, cy: (h / 2 - iOy) / iS } : L.thumbs.box
  const wsx = lerp(lerp(0.2, wb.w / WASH.w, ease(z)), tb.w / WASH.w, pc)
  const wsy = lerp(lerp(0.42, wb.h / WASH.h, ease(z)), tb.h / WASH.h, pc)
  // The ground lies over the sheet now (the sheet is under the scene): it goes as a full view comes.
  const sheetIn = st.dir === 'agents' ? ramp(z, 2, 2.4) : ramp(I, 0, 0.4)
  put(els.wash, `translate(0px, ${f1(lerp(lerp(-10, wb.cy, ease(z)), tb.cy, pc))}px) scale(${f4(wsx)}, ${f4(wsy)})`, lerp(0.6, 0.55, ease(z)) * (1 - sheetIn))
  const open = ease(clamp01(z))
  put(els.ring, `translate(0px, -10px) scale(${f4(1 + 1.7 * open)}) rotate(${(-18 * open).toFixed(2)}deg)`, (1 - ramp(z, 0.05, 0.75)) * (1 - ramp(P, 0, 0.3)))

  // ── the agents ──
  // A phone draws the words under a face, and in the open card's head, at the type scale on screen (scene-words.ts).
  const sw = wordsOf(L, w, h, st.narrow)
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
  const shelf = shelfFrame(L, els, sw.shelf.name, w, iS, st.narrow, st.shelf ?? 0)
  model.agents.forEach((a, i) => {
    const e = els.agents.get(a.id)
    if (!e) return
    const zi = zOf(a.id)
    zm[a.id] = zi
    const far = L.stack[a.id] ?? { x: 0, y: 0, s: 0.84, r: 0 }
    const mid = L.crew.at[a.id] ?? { x: 0, y: 0 }
    const t = ease(ramp(z, Math.min(i, 6) * 0.03, 0.8 + Math.min(i, 6) * 0.03))
    let x = lerp(far.x, mid.x, t)
    let y = lerp(far.y, mid.y, t)
    let s = lerp(far.s, 1, t) * lerp(1, 0.62, ease(clamp01(zi - 1)))
    const r = lerp(far.r, 0, t)
    // To the shelf as the thumbs unfold.
    const sh = { x: shelf.x[a.id] ?? 0, y: L.thumbs.shelfY }
    const pm = ease(ramp(P, 0.02 * Math.min(i, 8), 0.44 + 0.02 * Math.min(i, 8)))
    // Past the ends of the shelf's strip an agent fades out (it scrolls back in).
    const onShelf = lerp(1, shelf.o[a.id] ?? 1, pm)
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
    put(e.node, `translate(${f1(nodeX)}px, ${f1(nodeY)}px)`, (dock ? lerp(1, dock.o, ramp(docked, 0, 0.6)) : 1) * onShelf)
    const avAt = focused && into > 0 ? local(FV.avatar.x, FV.avatar.y, x, y) : { x: 0, y: 0 }
    const avS = focused ? lerp(s, FV.avatar.size / (64 * S), into) : dock ? lerp(s, dock.size / (64 * S), docked) : s
    const avMove = focused && into > 0 ? `translate(${f1(avAt.x * into)}px, ${f1(avAt.y * into)}px) ` : ''
    put(e.av, `${avMove}rotate(${r.toFixed(2)}deg) scale(${f4(avS)})`, (1 - ramp(iz * pc, 0, 0.35)) * (focused ? headOut : 1))
    const cBase = ramp(zi, 1.3, 1.85) * gone
    const ce = ease(cBase)
    put(e.cardl, `translate(${f1(x)}px, ${f1(y)}px)`, focused ? 1 - ramp(z, 2.04, 2.14) : 1 - ramp(z, 2, 2.3))
    put(e.card, `scale(${f4(lerp(64 / 260, 1, ce) * lerp(1, 0.5, pm))}, ${f4(lerp(64 / 244, 1, ce) * lerp(1, 0.5, pm))})`, cBase)
    const n = zi <= 1 ? 0 : zi - 1
    const nx = ease(ramp(n, 0, 0.6))
    const ny = ease(ramp(n, 0.4, 1))
    const nmIn = ramp(z, 0.5, 0.95)
    // The open card's words travel to the head; the others' fade as they dock.
    const words = focused ? headOut : 1 - ramp(z, 2, 2.2)
    // The words' factors: the crew's under the face, the card's in its head for the
    // open card (the others keep the crew's into the card stop, 1 on the shelf).
    const fN = lerp(focused ? lerp(sw.crew.name, sw.card.name, ny) : lerp(sw.crew.name, 1, ease(clamp01(z - 1))), sw.shelf.name, pm)
    const fS = lerp(focused ? lerp(sw.crew.status, sw.card.status, ny) : lerp(sw.crew.status, 1, ease(clamp01(z - 1))), 1, pm)
    // Drawn at f about its centre, a word keeps the top (and, in the card's head, the left) it has at 1.
    const grow = (f: number, s0: number, wd: number, ht: number, left: number): { dx: number; dy: number } => ({ dx: left * (wd / 2) * s0 * (f - 1), dy: (ht / 2) * s0 * (f - 1) })
    const U = UNDER_FACE
    const stTop = U.nameTop + U.toStatus * fN
    const cntTop = stTop + U.toCounts * fS
    const nA = { x: lerp(-e.nmW / 2, 30, nx), y: lerp(U.nameTop, -24, ny) + (1 - nmIn) * -14, s: lerp(0.7, 1, nmIn), o: nmIn * words }
    const nB = { x: -e.nmW / 2, y: 22, s: SHELF_NAME_S, o: 1 - ramp(iz * pc, 0, 0.35) }
    const ns = lerp(nA.s, nB.s, pm)
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
      const k = 1 / S
      stP.x = lerp(stP.x, at.x - (e.stW / 2) * (1 - k), into)
      stP.y = lerp(stP.y, at.y - ((e.stH ?? 13) / 2) * (1 - k), into)
      stP.k = lerp(stP.k, k, into)
    }
    put(e.st, `translate(${f1(stP.x)}px, ${f1(stP.y)}px)${stP.k === 1 ? '' : ` scale(${f4(stP.k)})`}`, stIn * gone * words)
    const cntIn = ramp(z, 0.62, 0.95)
    // Where the crew has no room for the counts' line, they show in the open card's head only.
    const cntRoom = sw.crew.counts ? 1 : nx
    const cg = grow(fS, 1, e.cntW, 11, nx)
    const cP = { x: lerp(-e.cntW / 2, 30 + (e.stW + 10) * fS, nx) + cg.dx, y: lerp(cntTop, -1, ny) + (1 - cntIn) * -10 + cg.dy, k: fS }
    if (focused && into > 0) {
      const at = local(FV.line.x + e.stW + 10, FV.line.y, x, y)
      const k = 1 / S
      cP.x = lerp(cP.x, at.x - (e.cntW / 2) * (1 - k), into)
      cP.y = lerp(cP.y, at.y - (11 / 2) * (1 - k), into)
      cP.k = lerp(cP.k, k, into)
    }
    put(e.cnt, `translate(${f1(cP.x)}px, ${f1(cP.y)}px)${cP.k === 1 ? '' : ` scale(${f4(cP.k)})`}`, cntIn * gone * words * cntRoom)
    // The typed words: centred by their own CSS (their width moves with every
    // key, the measured ones only with the model), on the counts' line when
    // there are none. The open card's reply box holds them, so they go there.
    const dftTop = e.cntW > 0 && sw.crew.counts ? cntTop + U.toDraft * fS : stTop + U.toCounts * fS
    put(e.dft, `translate(0px, ${f1(dftTop + (1 - cntIn) * -10)}px)${fS === 1 ? '' : ` scale(${f4(fS)})`}`, cntIn * gone * words * (1 - nx))
    const b = ramp(zi, 1.6, 1.97)
    // The last words go to the transcript's top, and hand over to it; the
    // reply box goes down to the prompt it becomes.
    const bodyAt = focused && into > 0 ? local(FV.transcript.x, FV.transcript.y, x, y) : null
    const bodyK = bodyAt ? lerp(1, 1 / S, into) : 1
    // On the card (AgentCard.tsx draws the floating card from the same spot).
    const bodyCard = { x: -18, y: 32 + (1 - b) * 10 }
    const bx = bodyAt ? lerp(bodyCard.x, bodyAt.x, into) : bodyCard.x
    const by = bodyAt ? lerp(bodyCard.y, bodyAt.y, into) : bodyCard.y
    put(e.body, `translate(${f1(bx)}px, ${f1(by)}px)${bodyK === 1 ? '' : ` scale(${f4(bodyK)})`}`, b * gone * (focused ? 1 - ramp(z, 2.88, 2.99) : words))
    put(e.emp, null, ramp(zi, 1.6, 1.97) * gone * (focused ? 1 - toFull : words))
    const replyAt = focused && into > 0 ? local(FV.reply.x, FV.reply.y, x, y) : null
    const rk = replyAt ? lerp(1, 1 / S, into) : 1
    // .zv-reply sits at (-18, 170), 228x30, scaled about its centre.
    const rMove = replyAt ? `translate(${f1(lerp(0, replyAt.x + 18 - 114 * (1 - rk), into))}px, ${f1(lerp(0, replyAt.y - 170 - 15 * (1 - rk), into))}px) scale(${f4(rk)})` : null
    put(e.reply, rMove ?? (e.reply?._t ? 'none' : null), ramp(zi, 1.7, 2) * gone * (focused ? 1 - ramp(z, 2.2, 2.6) : words))
    if (e.dot) {
      const k = ease(ramp(z, 0.15, 0.7))
      const dx = lerp(38, x + 22 * s, k)
      const dy = lerp(-52, y - 22 * s, k)
      put(e.dot, `translate(${f1(dx)}px, ${f1(dy)}px)`, (1 - ramp(iz * pc, 0, 0.35)) * onShelf * (focused ? 1 - toFull : 1 - ramp(z, 2, 2.2)))
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
    // The newest's thumbnail beside the stack, as its caption: on a phone, not as specks on the device's marks.
    const newIn = st.narrow && l.key === model.newest ? ramp(zIn, -0.6, -0.2) : 1
    // The focused item's agents: from under its thumbnail to the page's "used by".
    const usedAt = st.dir === 'items' && l.item === st.focusItem && docks && iz > 0 ? local(FV.usedBy(l.j).x, FV.usedBy(l.j).y) : null
    const cellAt = cell ? local(cell.x, cell.y) : usedAt
    const ls = lerp(lerp(A.s, 1, k1), 1.2, k2)
    const go = usedAt ? ease(ramp(I, 0, 0.85)) : into
    const lx = cellAt ? lerp(x, cellAt.x, go) : x
    const ly = cellAt ? lerp(y, cellAt.y, go) : y
    const lsTo = cell ? cell.w / (70 * S) : 20 / (22 * S)
    const lFade = usedAt ? (1 - ramp(I, 0.86, 0.99)) * (1 - ramp(z, 2, 2.25)) : fade
    put(el.node, `translate(${f1(lx)}px, ${f1(ly)}px) scale(${f4(cellAt ? lerp(ls, lsTo, go) : ls)})`, seen * lFade * newIn)
    put(el.th, `scale(${f4(lerp(A.thsx, 22 / 70, k1))}, ${f4(lerp(A.thsy, 22 / 46, k1))})`, A.th * (1 - ramp(P, 0, 0.25)))
    // A cell has no coin: it folds away on the way.
    put(el.coin, `translate(${f1(lerp(A.cx, 0, k1))}px, ${f1(lerp(A.cy, 0, k1))}px) perspective(240px) rotateY(${(180 * flip).toFixed(1)}deg) scale(${lerp(A.cs, 1, k1).toFixed(3)})`, cell ? 1 - ramp(into, 0, 0.5) : 1)
    if (el.badge) put(el.badge, null, A.o * (1 - ramp(z, 1.25, 1.55)) * (1 - ramp(P, 0, 0.25)))
  }

  // ── the items' own thumbnails: each grows out of its first coin into the grid ──
  const pageIn = st.dir === 'items' && st.focusItem !== null ? ease(ramp(I, 0, 0.85)) : 0
  const asideAt = new Map(model.items.filter((i) => i.id !== st.focusItem).map((i, k) => [i.id, k] as const))
  for (const it of model.items) {
    const el = els.items.get(it.id)
    if (!el) continue
    const grid = L.thumbs.at[it.id] ?? { x: 0, y: 0 }
    const first = firstLink.get(it.id)
    const A = first ? linkAt.get(first.key) : undefined
    const from = A ?? { x: 0, y: 0, s: 0.3, grow: 0 }
    const w0 = lerp(22, 70, from.grow) * from.s
    const h0 = lerp(22, 46, from.grow) * from.s
    const gs = lerp(0.34, 0.42, from.grow)
    const k1 = ease(ramp(P, 0.06, 0.46))
    const k2 = ease(ramp(P, 0.5, 0.94))
    const sx = lerp(lerp(w0 / 168, gs, k1), 1, k2)
    const sy = lerp(lerp(h0 / 108, gs, k1), 1, k2)
    const mine = it.id === st.focusItem
    // Into its full view (draft · ifull()): the thumbnail grows into the page;
    // the others step aside to the left (a phone: they only fade).
    let nx = lerp(from.x, grid.x, k2)
    let ny = lerp(from.y, grid.y, k2)
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
    put(el.ttl, null, ramp(P, 0.7, 0.96) * (1 - ramp(iz, 0, 0.25)))
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

  // The empty seat: at the end of the crew, gone at group zoom and past the cards.
  {
    const seat = L.crew.next
    const seen = ramp(z, 0.85, 1.05) * (1 - ramp(z, 2.05, 2.3)) * (1 - pc)
    put(els.next, `translate(${f1(seat.x)}px, ${f1(seat.y)}px) scale(${f4(lerp(0.7, 1, ease(ramp(z, 0.85, 1.05))))})`, seen)
  }

  // ── the label: under the ring, then the crew's corner, then above the shelf ──
  // The device draws this group small (SWS inside the device's fit): its label grows there as its neighbours' do (deviceWords), back to 1 by the crew.
  const dw = deviceWords(L.device, w, h, st.narrow)
  // From the crew on, a phone draws it at caption on screen: the crew's factor, the card's toward the card stop.
  const lz = st.dir === 'agents' ? lerp(sw.label.crew, sw.label.card, ease(clamp01(z - 1))) : sw.label.crew
  const lk = lerp(lerp(lerp(1, lz, ease(clamp01(zIn))), sw.label.thumbs, pc), Math.min(dw.openK, dw.openW / Math.max(1, els.labelW)), 1 - ramp(zIn, -1, -0.3))
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
    const kc = sw.label.card
    const spot = cardStopLabel(L, st.focus, w, h, st.narrow, { w: els.labelW * kc, h: els.labelH * kc })
    if (spot) {
      // The spot is the label's top-left on screen; drawn at kc about its centre, it starts that much further in.
      const sx = lerp(Ox + lab.x * S, spot.x - ((1 - kc) * els.labelW * S) / 2, k)
      const sy = lerp(Oy + lab.y * S, spot.y - ((1 - kc) * els.labelH * S) / 2, k)
      labAt = { x: (sx - Ox) / S, y: (sy - Oy) / S }
    } else labSeen = 1 - k
  }
  put(els.label, `translate(${f1(labAt.x)}px, ${f1(labAt.y)}px)${Math.abs(lk - 1) < 1e-4 ? '' : ` scale(${f4(lk)})`}`, labSeen * (1 - toFull) * (1 - ramp(iz * pc, 0, 0.3)))
  // On a phone the caption shows from the group out of the device, never as specks on the device's marks.
  const capIn = st.narrow ? ramp(zIn, -0.6, -0.2) : 1
  const newSeen = (1 - ramp(z, 0.05, 0.3)) * (1 - pc) * capIn
  put(els.newCap, `translate(${f1(NEW_POSE.x - 52)}px, ${f1(NEW_POSE.y + 40)}px)`, model.newest || els.newThumb ? newSeen : 0)
  // Carried by nobody's coin, it stands there on its own and goes as the group opens (draft · newestPose).
  put(els.newThumb, null, model.newest ? 0 : newSeen)

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
  const band = { top: iOy + (L.thumbs.shelfY - SHELF_BAND.top) * iS, bottom: iOy + (L.thumbs.shelfY + SHELF_BAND.bottom) * iS }
  return { cover, scale: S, panMax, shelf: { max: shelf.max, ...band } }
}
