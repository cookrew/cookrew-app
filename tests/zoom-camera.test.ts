// THE ZOOM'S CAMERA ON A PHONE (renderer zoom/zoom-frame.ts · phoneCamera).
// The owner, 2026-11-01: on the phone the crew and the open card were drawn
// far too small (the desktop camera fitted the crew's whole box, with room for
// coins and a card, into 412px). On a narrow screen the crew fills the width
// and scrolls; the open card fills the screen; neither goes past 1:1.
import { describe, expect, it } from 'vitest'
import { layoutOf, phoneCamera, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'

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
  it('fills the screen at 1:1, centred on its agent', () => {
    const L = layoutOf(crewOf(15), true)
    const cam = phoneCamera(L, 2, 'a7', PHONE.w, PHONE.h, 0)
    expect(cam.S).toBe(1)
    const at = L.crew.at.a7
    // The card's middle (260 x 244 from -34, -34 of its agent) is the screen's.
    expect(cam.Ox + (at.x - 34 + 130) * cam.S).toBeCloseTo(PHONE.w / 2)
    expect(cam.Oy + (at.y - 34 + 122) * cam.S).toBeCloseTo(PHONE.h / 2)
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
