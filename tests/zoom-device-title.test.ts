// THE DEVICE'S TITLE STAYS CLEAR OF THE GRID (Gauge, 2026-11-01,
// shots/r3/phone-0-device.png; owner, 2026-11-04: on a 320px phone it slid
// under the per-row pill). It ends above the first row of tiles, grows upward,
// and the device keeps room for it; on a phone it stands in the page's head.
import { describe, expect, it } from 'vitest'
import { deviceCam, deviceWords } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf } from '../src/renderer/src/zoom/zoom-layout'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)
/** zoom.css · .zv-device-label at its tallest: the name over its count on a phone, side by side on a desk. */
const TALLEST = { narrow: 18 + 6 + 11, wide: 30 }

describe("the device's title", () => {
  for (const [w, h] of [[412, 760], [375, 680], [320, 640]] as const) {
    it(`${w}x${h}: stands in the head, over the tiles and inside the frame`, () => {
      for (const n of [2, 3, 7, 12]) {
        const device = deviceOf(ids(n), true)
        const cam = deviceCam(device, w, h, true)
        // zoom-frame.ts · paintDeviceWords: 12px over the first row, on screen.
        const foot = cam.Oy + device.gridTop * cam.S - 12
        expect(foot - TALLEST.narrow).toBeGreaterThanOrEqual(0)
      }
    })
  }

  for (const [w, h] of [[1440, 795], [1024, 600]] as const) {
    it(`${w}x${h}: ends above the first row's tiles and starts inside the frame`, () => {
      for (const n of [2, 3, 7, 12]) {
        const device = deviceOf(ids(n), false)
        const words = deviceWords(device, w, h, false)
        const cam = deviceCam(device, w, h, false)
        expect(device.titleBottom).toBeLessThanOrEqual(device.gridTop - 8)
        const top = device.titleBottom - TALLEST.wide * words.titleK
        expect(cam.Oy + top * cam.S).toBeGreaterThanOrEqual(0)
      }
    })
  }

  it('is anchored by its bottom, growing up from there', async () => {
    const { readFileSync } = await import('node:fs')
    // The painter places it (zoom-frame.ts · paintDeviceWords): on a phone it keeps one size as the device zooms.
    const frame = readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')
    expect(frame).toContain('${f1(titleY)}px) scale(${f4(d.dw.titleK * back)}) translateY(-100%)')
  })
})
