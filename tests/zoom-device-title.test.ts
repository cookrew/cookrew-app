// THE DEVICE'S TITLE STAYS CLEAR OF THE GRID (Gauge, 2026-11-01,
// shots/r3/phone-0-device.png: the hint's wrapped second line, "thumbnails",
// ran into the first workspace's tile). The title now ends above the first
// row's tiles and grows upward, and the device keeps room for it.
import { describe, expect, it } from 'vitest'
import { deviceWords } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf } from '../src/renderer/src/zoom/zoom-layout'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)
/** zoom.css · .zv-device-label at its tallest: name (24) + count (11) + two hint lines (2 × 14.3), 6px apart. */
const TALLEST = { narrow: 24 + 6 + 11 + 6 + 2 * 14.3, wide: 24 + 6 + 14.3 }
/** A mark's tile reaches 96 above its centre (its wash at SWS). */
const TILE = 96

describe("the device's title", () => {
  for (const [w, h, narrow] of [[412, 760, true], [375, 680, true], [1440, 795, false], [1024, 600, false]] as const) {
    it(`${w}x${h}: ends above the first row's tiles and starts inside the frame`, () => {
      for (const n of [2, 3, 7, 12]) {
        const device = deviceOf(ids(n), narrow)
        const words = deviceWords(device, w, h, narrow)
        const firstRow = Math.min(...Object.values(device.at).map((p) => p.y))
        expect(device.titleBottom).toBeLessThanOrEqual(firstRow - TILE - 8)
        const top = device.titleBottom - (narrow ? TALLEST.narrow : TALLEST.wide) * words.titleK
        // On screen: the device's camera fits its box.
        const Oy = h / 2 - device.box.cy * words.cam
        expect(Oy + top * words.cam).toBeGreaterThanOrEqual(0)
      }
    })
  }

  it('is anchored by its bottom, growing up from there', async () => {
    const { readFileSync } = await import('node:fs')
    // The painter places it (zoom-frame.ts · paintDeviceWords): on a phone it keeps one size as the device zooms.
    const frame = readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')
    expect(frame).toContain('${f1(L.device.titleBottom)}px) scale(${f4(d.dw.titleK * back)}) translateY(-100%)')
  })
})
