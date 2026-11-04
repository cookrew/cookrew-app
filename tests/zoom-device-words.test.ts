// THE DEVICE STOP'S WORDS ARE READ (Gauge, 2026-11-01): on a desktop the
// workspaces' names and counts read at ~6px (shots/desktop-0-device.png).
// Names 10px or more on a desktop; a tile's words stay inside its frame
// (workspace-tile.css), and a phone's title stops short of the per-row pill.
import { PHONE_TYPE } from '../src/renderer/src/zoom/scene-words'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceWords, DEVICE_TEXT_PX, SWS } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf } from '../src/renderer/src/zoom/zoom-layout'

const DESK = { w: 1440, h: 795 }
const PHONE = { w: 412, h: 760 }
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)

describe('the device stop on a desktop', () => {
  it("draws a tile's words at 10px or more, for few and many workspaces", () => {
    for (const n of [2, 7, 10, 14]) {
      const device = deviceOf(ids(n), false)
      const words = deviceWords(device, DESK.w, DESK.h, false)
      // workspace-tile.css · .zv-tile-cap: 10px at least, in a mark at SWS, in the device at its fit.
      expect(11 * words.markK * SWS * words.cam).toBeGreaterThanOrEqual(10)
    }
  })

  it("draws the machine's words at 11px or more, inside the device's width", () => {
    const device = deviceOf(ids(7), false)
    const words = deviceWords(device, DESK.w, DESK.h, false)
    expect(11 * words.titleK * words.cam).toBeGreaterThanOrEqual(DEVICE_TEXT_PX - 1e-9)
    expect(words.titleMax * words.titleK).toBeLessThanOrEqual(device.box.w - 100 + 1e-6)
  })

  it('keeps a size that already reads: nothing shrinks', () => {
    const words = deviceWords(deviceOf(ids(1), false), 2560, 1400, false)
    expect(words.markK).toBeGreaterThanOrEqual(1)
    expect(words.titleK).toBeGreaterThanOrEqual(1)
  })
})

describe('the device stop on a phone', () => {
  // The phone's type scale (phone-type.css, owner 2026-11-02): the 32px labels are pinned at
  // caption on screen, a little under 1:1 here, as wide as before; the open one as large as theirs.
  // The phone's own type (phone-type.css, 2026-11-03): its labels are drawn 1:1 on screen at the
  // workspaces stop, cut before a neighbour's; the open one (11px type) at caption, as large.
  it("draws a tile's words 1:1 on screen", () => {
    const device = deviceOf(ids(7), true)
    const words = deviceWords(device, PHONE.w, PHONE.h, true)
    expect(words.markK * SWS * words.cam).toBeCloseTo(1, 6)
    expect(words.titleK * words.cam).toBeCloseTo(1, 6)
  })

  it('cuts a name at the frame and keeps the title on its line', () => {
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    expect(css).toMatch(/\.zv-device-label \{[^}]*width: max-content;[^}]*transform-origin: 0 0;/)
    const tile = readFileSync('src/renderer/src/zoom/workspace-tile.css', 'utf8')
    expect(tile).toMatch(/\.zv-tile-name \{[^}]*max-width: calc\(430px \/ var\(--zv-k, 1\)[^}]*text-overflow: ellipsis;/)
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain("ref={bind('deviceLabel')} style={{ maxWidth: Math.round(words.titleMax) }}")
    expect(readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')).toContain('scale(${f4(d.dw.titleK * back)}) translateY(-100%)')
  })
})
