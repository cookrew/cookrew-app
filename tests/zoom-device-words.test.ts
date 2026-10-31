// THE DEVICE STOP'S WORDS ARE READ (Gauge, 2026-11-01): on a desktop the
// workspaces' names and counts read at ~6px (shots/desktop-0-device.png); on
// a phone the hint "agents open the crew · browsers open thumbnails" ran off
// the right edge (shots/phone-0-device.png). Names 10px or more on a desktop;
// the hint wraps inside the screen.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceWords, DEVICE_TEXT_PX, SWS } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf } from '../src/renderer/src/zoom/zoom-layout'
import { modelOf, paintAt } from './zoom-qa-helpers'

const DESK = { w: 1440, h: 795 }
const PHONE = { w: 412, h: 760 }
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)

describe('the device stop on a desktop', () => {
  it("draws the other workspaces' names at 10px or more, for few and many workspaces", () => {
    for (const n of [2, 7, 10, 14]) {
      const device = deviceOf(ids(n), false)
      const words = deviceWords(device, DESK.w, DESK.h, false)
      // zoom.css · .zv-mark-label: 11px, in a mark at SWS, in the device at its fit.
      expect(11 * words.markK * SWS * words.cam).toBeGreaterThanOrEqual(10)
      // Cut short before the next mark's label: the label is centred under its mark, dx apart.
      expect(words.markMax * words.markK * SWS * words.cam).toBeLessThan(device.dx * words.cam)
    }
  })

  it('draws the open workspace’s name and counts at 10px or more, no wider than its neighbours’', () => {
    const { label } = paintAt(modelOf(13, 7), { sv: -1, w: DESK.w, h: DESK.h, narrow: false })
    const device = deviceOf(ids(7), false)
    const words = deviceWords(device, DESK.w, DESK.h, false)
    expect(11 * label.k * SWS * words.cam).toBeGreaterThanOrEqual(10)
    expect(label.right - label.left).toBeLessThanOrEqual(device.dx * words.cam)
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
  it("keeps the marks' labels as the phone evals set them (32px, 380 wide) and the open one at ~2.9", () => {
    const words = deviceWords(deviceOf(ids(7), true), PHONE.w, PHONE.h, true)
    expect(words.markK).toBe(1)
    expect(words.markMax).toBeCloseTo(380, -1)
    expect(words.openK).toBeCloseTo(2.9, 1)
  })

  it('ends the title and its hint inside the screen: they wrap within the device', () => {
    for (const n of [3, 7, 12]) {
      const device = deviceOf(ids(n), true)
      const words = deviceWords(device, PHONE.w, PHONE.h, true)
      // The device is centred; its title starts 50 in from the left of its box.
      const left = PHONE.w / 2 + (-device.box.w / 2 + 50) * words.cam
      const right = left + words.titleMax * words.titleK * words.cam
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeLessThanOrEqual(PHONE.w)
      expect(11 * words.titleK * words.cam).toBeGreaterThanOrEqual(10)
    }
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    expect(css).toMatch(/\.zv-device-label \{[^}]*flex-wrap: wrap;[^}]*width: max-content;[^}]*transform-origin: 0 0;/)
    expect(css).toMatch(/\.zv-device-label small \{[^}]*white-space: normal;/)
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain('scale(${words.titleK.toFixed(4)}) translateY(-100%)`, maxWidth: Math.round(words.titleMax)')
    expect(view).toContain("label.style.maxWidth = `${Math.round(words.markMax)}px`")
  })
})
