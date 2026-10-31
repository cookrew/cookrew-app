// THE OPEN CARD ON A DESKTOP IS READ AT THE CARD STOP (Gauge, 2026-11-01,
// shots/r1/desktop-2-card.png: the card was drawn at the crew's fit, its words
// at ~7px). The camera closes in on the card, as a phone's does: its latest
// lines (zoom.css · .zv-body, 11.5px) at 12px or more on screen, the whole
// card and its remove mark inside the view and above the stop bar.
import { describe, expect, it } from 'vitest'
import { deskCamera, DESK_CARD_S, layoutOf } from '../src/renderer/src/zoom/zoom-frame'
import { fitScale } from '../src/renderer/src/zoom/zoom-layout'
import { modelOf, paintAt } from './zoom-qa-helpers'

/** The overview of a 1440 × 900 window: the header (48) and the dock (57) off. */
const DESK = { w: 1440, h: 795 }
const BODY_PX = 11.5
const STATE_PX = 10

describe('the open card on a desktop', () => {
  it('is drawn large enough to read: body text 12px or more, the state word 12px or more', () => {
    for (const n of [3, 13, 30]) {
      const L = layoutOf(modelOf(n), false)
      const cam = deskCamera(L, 2, 'a7', DESK.w, DESK.h)
      expect(BODY_PX * cam.S).toBeGreaterThanOrEqual(12)
      expect(STATE_PX * cam.S).toBeGreaterThanOrEqual(12)
      expect(cam.S).toBeLessThanOrEqual(DESK_CARD_S)
      // It was the crew's fit with room for a card: ~0.6 for the owner's 13.
      expect(cam.S).toBeGreaterThan(fitScale(L.cardBox, DESK.w, DESK.h))
    }
  })

  it('shows the whole card and its remove mark, above the stop bar', () => {
    for (const [w, h] of [[DESK.w, DESK.h], [1024, 600], [800, 520]]) {
      const L = layoutOf(modelOf(13), false)
      const cam = deskCamera(L, 2, 'a7', w, h)
      const at = L.crew.at.a7
      expect(cam.Ox + (at.x - 34) * cam.S).toBeGreaterThanOrEqual(0)
      expect(cam.Ox + (at.x + 244) * cam.S).toBeLessThanOrEqual(w)
      expect(cam.Oy + (at.y - 46) * cam.S).toBeGreaterThanOrEqual(0)
      // The bar: 14 from the bottom, 50 tall.
      expect(cam.Oy + (at.y + 210) * cam.S).toBeLessThanOrEqual(h - 64)
      expect(BODY_PX * cam.S).toBeGreaterThanOrEqual(12)
    }
  })

  it('frames the crew as before up to the crew stop, and moves without a jump to the card', () => {
    const L = layoutOf(modelOf(13), false)
    const crew = deskCamera(L, 1, 'a7', DESK.w, DESK.h)
    expect(crew.S).toBeCloseTo(fitScale(L.crew.box, DESK.w, DESK.h))
    const card = deskCamera(L, 2, 'a7', DESK.w, DESK.h)
    let last = crew.S
    for (let z = 1.05; z <= 2.0001; z += 0.05) {
      const c = deskCamera(L, z, 'a7', DESK.w, DESK.h)
      expect(c.S).toBeGreaterThanOrEqual(last - 1e-9)
      expect(c.S).toBeLessThanOrEqual(card.S + 1e-9)
      last = c.S
    }
  })

  it('is what the painter draws: the scene at the card stop is at the card camera', () => {
    const { scene } = paintAt(modelOf(13), { sv: 2, w: DESK.w, h: DESK.h, narrow: false, focus: 'a7' })
    expect(BODY_PX * scene.s).toBeGreaterThanOrEqual(12)
  })
})
