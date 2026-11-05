// READING AN APPLE CODE ON A PHONE MEANS ZOOMING THE PICTURE, HERE, ON THE
// VIEWER. Nothing goes to the Mac, and a tap still lands where the finger is.
import { describe, expect, it } from 'vitest'
import { NO_ZOOM, panZoom, pinchZoom, zoomedFit } from '../src/renderer/src/frame-zoom'
import { viewToFramePoint } from '../src/renderer/src/browser-stream'

const fit = { left: 0, top: 200, width: 400, height: 250 }
const view = { w: 400, h: 650 }

describe('frame zoom', () => {
  it('no zoom is the fit itself', () => {
    expect(zoomedFit(fit, NO_ZOOM)).toEqual(fit)
  })

  it('pinching keeps the point under the fingers where it was', () => {
    const before = viewToFramePoint(100, 300, fit, 1600, 1000)
    const zoom = pinchZoom(NO_ZOOM, fit, view, 4, { x: 100, y: 300 })
    const after = viewToFramePoint(100, 300, zoomedFit(fit, zoom), 1600, 1000)
    expect(after.x).toBeCloseTo(before.x, 3)
    expect(after.y).toBeCloseTo(before.y, 3)
  })

  it('stops at the limits: never smaller than the fit, never past 6x', () => {
    expect(pinchZoom(NO_ZOOM, fit, view, 0.2, { x: 0, y: 0 })).toEqual(NO_ZOOM)
    expect(pinchZoom(NO_ZOOM, fit, view, 50, { x: 0, y: 0 }).k).toBe(6)
  })

  it('a pan cannot lose the picture off the view', () => {
    const zoom = pinchZoom(NO_ZOOM, fit, view, 2, { x: 200, y: 325 })
    const far = zoomedFit(fit, panZoom(zoom, fit, view, 5000, 0))
    expect(far.left).toBeLessThanOrEqual(0)
    expect(far.left + far.width).toBeGreaterThanOrEqual(view.w)
  })

  it('a picture smaller than the view stays centred on that axis', () => {
    const zoomed = zoomedFit(fit, panZoom(pinchZoom(NO_ZOOM, fit, view, 1.5, { x: 200, y: 325 }), fit, view, 0, 900))
    expect(zoomed.top + zoomed.height / 2).toBeCloseTo(view.h / 2, 3)
  })
})
