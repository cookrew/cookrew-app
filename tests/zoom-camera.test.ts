// THE ZOOM'S CAMERA ON A PHONE (renderer zoom/zoom-frame.ts · phoneCamera).
// The owner, 2026-11-01: on the phone the crew and the open card were drawn
// far too small (the desktop camera fitted the crew's whole box, with room for
// coins and a card, into 412px). On a narrow screen the crew fills the width
// and scrolls; the open card fills the screen; neither goes past 1:1.
import { describe, expect, it } from 'vitest'
import { layoutOf, phoneCamera, phoneThumbs, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf, fitScale } from '../src/renderer/src/zoom/zoom-layout'

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

  it('the shelf of agents wraps into rows a name can be read in, never a pile', () => {
    const L = layoutOf(withItems(20, 4), true)
    const rows = new Map<number, number[]>()
    for (const p of Object.values(L.thumbs.shelf)) rows.set(p.y, [...(rows.get(p.y) ?? []), p.x])
    for (const xs of rows.values()) {
      const sorted = [...xs].sort((a, b) => a - b)
      // A phone's name is at most 112px, drawn at 0.78 on the shelf.
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(112 * 0.78)
    }
    expect(rows.size).toBeGreaterThan(1)
    // The label stands above the shelf's top row.
    expect(L.thumbs.shelfY).toBe(Math.min(...rows.keys()))
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
