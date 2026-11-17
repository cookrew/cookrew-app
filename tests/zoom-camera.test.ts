// THE ZOOM'S CAMERA ON A PHONE (renderer zoom/zoom-frame.ts · phoneCamera).
// The owner, 2026-11-01: on the phone the crew and the open card were drawn
// far too small (the desktop camera fitted the crew's whole box, with room for
// coins and a card, into 412px). On a narrow screen the crew fills the width
// and scrolls; the open card fills the screen; neither goes past 1:1.
import { describe, expect, it } from 'vitest'
import { deskThumbs, layoutOf, phoneCamera, phoneThumbs, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf, fitScale, shelfRow } from '../src/renderer/src/zoom/zoom-layout'
import { GROUP_FACE, GROUP_SEAL_GAP, GROUP_STEP } from '../src/renderer/src/zoom/agents-group'
import { deviceCam } from '../src/renderer/src/zoom/zoom-camera'

const crewOf = (n: number): FrameModel => ({
  agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, preset: 'Claude Code', orch: false, waiting: false })),
  items: [],
  links: [],
  ties: [],
  workspaces: ['w1'],
  otherMachines: 0,
  active: 'w1',
  newest: null
}) as unknown as FrameModel

const PHONE = { w: 412, h: 760 }

describe('the crew on a phone', () => {
  it('stands in two columns at a readable size, not three at 0.4', () => {
    const L = layoutOf(crewOf(15), true)
    const perRow = new Map<number, number>()
    for (const p of Object.values(L.crew.at)) perRow.set(p.y, (perRow.get(p.y) ?? 0) + 1)
    expect(Math.max(...perRow.values())).toBe(2)
    const cam = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 0)
    expect(cam.S).toBeGreaterThan(0.9)
  })

  it('scrolls when it is taller than the screen, from the top, and no further than its end', () => {
    const L = layoutOf(crewOf(15), true)
    const top = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 0)
    expect(top.panMax).toBeGreaterThan(0)
    const down = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 200)
    expect(top.Oy - down.Oy).toBeCloseTo(200)
    const past = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 1e6)
    expect(top.Oy - past.Oy).toBeCloseTo(top.panMax)
  })

  it('a crew that fits is centred and does not scroll', () => {
    const cam = phoneCamera(layoutOf(crewOf(3), true), 1, null, PHONE.w, PHONE.h, 300)
    expect(cam.panMax).toBe(0)
  })
})

describe('the open card on a phone', () => {
  it("fills the screen's width (2026-11-01 phone evals: at 1:1 it took 63%), centred on its agent", () => {
    const L = layoutOf(crewOf(15), true)
    const cam = phoneCamera(L, 2, 'a7', PHONE.w, PHONE.h, 0)
    expect(260 * cam.S).toBeGreaterThanOrEqual(0.85 * PHONE.w)
    expect(cam.S).toBeLessThanOrEqual(1.5)
    const at = L.crew.at.a7
    // The card (260 x 244 from -34, -34 of its agent) and its remove mark (to 244 across, 46 up) are all on screen.
    expect(cam.Ox + (at.x - 34) * cam.S).toBeGreaterThanOrEqual(0)
    expect(cam.Ox + (at.x + 244) * cam.S).toBeLessThanOrEqual(PHONE.w)
    expect(cam.Oy + (at.y - 46) * cam.S).toBeGreaterThanOrEqual(0)
    expect(cam.Oy + (at.y + 210) * cam.S).toBeLessThanOrEqual(PHONE.h)
  })

  it('moves with the zoom between the crew and the card, never jumping', () => {
    const L = layoutOf(crewOf(15), true)
    const a = phoneCamera(L, 1.5, 'a7', PHONE.w, PHONE.h, 0)
    const crew = phoneCamera(L, 1, 'a7', PHONE.w, PHONE.h, 0)
    const card = phoneCamera(L, 2, 'a7', PHONE.w, PHONE.h, 0)
    expect(a.S).toBeGreaterThan(Math.min(crew.S, card.S) - 1e-9)
    expect(a.S).toBeLessThan(Math.max(crew.S, card.S) + 1e-9)
  })
})

const withItems = (agents: number, items: number): FrameModel => {
  const m = crewOf(agents) as unknown as { agents: { id: string }[] }
  return {
    ...m,
    items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, kind: 'browser', owners: [m.agents[i % agents].id] }))
  } as unknown as FrameModel
}

describe('the thumbnails on a phone', () => {
  it('fill the width in two columns at a readable size, and a tall grid scrolls', () => {
    const L = layoutOf(withItems(20, 24), true)
    const cam = phoneThumbs(L.thumbs.box, PHONE.w, PHONE.h, 0)
    // A thumbnail is 168 wide: at least 140 on the screen.
    expect(168 * cam.S).toBeGreaterThanOrEqual(140)
    expect(cam.panMax).toBeGreaterThan(0)
    const past = phoneThumbs(L.thumbs.box, PHONE.w, PHONE.h, 1e6)
    expect(cam.Oy - past.Oy).toBeCloseTo(cam.panMax)
  })

})

// THE SHELF IS THE AGENTS' GROUP (owner, 2026-11-03): over the artifacts the
// agents stand as the troop does, each face over the one before it, a page at a
// time behind a "+N" chip, as many a page as fit across the grid ("four is too few").
describe('the shelf of agents over the thumbnails', () => {
  it('is one row in the crew’s order, those that carry something first', () => {
    const L = layoutOf(withItems(20, 4), false)
    // Four items carried by a0..a3: they lead, the sixteen others follow.
    expect(L.thumbs.shelf.order.slice(0, 4)).toEqual(['a0', 'a1', 'a2', 'a3'])
    expect(L.thumbs.shelf.order).toHaveLength(20)
  })

  it('sets the faces the agents group’s step apart, none over another, from the grid’s left edge', () => {
    const L = layoutOf(withItems(20, 4), true)
    const row = shelfRow(L.thumbs.shelf, 0, 1)
    const xs = L.thumbs.shelf.order.map((id) => row.x[id])
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(GROUP_STEP)
    expect(GROUP_STEP).toBeGreaterThan(GROUP_FACE)
    // The first face's edge is the first thumbnail's (two columns 200 apart, 168 wide).
    expect(xs[0] - GROUP_FACE / 2).toBeCloseTo(-(200 + 168) / 2)
  })

  it('keeps 36 px on screen whatever the camera: a screen px is k scene px', () => {
    const shelf = layoutOf(withItems(20, 4), false).thumbs.shelf
    const at1 = shelfRow(shelf, 0, 1)
    const at2 = shelfRow(shelf, 0, 2)
    expect(at2.x[shelf.order[1]] - at2.x[shelf.order[0]]).toBe(2 * GROUP_STEP)
    // Twice as many scene px a face: half as many fit across the same grid.
    expect(at2.per).toBeLessThan(at1.per)
  })

  it('shows as many faces as fit with the seal after them, and every face when they do', () => {
    const phone = shelfRow(layoutOf(withItems(25, 4), true).thumbs.shelf, 0, 1)
    // (368 − the seal's 30 − a face) / 42, and the first face.
    expect(phone.per).toBe(8)
    expect(phone.max).toBe(17)
    const few = shelfRow(layoutOf(withItems(3, 4), true).thumbs.shelf, 0, 1)
    expect(few.per).toBe(3)
    expect(few.max).toBe(0)
    expect(Object.values(few.o)).toEqual([1, 1, 1])
  })

  it('stands the seal after the last face shown, inside the grid', () => {
    const shelf = layoutOf(withItems(25, 4), true).thumbs.shelf
    const row = shelfRow(shelf, 0, 1)
    const last = row.x[shelf.order[row.per - 1]]
    expect(row.seal).toBe(last + GROUP_FACE / 2 + GROUP_SEAL_GAP)
    expect(row.seal + 18).toBeLessThanOrEqual(shelf.left + shelf.span)
    const few = shelfRow(layoutOf(withItems(2, 4), true).thumbs.shelf, 0, 1)
    expect(few.seal).toBe(few.x[layoutOf(withItems(2, 4), true).thumbs.shelf.order[1]] + GROUP_FACE / 2 + GROUP_SEAL_GAP)
  })

  it('scrolls along instead of turning pages: the faces past its ends fade, the scroll is clamped', () => {
    const shelf = layoutOf(withItems(40, 4), true).thumbs.shelf
    const at0 = shelfRow(shelf, 0, 1)
    expect(at0.o[shelf.order[0]]).toBe(1)
    expect(at0.o[shelf.order[at0.per - 1]]).toBe(1)
    expect(at0.o[shelf.order[at0.per + 1]]).toBe(0)
    const at3 = shelfRow(shelf, 3, 1)
    expect(at3.x[shelf.order[3]]).toBe(at0.x[shelf.order[0]])
    expect(at3.o[shelf.order[0]]).toBe(0)
    // Half a face past the start: the face leaving is half gone, not hidden.
    const half = shelfRow(shelf, 0.5, 1)
    expect(half.o[shelf.order[0]]).toBeGreaterThan(0)
    expect(half.o[shelf.order[0]]).toBeLessThan(1)
    expect(shelfRow(shelf, 999, 1).x).toEqual(shelfRow(shelf, at0.max, 1).x)
    expect(shelfRow(shelf, -5, 1).x).toEqual(at0.x)
  })

  it('stands below the label’s band, where the names stood, clear of the first row of thumbnails', () => {
    const T = layoutOf(withItems(20, 4), true).thumbs
    expect(T.shelf.y).toBeGreaterThan(T.shelfY)
    // The first row's thumbnails are 108 tall about y 0.
    expect(T.shelf.y + GROUP_FACE / 2).toBeLessThan(-54 - 20)
  })

  it('never widens the view: the box is the grid’s, however many agents there are', () => {
    expect(layoutOf(withItems(40, 4), false).thumbs.box.w).toBe(layoutOf(withItems(2, 4), false).thumbs.box.w)
    expect(layoutOf(withItems(40, 4), true).thumbs.box.w).toBe(400)
  })
})

// EVERY ARTIFACT, SCROLLED (owner, 2026-11-02): the desktop grid held twelve.
describe('the thumbnails on a desktop', () => {
  const DESK = { w: 1440, h: 860 }

  it('frames a grid of four rows or fewer whole, as before, without a scroll', () => {
    const L = layoutOf(withItems(4, 12), false)
    const cam = deskThumbs(L.thumbs, DESK.w, DESK.h, 0)
    expect(cam.panMax).toBe(0)
    expect(cam.S).toBeCloseTo(fitScale(L.thumbs.box, DESK.w, DESK.h))
    expect(cam.Oy).toBeCloseTo(DESK.h / 2 - L.thumbs.box.cy * cam.S)
  })

  it('draws three hundred at the scale of twelve and scrolls from the top to the last row, above the bar', () => {
    const few = deskThumbs(layoutOf(withItems(4, 12), false).thumbs, DESK.w, DESK.h, 0)
    const L = layoutOf(withItems(4, 300), false)
    const top = deskThumbs(L.thumbs, DESK.w, DESK.h, 0)
    expect(top.S).toBeCloseTo(few.S)
    expect(top.panMax).toBeGreaterThan(0)
    // At the top the shelf's label is on screen.
    expect(top.Oy + (L.thumbs.shelfY - 70) * top.S).toBeGreaterThan(0)
    const end = deskThumbs(L.thumbs, DESK.w, DESK.h, 1e9)
    expect(top.Oy - end.Oy).toBeCloseTo(top.panMax)
    // The last row's titles (54 + 60 below its centre) end above the stop bar (72 from the bottom).
    const lastY = Math.max(...Object.values(L.thumbs.at).map((p) => p.y))
    expect(end.Oy + (lastY + 114) * end.S).toBeLessThanOrEqual(DESK.h - 72)
  })
})

describe('the device on a phone', () => {
  it('draws its workspaces large enough that a label set at 32px reads at 10px, down to a 375 x 812 phone', () => {
    const d = deviceOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], true)
    // A mark is drawn at 0.62 inside the device (zoom-frame.ts · SWS); the phone's camera fills the width and scrolls the rest.
    expect(32 * deviceCam(d, PHONE.w, PHONE.h, true).S * 0.62).toBeGreaterThanOrEqual(10)
    expect(32 * deviceCam(d, 375, 812 - 150, true).S * 0.62).toBeGreaterThanOrEqual(10)
  })
})
