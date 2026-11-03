// THE ZOOM'S CAMERA ON A PHONE (renderer zoom/zoom-frame.ts · phoneCamera).
// The owner, 2026-11-01: on the phone the crew and the open card were drawn
// far too small (the desktop camera fitted the crew's whole box, with room for
// coins and a card, into 412px). On a narrow screen the crew fills the width
// and scrolls; the open card fills the screen; neither goes past 1:1.
import { describe, expect, it } from 'vitest'
import { deskThumbs, layoutOf, phoneCamera, phoneThumbs, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf, fitScale, shelfPage, shelfPer, SHELF_FACE, SHELF_MORE_GAP, SHELF_STEP } from '../src/renderer/src/zoom/zoom-layout'

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

  it('stacks the faces at the troop’s step, from the grid’s left edge', () => {
    const L = layoutOf(withItems(20, 4), true)
    const page = shelfPage(L.thumbs.shelf, 0)
    const xs = L.thumbs.shelf.order.filter((id) => id in page.x).map((id) => page.x[id])
    // Each face lies over the one before it and shows 16 of the troop's 28 px.
    expect(SHELF_STEP / SHELF_FACE).toBeCloseTo(16 / 28, 1)
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(SHELF_STEP)
    // The first face's edge is the first thumbnail's (two columns 200 apart, 168 wide).
    expect(xs[0] - SHELF_FACE / 2).toBeCloseTo(-(200 + 168) / 2)
  })

  it('holds as many faces a page as fit across the grid, many more than four', () => {
    const phone = layoutOf(withItems(25, 4), true).thumbs.shelf
    const desk = layoutOf(withItems(25, 4), false).thumbs.shelf
    expect(phone.per).toBe(17)
    // A desk's grid is three columns wide: twenty-five fit on one page.
    expect(desk.per).toBe(25)
    // The page and its chip stay inside the grid.
    const page = shelfPage(phone, 0)
    expect(page.more).not.toBeNull()
    expect(page.more!.x + SHELF_FACE / 2).toBeLessThanOrEqual((200 + 168) / 2)
    expect(page.more!.x - Math.max(...Object.values(page.x))).toBe(SHELF_FACE + SHELF_MORE_GAP)
  })

  it('needs no chip when everyone fits, and gives every face a page when they do not', () => {
    expect(shelfPer(3, 368)).toBe(3)
    expect(shelfPage(layoutOf(withItems(3, 4), true).thumbs.shelf, 0).more).toBeNull()
    expect(shelfPer(1000, 10)).toBe(1)
  })

  it('turns a page with "+N", says "–" on the last, and goes back to the first', () => {
    const shelf = layoutOf(withItems(40, 4), true).thumbs.shelf
    const first = shelfPage(shelf, 0)
    expect(Object.keys(first.x)).toHaveLength(17)
    expect(first.more).toMatchObject({ rest: 23, last: false })
    const second = shelfPage(shelf, 1)
    expect(Object.keys(second.x)).toEqual(shelf.order.slice(17, 34))
    expect(second.more).toMatchObject({ rest: 6, last: false })
    const last = shelfPage(shelf, 2)
    expect(Object.keys(last.x)).toEqual(shelf.order.slice(34))
    expect(last.more).toMatchObject({ rest: 0, last: true })
    // The chip follows the page's last face, a short page's too.
    expect(last.more!.x).toBe(shelf.left + 5 * SHELF_STEP + SHELF_FACE + SHELF_MORE_GAP)
    expect(shelfPage(shelf, 3)).toEqual(first)
  })

  it('stands below the label’s band, where the names stood, clear of the first row of thumbnails', () => {
    const T = layoutOf(withItems(20, 4), true).thumbs
    expect(T.shelf.y).toBeGreaterThan(T.shelfY)
    // The first row's thumbnails are 108 tall about y 0.
    expect(T.shelf.y + SHELF_FACE / 2).toBeLessThan(-54 - 20)
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
    // A mark is drawn at 0.62 inside the device (zoom-frame.ts · SWS); the zoom view is the screen less the header and the dock.
    expect(32 * fitScale(d.box, PHONE.w, PHONE.h) * 0.62).toBeGreaterThanOrEqual(10)
    expect(32 * fitScale(d.box, 375, 812 - 150) * 0.62).toBeGreaterThanOrEqual(10)
  })
})
