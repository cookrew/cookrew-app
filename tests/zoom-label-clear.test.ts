// THE WORKSPACE LABEL NEVER COVERS A FACE OR A NAME (Gauge, 2026-11-01,
// shots/r3: clamped into the corner at the card stop it sat on Moss's face
// on a desktop, desktop-dock-made.png, and on Forge's on a phone,
// phone-2-card.png). At the card stop it takes the first free place that
// stop's camera leaves on screen (zoom-frame.ts · cardStopLabel), or fades.
import { describe, expect, it } from 'vitest'
import { cardStopTaken, layoutOf, type Rect } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf, paintAt } from './zoom-qa-helpers'

/** The label as the live app measures it: one line on a desktop, two in 130px on a phone. */
const SIZES = [
  { name: 'desktop', w: 1440, h: 795, narrow: false, label: { w: 223, h: 24 } },
  { name: 'phone 412', w: 412, h: 760, narrow: true, label: { w: 130, h: 50 } },
  { name: 'phone 375', w: 375, h: 680, narrow: true, label: { w: 130, h: 50 } }
]
const hit = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

describe('the workspace label at the card stop', () => {
  for (const size of SIZES) {
    it(`${size.name}: is on screen and clear of every face, name and the card, for every agent's card`, () => {
      for (const n of [3, 13, 15, 16]) {
        const model = modelOf(n)
        for (const a of model.agents) {
          const { label, scene, L } = paintAt(model, { sv: 2, w: size.w, h: size.h, narrow: size.narrow, focus: a.id }, size.label)
          if (label.o < 0.05) continue
          expect(label.left).toBeGreaterThanOrEqual(0)
          expect(label.right).toBeLessThanOrEqual(size.w)
          expect(label.top).toBeGreaterThanOrEqual(0)
          expect(label.bottom).toBeLessThanOrEqual(size.h)
          const taken = cardStopTaken(L, a.id, { S: scene.s, Ox: scene.t[0], Oy: scene.t[1] })
          for (const t of taken) expect(hit(label, t)).toBe(false)
        }
      }
    })
  }

  it("is shown, not faded, in the cases Gauge shot: the live crew (a lead and fourteen), Conductor's card in the right column", () => {
    const model = modelOf(15)
    // a4 is the fourth after the lead: the second row's right column, as Conductor stands live.
    for (const size of SIZES.slice(0, 2)) expect(paintAt(model, { sv: 2, w: size.w, h: size.h, narrow: size.narrow, focus: 'a4' }, size.label).label.o).toBe(1)
    // A desktop has room beside the card for any agent's.
    for (const a of model.agents) expect(paintAt(model, { sv: 2, w: SIZES[0].w, h: SIZES[0].h, narrow: false, focus: a.id }, SIZES[0].label).label.o).toBe(1)
  })

  it('fades, rather than cover a face, where a phone screen has no free place (rows full above and below the card)', () => {
    const { label } = paintAt(modelOf(15), { sv: 2, w: 412, h: 760, narrow: true, focus: 'a5' }, { w: 130, h: 50 })
    expect(label.o).toBe(0)
  })
})

describe('the workspace label at the crew stop', () => {
  for (const size of SIZES) {
    it(`${size.name}: sits clear of every face and name`, () => {
      for (const n of [3, 13, 15, 16]) {
        const model = modelOf(n)
        const { label, scene } = paintAt(model, { sv: 1, w: size.w, h: size.h, narrow: size.narrow }, size.label)
        const L = layoutOf(model, size.narrow)
        const taken = cardStopTaken(L, null, { S: scene.s, Ox: scene.t[0], Oy: scene.t[1] })
        for (const t of taken) expect(hit(label, t)).toBe(false)
      }
    })
  }
})
