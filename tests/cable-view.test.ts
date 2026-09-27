import { describe, expect, it } from 'vitest'
import { routeCables, type CableLink, type CableRect } from '../src/renderer/src/cable-route'
import { harnessView, viewportKey, type Stage } from '../src/renderer/src/cable-view'

/**
 * WHAT OF THE HARNESS IS DRAWN AT THIS VIEWPORT.
 *
 * The router (cable-route.ts) never looks at the viewport — that is what
 * keeps it off the per-frame path. This layer does, and applies the rule the
 * first cable note measured: a line earns its ink only when it can be
 * followed, which means both of its ends are on the stage. A cable with one
 * end on stage is a name on that end instead of a run; one with no end on
 * stage is not drawn at all; and hovering a card draws its cables whatever
 * their reach, because a touch is a question and the answer is the line.
 * Everything here is a filter over an already-routed harness: it moves with
 * the viewport but recomputes nothing.
 */

const card = (id: string, x: number, y: number, width = 640, height = 420): CableRect => ({ id, x, y, width, height })
const link = (a: string, b: string): CableLink => ({ id: `${a}~${b}`, a, b })
const ALL = { farPx: Number.POSITIVE_INFINITY }
/** A stage of `width` flow px with its top-left at (x, y). */
const stage = (x: number, y: number, width: number, height = width * 0.6): Stage => ({ x, y, width, height })

describe('a run only when both ends are on the stage', () => {
  const rects = [card('a', 0, 0), card('b', 4000, 0)]
  const links = [link('a', 'b')]
  const harness = routeCables(rects, links, ALL)

  it('names a cable whose far end is off the stage, and draws it once the stage holds both', () => {
    // At a stage 2,000 flow px wide only `a` is on it: a tab on a. Zoomed
    // out to a 6,000 px stage both ends are on it and the cable is followable.
    const near = harnessView(harness, rects, links, stage(-500, -500, 2000), null)
    expect(near.trunks).toEqual([])
    expect(near.tabs.map((t) => [t.card, t.partner])).toEqual([['a', 'b']])
    const wide = harnessView(harness, rects, links, stage(-500, -500, 6000), null)
    expect(wide.trunks.length).toBeGreaterThan(0)
    expect(wide.tabs).toEqual([])
  })

  it('draws nothing for a run with no end on the stage', () => {
    // Both cards are far off a stage that sits elsewhere: no run, no tab —
    // this is the culling the whole first note was about.
    const view = harnessView(harness, rects, links, stage(20_000, 20_000, 6000), null)
    expect(view.trunks).toEqual([])
    expect(view.stubs).toEqual([])
    expect(view.tabs).toEqual([])
  })

  it('puts a tab only on a card that is on the stage', () => {
    // The stage holds `a` and not `b`: a wears the tab, b is not drawn at all.
    const view = harnessView(harness, rects, links, stage(-200, -200, 1500), null)
    expect(view.tabs).toEqual([{ card: 'a', partner: 'b', hot: false }])
  })
})

describe('a run counts only the cables visible at this zoom', () => {
  // hub; a to its right; b below a. Both cables leave the hub along the same
  // row and part above b, so the run nearest the hub carries both. The stage
  // below is one row tall: it holds hub and a, not b.
  const rects = [card('hub', 0, 0), card('a', 5000, 0), card('b', 5000, 1200)]
  const links = [link('hub', 'a'), link('hub', 'b')]
  const harness = routeCables(rects, links, ALL)
  const oneRow = stage(-300, -300, 6400, 900)
  const twoRows = stage(-300, -300, 6400, 3000)

  it('on a one-row stage the shared run carries one cable, on two rows both', () => {
    const narrow = harnessView(harness, rects, links, oneRow, null)
    expect(Math.max(0, ...narrow.trunks.map((t) => t.count))).toBe(1)
    expect(narrow.tabs.map((t) => t.card)).toEqual(['hub'])
    const wide = harnessView(harness, rects, links, twoRows, null)
    expect(Math.max(0, ...wide.trunks.map((t) => t.count))).toBe(2)
  })

  it('hovering a card draws its cables whatever their reach, and marks them hot', () => {
    const view = harnessView(harness, rects, links, oneRow, 'hub')
    // The cable to b, off the stage, is drawn after all — a touch is a question.
    expect(view.trunks.some((t) => t.links.includes('hub~b'))).toBe(true)
    expect(view.trunks.every((t) => t.hot)).toBe(true)
    // And hovering a card that cable does NOT touch leaves it a tab.
    const other = harnessView(harness, rects, links, oneRow, 'a')
    expect(other.trunks.some((t) => t.links.includes('hub~b'))).toBe(false)
    expect(other.trunks.filter((t) => t.hot).every((t) => t.links.includes('hub~a'))).toBe(true)
    expect(other.tabs).toEqual([{ card: 'hub', partner: 'b', hot: false }])
  })
})

describe('the viewport key', () => {
  it('is stable inside a quarter-stage tile and changes across it', () => {
    const k = viewportKey([0, 0, 1], 1600, 1000)
    expect(viewportKey([-399, 0, 1], 1600, 1000)).toBe(k)
    expect(viewportKey([-401, 0, 1], 1600, 1000)).not.toBe(k)
    expect(viewportKey([0, -251, 1], 1600, 1000)).not.toBe(k)
  })

  it('changes only when the zoom crosses a half-octave', () => {
    const k = viewportKey([0, 0, 1], 1600, 1000)
    expect(viewportKey([0, 0, 1.3], 1600, 1000)).toBe(k)
    expect(viewportKey([0, 0, 1.5], 1600, 1000)).not.toBe(k)
    expect(viewportKey([0, 0, 0.6], 1600, 1000)).not.toBe(k)
  })
})
