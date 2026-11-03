// THE WORKSPACE LABEL STAYS ON SCREEN (Gauge, 2026-11-01): "13 COOKREW DEV
// 216 83" stood partly off the left edge on a desktop at the card stop
// (shots/r1/desktop-2-card.png) and on a phone at the crew stop
// (shots/phone-1-crew.png).
import { describe, expect, it } from 'vitest'
import { crewLabelAt, keepOnScreen, layoutOf, phoneCamera } from '../src/renderer/src/zoom/zoom-frame'
import { LABEL, modelOf, paintAt } from './zoom-qa-helpers'

const DESK = { w: 1440, h: 795 }
const PHONE = { w: 412, h: 760 }

const inside = (l: { left: number; right: number; top: number; bottom: number }, w: number, h: number): void => {
  expect(l.left).toBeGreaterThanOrEqual(0)
  expect(l.right).toBeLessThanOrEqual(w)
  expect(l.top).toBeGreaterThanOrEqual(0)
  expect(l.bottom).toBeLessThanOrEqual(h)
}

describe('the workspace label', () => {
  it('is inside the screen at every stop on a desktop, the card stop included', () => {
    for (const sv of [-1, 1, 2]) {
      for (const focus of ['a0', 'a7', 'a12']) inside(paintAt(modelOf(13), { sv, w: DESK.w, h: DESK.h, narrow: false, focus }).label, DESK.w, DESK.h)
    }
  })

  it('is inside the screen at every stop on a phone, the crew stop included', () => {
    for (const sv of [-1, 1, 2]) inside(paintAt(modelOf(13), { sv, w: PHONE.w, h: PHONE.h, narrow: true, focus: 'a7' }).label, PHONE.w, PHONE.h)
  })

  it('on a phone the crew camera frames it with the faces, so it is not pinned over them', () => {
    const L = layoutOf(modelOf(13), true)
    const cam = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 0)
    const at = crewLabelAt(L, true)
    expect(cam.Ox + at.x * cam.S).toBeGreaterThanOrEqual(0)
    expect(cam.Oy + at.y * cam.S).toBeGreaterThanOrEqual(0)
    // Its own place is already on screen: keeping it there moves nothing.
    const kept = keepOnScreen({ ...at, ...LABEL, k: 1 }, cam, PHONE.w, PHONE.h)
    expect(kept.x).toBeCloseTo(at.x)
    expect(kept.y).toBeCloseTo(at.y)
  })

  it('scrolls away with the crew, as the faces do', () => {
    const top = paintAt(modelOf(13), { sv: 1, w: PHONE.w, h: PHONE.h, narrow: true, pan: 0 })
    const down = paintAt(modelOf(13), { sv: 1, w: PHONE.w, h: PHONE.h, narrow: true, pan: 100 })
    expect(top.out.panMax).toBeGreaterThan(100)
    expect(top.label.top - down.label.top).toBeCloseTo(100, 0)
  })

  it('is moved only as far as it must be', () => {
    const cam = { S: 2, Ox: 0, Oy: 0 }
    // 40 px off the left: moved back to the margin, its y untouched.
    const kept = keepOnScreen({ x: -20, y: 100, w: 100, h: 20, k: 1 }, cam, 800, 600)
    expect(kept.x * 2).toBeCloseTo(12)
    expect(kept.y).toBeCloseTo(100)
  })
})
