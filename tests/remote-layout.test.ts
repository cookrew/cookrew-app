// THE BAR NEVER STANDS ON THE PICTURE (renderer/use/remote-layout.ts): a band of
// its own, the picture fitted to what is left, its aspect kept; a pill beside the
// picture where a row would cost more of it; and the same layout in both modes.
import { describe, expect, it } from 'vitest'
import { fitContain } from '../src/renderer/src/browser-frame'
import { NO_ZOOM, panZoom, pinchZoom } from '../src/renderer/src/frame-zoom'
import { hitArea, MIN_ROW_WIDTH, PILL_WIDTH, pictureFit, remoteLayout, type Rect } from '../src/renderer/src/use/remote-layout'

const screen = { w: 1280, h: 800 }
const overlaps = (a: Rect, b: Rect): boolean => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.left >= outer.left - 1e-9 && inner.top >= outer.top - 1e-9 && inner.left + inner.width <= outer.left + outer.width + 1e-9 && inner.top + inner.height <= outer.top + outer.height + 1e-9

describe('remoteLayout', () => {
  it('no bar: the picture has the whole view, as today', () => {
    expect(remoteLayout({ w: 640, h: 420 }, screen, null)).toEqual({ band: null, area: { left: 0, top: 0, width: 640, height: 420 } })
  })

  it('a desktop card: the bar is a row on top and the picture fits below it, aspect kept', () => {
    const layout = remoteLayout({ w: 640, h: 420 }, screen, 44)
    expect(layout.band).toEqual({ place: 'row', rect: { left: 0, top: 0, width: 640, height: 44 } })
    expect(layout.area).toEqual({ left: 0, top: 44, width: 640, height: 376 })
    const picture = pictureFit(layout, screen, NO_ZOOM)
    expect(picture.width / picture.height).toBeCloseTo(1280 / 800, 6)
    expect(overlaps(picture, layout.band!.rect)).toBe(false)
    expect(inside(picture, layout.area)).toBe(true)
  })

  it('a phone held upright: a row, and the picture keeps its full width', () => {
    const layout = remoteLayout({ w: 390, h: 760 }, screen, 52)
    expect(layout.band?.place).toBe('row')
    const picture = pictureFit(layout, screen, NO_ZOOM)
    expect(picture.width).toBeCloseTo(390, 6)
    expect(overlaps(picture, layout.band!.rect)).toBe(false)
  })

  it('a phone on its side: a row would cost more of the picture than a pill beside it', () => {
    const view = { w: 844, h: 390 }
    const layout = remoteLayout(view, screen, 52)
    expect(layout.band).toEqual({ place: 'pill', rect: { left: 844 - PILL_WIDTH, top: 0, width: PILL_WIDTH, height: 390 } })
    const picture = pictureFit(layout, screen, NO_ZOOM)
    expect(overlaps(picture, layout.band!.rect)).toBe(false)
    const asRow = fitContain(screen.w, screen.h, view.w, view.h - 52)
    expect(picture.width * picture.height).toBeGreaterThan(asRow.width * asRow.height)
  })

  it('a card stays a row even with a two-line bar, where a pill would win by only a few per cent', () => {
    expect(remoteLayout({ w: 640, h: 420 }, screen, 66).band?.place).toBe('row')
    expect(remoteLayout({ w: 1100, h: 700 }, screen, 66).band?.place).toBe('row')
  })

  it('too narrow for a row of buttons is a pill', () => {
    expect(remoteLayout({ w: MIN_ROW_WIDTH - 1, h: 900 }, screen, 44).band?.place).toBe('pill')
  })

  it('no picture yet is a row: nothing to weigh, and it is where the bar will most likely stay', () => {
    expect(remoteLayout({ w: 844, h: 390 }, { w: 0, h: 0 }, 44).band?.place).toBe('row')
  })

  it('a bar taller than the view never leaves a negative picture', () => {
    const layout = remoteLayout({ w: 400, h: 30 }, screen, 44)
    expect(layout.area.height).toBeGreaterThanOrEqual(0)
  })

  it('the same view, picture and bar give the same layout whatever the mode: the picture never jumps under a finger', () => {
    // The mode is not an input at all: taking control changes none of these.
    for (const view of [{ w: 640, h: 420 }, { w: 390, h: 760 }, { w: 844, h: 390 }]) {
      expect(remoteLayout(view, screen, 52)).toEqual(remoteLayout(view, screen, 52))
    }
  })
})

describe('pictureFit: zoom lives inside the area', () => {
  const layout = remoteLayout({ w: 640, h: 420 }, screen, 44)

  it('panned as far up as it goes, the top of the picture stops at the bottom of the bar', () => {
    const base = fitContain(screen.w, screen.h, layout.area.width, layout.area.height)
    const view = { w: layout.area.width, h: layout.area.height }
    const zoom = panZoom(pinchZoom(NO_ZOOM, base, view, 3, { x: 0, y: 0 }), base, view, 0, 10_000)
    expect(pictureFit(layout, screen, zoom).top).toBeCloseTo(layout.area.top, 6)
  })

  it('unzoomed, it is the letterbox of the area, moved to where the area is', () => {
    const local = fitContain(screen.w, screen.h, layout.area.width, layout.area.height)
    expect(pictureFit(layout, screen, NO_ZOOM)).toEqual({ ...local, left: local.left + layout.area.left, top: local.top + layout.area.top })
  })
})

describe('hitArea', () => {
  it('a press in the band is the bar, anywhere in it, never the machine', () => {
    const layout = remoteLayout({ w: 640, h: 420 }, screen, 44)
    const picture = pictureFit(layout, screen, NO_ZOOM)
    for (const x of [0, 1, 320, 639]) for (const y of [0, 22, 43.9]) expect(hitArea(layout, picture, { x, y })).toBe('bar')
  })

  it('a press on the picture is the picture, right up to the band', () => {
    const layout = remoteLayout({ w: 640, h: 420 }, screen, 44)
    const picture = pictureFit(layout, screen, NO_ZOOM)
    expect(hitArea(layout, picture, { x: picture.left + 1, y: layout.area.top })).toBe('picture')
    expect(hitArea(layout, picture, { x: picture.left + picture.width / 2, y: picture.top + picture.height / 2 })).toBe('picture')
  })

  it('the pill catches its whole column', () => {
    const layout = remoteLayout({ w: 844, h: 390 }, screen, 52)
    const picture = pictureFit(layout, screen, NO_ZOOM)
    expect(hitArea(layout, picture, { x: 844 - 1, y: 389 })).toBe('bar')
    expect(hitArea(layout, picture, { x: 844 - PILL_WIDTH, y: 0 })).toBe('bar')
  })

  it('a zoomed picture under the band is still the bar there', () => {
    const layout = remoteLayout({ w: 640, h: 420 }, screen, 44)
    const huge = { left: -500, top: -500, width: 4000, height: 4000 }
    expect(hitArea(layout, huge, { x: 100, y: 10 })).toBe('bar')
    expect(hitArea(layout, huge, { x: 100, y: 100 })).toBe('picture')
  })
})
