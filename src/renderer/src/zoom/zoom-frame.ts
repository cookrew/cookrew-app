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
import { crewOf, deviceOf, fitScale, machinesAt, stackOf, thumbsOf, type Box, type Pos } from './zoom-layout'

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
  active: string
  /** The newest browser's link: at group zoom it stands beside the stack. */
  newest: string | null
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
  /** The card's own parts, mounted for the open card only (ZoomView · cardIds): null elsewhere. */
  body: Put | null
  reply: Put | null
  emp: Put | null
  dot: Put | null
  nmW: number
  stW: number
  cntW: number
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
  newCap: Put
  agents: Map<string, AgentEls>
  links: Map<string, { node: Put; th: Put; coin: Put; badge: Put | null }>
  items: Map<string, { node: Put; ttl: Put }>
  ties: Map<string, Put>
  marks: Map<string, Put>
  /** The empty seat at the end of the crew: the way a new agent is made. */
  next: Put | null
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
}

/** What the view reports after a frame: how opaque it still is (it hands over to the real full view), and the scene's scale. */
export interface FrameOut {
  cover: number
  scale: number
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
    // What cannot be seen cannot be pressed.
    el.style.pointerEvents = o < 0.05 ? 'none' : ''
  }
}

const GROUP_BOX: Box = { w: 430, h: 320, cy: 0 }
/** A workspace's mark on the device is its group at this scale. */
export const SWS = 0.62
/** The machine's screen holds the device view at this scale. */
const SDEV = 0.5
const WASH = { w: 1200, h: 540 }
const NEW_POSE = { x: 132, y: 34, s: 1.5 }

export interface Layout {
  stack: ReturnType<typeof stackOf>
  crew: ReturnType<typeof crewOf>
  cardBox: Box
  thumbs: ReturnType<typeof thumbsOf>
  device: ReturnType<typeof deviceOf>
  devicesBox: Box
}

export function layoutOf(model: FrameModel, narrow: boolean): Layout {
  const crew = crewOf(model.agents, narrow)
  const device = deviceOf(model.workspaces, narrow)
  const screen = { w: device.box.w * SDEV + 28, h: device.box.h * SDEV + 28 }
  const machines = machinesAt(model.otherMachines, device.box, narrow)
  // The other machines are part of the devices stop: the camera must frame them too.
  const mTop = device.box.h / 2 + 120
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

/** The camera box at agent zoom z ≥ 0. */
function boxAt(L: Layout, z: number): Box {
  const mix = (a: Box, b: Box, t: number): Box => ({ w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), cy: lerp(a.cy, b.cy, t) })
  if (z <= 1) return mix(GROUP_BOX, L.crew.box, ease(z))
  return mix(L.crew.box, L.cardBox, ease(clamp01(z - 1)))
}

export function paint(model: FrameModel, L: Layout, els: FrameEls, st: FrameState): FrameOut {
  const { z: zIn, P, I } = derive(st.dir, st.sv)
  const z = Math.max(0, zIn)
  const pc = ease(P)
  const iz = ease(I)
  const { w, h } = st
  const fit = (b: Box): number => fitScale(b, w, h)

  // ── the camera: agent framing, the device dive below 0, the pivot to the thumbs ──
  const bA = boxAt(L, z)
  let aS = fit(bA)
  let aOx = w / 2
  let aOy = h / 2 - bA.cy * aS
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
  const iS = fit(L.thumbs.box)
  const S = lerp(aS, iS, pk)
  const Ox = lerp(aOx, w / 2, pk)
  const Oy = lerp(aOy, h / 2 - L.thumbs.box.cy * iS, pk)
  put(els.scene, `translate(${f1(Ox)}px, ${f1(Oy)}px) scale(${f4(S)})`)
  put(els.device, `translate(${f1(dOx)}px, ${f1(dOy)}px) scale(${f4(dS)})`, (1 - ramp(zIn, -0.4, -0.05)) * (1 - pc))
  const vS = dS / SDEV
  put(els.devices, `translate(${f1(dOx)}px, ${f1(dOy + dS * L.device.box.cy)}px) scale(${f4(vS)})`, (1 - ramp(zIn, -1.4, -1.05)) * (1 - pc))
  put(els.machine, null, 1)

  // ── the wash and the ring: the workspace's own ground ──
  const wb = zIn < 0 ? GROUP_BOX : bA
  const wsx = lerp(lerp(0.2, wb.w / WASH.w, ease(z)), L.thumbs.box.w / WASH.w, pc)
  const wsy = lerp(lerp(0.42, wb.h / WASH.h, ease(z)), L.thumbs.box.h / WASH.h, pc)
  put(els.wash, `translate(0px, ${f1(lerp(lerp(-10, wb.cy, ease(z)), L.thumbs.box.cy, pc))}px) scale(${f4(wsx)}, ${f4(wsy)})`, lerp(0.6, 0.55, ease(z)))
  const open = ease(clamp01(z))
  put(els.ring, `translate(0px, -10px) scale(${f4(1 + 1.7 * open)}) rotate(${(-18 * open).toFixed(2)}deg)`, (1 - ramp(z, 0.05, 0.75)) * (1 - ramp(P, 0, 0.3)))

  // ── the agents ──
  const gone = 1 - ramp(P, 0, 0.25)
  const cardAmt = (id: string): number => (id === st.focus ? clamp01(z - 1) : id === st.leaving ? st.leavingAmt : 0)
  const zOf = (id: string): number => (z <= 1 ? z : 1 + cardAmt(id))
  const agentAt: Record<string, Pos & { s: number }> = {}
  const zm: Record<string, number> = {}
  const toFull = ease(ramp(z, 2, 2.85))
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
    const sh = L.thumbs.shelf[a.id] ?? { x: 0, y: L.thumbs.shelfY }
    const pm = ease(ramp(P, 0.02 * Math.min(i, 8), 0.44 + 0.02 * Math.min(i, 8)))
    x = lerp(x, sh.x, pm)
    y = lerp(y, sh.y, pm)
    s = lerp(s, 0.5, pm)
    agentAt[a.id] = { x, y, s }
    const focused = a.id === st.focus
    // Into the full view: the focused card hands over to the panel; the others step back.
    const away = focused ? 1 : 1 - ramp(z, 2, 2.3)
    put(e.node, `translate(${f1(x)}px, ${f1(y)}px)`, away)
    put(e.av, `rotate(${r.toFixed(2)}deg) scale(${f4(s)})`, (1 - ramp(iz * pc, 0, 0.35)) * (focused ? 1 - toFull : 1))
    const cBase = ramp(zi, 1.3, 1.85) * gone
    const ce = ease(cBase)
    put(e.cardl, `translate(${f1(x)}px, ${f1(y)}px)`, focused ? 1 - ramp(z, 2.04, 2.14) : away)
    put(e.card, `scale(${f4(lerp(64 / 260, 1, ce) * lerp(1, 0.5, pm))}, ${f4(lerp(64 / 244, 1, ce) * lerp(1, 0.5, pm))})`, cBase)
    const n = zi <= 1 ? 0 : zi - 1
    const nx = ease(ramp(n, 0, 0.6))
    const ny = ease(ramp(n, 0.4, 1))
    const nmIn = ramp(z, 0.5, 0.95)
    const words = focused ? 1 - toFull : 1
    const nA = { x: lerp(-e.nmW / 2, 30, nx), y: lerp(42, -24, ny) + (1 - nmIn) * -14, s: lerp(0.7, 1, nmIn), o: nmIn * words }
    const nB = { x: -e.nmW / 2, y: 22, s: 0.78, o: 1 - ramp(iz * pc, 0, 0.35) }
    put(e.nm, `translate(${f1(lerp(nA.x, nB.x, pm))}px, ${f1(lerp(nA.y, nB.y, pm))}px) scale(${lerp(nA.s, nB.s, pm).toFixed(3)})`, lerp(nA.o, nB.o, pm))
    const stIn = ramp(z, 0.62, 1)
    put(e.st, `translate(${f1(lerp(-e.stW / 2, 30, nx))}px, ${f1(lerp(62, -2, ny) + (1 - stIn) * -18)}px)`, stIn * gone * words)
    const cntIn = ramp(z, 0.62, 0.95)
    put(e.cnt, `translate(${f1(lerp(-e.cntW / 2, 30 + e.stW + 10, nx))}px, ${f1(lerp(80, -1, ny) + (1 - cntIn) * -10)}px)`, cntIn * gone * words)
    const b = ramp(zi, 1.6, 1.97)
    put(e.body, `translate(-18px, ${f1(32 + (1 - b) * 10)}px)`, b * gone * words)
    put(e.emp, null, ramp(zi, 1.6, 1.97) * gone * words)
    put(e.reply, null, ramp(zi, 1.7, 2) * gone * words)
    if (e.dot) {
      const k = ease(ramp(z, 0.15, 0.7))
      const dx = lerp(38, x + 22 * s, k)
      const dy = lerp(-52, y - 22 * s, k)
      put(e.dot, `translate(${f1(dx)}px, ${f1(dy)}px)`, (1 - ramp(iz * pc, 0, 0.35)) * away * (focused ? 1 - toFull : 1))
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
    const home = L.thumbs.at[l.item] ?? { x: 0, y: 0 }
    const k1 = ease(ramp(P, 0.06 + l.j * 0.03, 0.46))
    const k2 = ease(ramp(P, 0.5, 0.94))
    const flip = ease(ramp(P, 0.12 + l.j * 0.03, 0.48))
    const B = { x: home.x + 84 - 16 - l.j * 21, y: home.y + 46 }
    const x = lerp(lerp(A.x, G.x + 84 * gs - 16 - l.j * 21, k1), B.x, k2)
    const y = lerp(lerp(A.y, G.y + 46 * gs, k1), B.y, k2)
    const focusedAgent = l.agent === st.focus
    const fade = (focusedAgent ? 1 - toFull : 1 - ramp(z, 2, 2.25)) * (1 - ramp(iz * pc, 0, 0.3))
    put(el.node, `translate(${f1(x)}px, ${f1(y)}px) scale(${f4(lerp(lerp(A.s, 1, k1), 1.2, k2))})`, lerp(A.o, 1, ramp(P, 0, 0.3)) * fade)
    put(el.th, `scale(${f4(lerp(A.thsx, 22 / 70, k1))}, ${f4(lerp(A.thsy, 22 / 46, k1))})`, A.th * (1 - ramp(P, 0, 0.25)))
    put(el.coin, `translate(${f1(lerp(A.cx, 0, k1))}px, ${f1(lerp(A.cy, 0, k1))}px) perspective(240px) rotateY(${(180 * flip).toFixed(1)}deg) scale(${lerp(A.cs, 1, k1).toFixed(3)})`)
    if (el.badge) put(el.badge, null, A.o * (1 - ramp(z, 1.25, 1.55)) * (1 - ramp(P, 0, 0.25)))
  }

  // ── the items' own thumbnails: each grows out of its first coin into the grid ──
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
    const out = mine ? 1 - ramp(iz, 0.8, 0.95) : 1 - ramp(iz, 0, 0.3)
    put(el.node, `translate(${f1(lerp(from.x, grid.x, k2))}px, ${f1(lerp(from.y, grid.y, k2))}px) scale(${f4(sx)}, ${f4(sy)})`, ramp(P, 0.04, 0.3) * out)
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
  const top = Math.min(0, ...Object.values(L.crew.at).map((p) => p.y))
  const la = { x: -els.labelW / 2, y: 108 }
  const lb = { x: -L.crew.box.w / 2 + 70, y: top - 90 }
  const lc = { x: -L.thumbs.box.w / 2 + 50, y: L.thumbs.shelfY - 70 }
  const lt = ease(clamp01(z))
  put(els.label, `translate(${f1(lerp(lerp(la.x, lb.x, lt), lc.x, pc))}px, ${f1(lerp(lerp(la.y, lb.y, lt), lc.y, pc))}px)`, (1 - toFull) * (1 - ramp(iz * pc, 0, 0.3)))
  put(els.newCap, `translate(${f1(NEW_POSE.x - 52)}px, ${f1(NEW_POSE.y + 40)}px)`, model.newest ? (1 - ramp(z, 0.05, 0.3)) * (1 - pc) : 0)

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
  const cover = st.dir === 'agents' ? 1 - ramp(z, 2.86, 2.99) : 1 - ramp(I, 0.86, 0.99)
  return { cover, scale: S }
}
