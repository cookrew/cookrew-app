// THE OPEN CARD ON A PHONE SITS ON SCREEN WHICHEVER COLUMN ITS AGENT IS IN
// (Gauge, 2026-11-01, shots/r1/phone-dark-2-card.png: Conductor, in the right
// column, had its card's left third cut off; Lark, in the middle, was centred).
// The crew's empty seat stood in a third column when the last row was full, so
// the phone camera, which frames every seat, drew the crew at 0.64 and
// centred on x=139 of 412 (the live crew: one lead and fourteen). On a phone
// the seat now starts a row of its own.
import { describe, expect, it } from 'vitest'
import { layoutOf, phoneCamera } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf, paintAt } from './zoom-qa-helpers'

const PHONE = { w: 412, h: 915 }

describe('the crew on a phone', () => {
  it('keeps the empty seat inside its two columns, full last row or not', () => {
    for (const n of [2, 14, 15, 16]) {
      const L = layoutOf(modelOf(n), true)
      const xs = Object.values(L.crew.at).map((p) => p.x)
      expect(L.crew.next.x).toBeGreaterThanOrEqual(Math.min(-100, ...xs))
      expect(L.crew.next.x).toBeLessThanOrEqual(Math.max(100, ...xs))
    }
  })

  it('is drawn centred and readable when the last row is full (the live crew: a lead and fourteen)', () => {
    const cam = phoneCamera(layoutOf(modelOf(15), true), 1, null, PHONE.w, PHONE.h, 0)
    expect(cam.S).toBeGreaterThan(0.9)
    // The columns at ±100 sit either side of the screen's middle.
    expect(Math.abs(cam.Ox - PHONE.w / 2)).toBeLessThan(12)
  })
})

describe('the open card on a phone', () => {
  it('is on screen for every agent, left, right and middle, at the card stop', () => {
    for (const n of [13, 14, 15]) {
      const model = modelOf(n)
      const L = layoutOf(model, true)
      for (const a of model.agents) {
        const { scene } = paintAt(model, { sv: 2, w: PHONE.w, h: PHONE.h, narrow: true, focus: a.id })
        const at = L.crew.at[a.id]
        const [Ox, Oy] = scene.t
        // The card, 260 x 244 from (-34, -34) of its agent, and its remove mark (to 244 across, 46 up).
        expect(Ox + (at.x - 34) * scene.s).toBeGreaterThanOrEqual(0)
        expect(Ox + (at.x + 244) * scene.s).toBeLessThanOrEqual(PHONE.w)
        expect(Oy + (at.y - 46) * scene.s).toBeGreaterThanOrEqual(0)
        expect(Oy + (at.y + 210) * scene.s).toBeLessThanOrEqual(PHONE.h)
      }
    }
  })
})
