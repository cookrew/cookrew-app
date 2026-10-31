// THE CREW ON A PHONE (owner, 2026-11-01, Samsung Browser): the ink ties ran
// through the agents' names and status words, and the last row, Probe5 and
// Probe6, stood under DEVICES / DEVICE / CREW / CARD / FULL with no scroll
// left to bring it out. The words wear the page's paper over the ties
// (zoom.css), and the camera ends the crew above the stop bar (zoom-frame.ts ·
// PHONE_BAR).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutOf, phoneCamera, phoneThumbs, PHONE_BAR, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'

const crewOf = (n: number): FrameModel => ({
  agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, preset: 'Claude Code', orch: false, waiting: false })),
  items: [],
  links: [],
  ties: [],
  workspaces: ['w1'],
  otherMachines: 0,
  active: 'w1',
  newest: null
}) as unknown as FrameModel

// The phone of the report: 412 wide, the overview ~700 tall between the bar and the dock.
const PHONE = { w: 412, h: 700 }
// The stop bar (zoom.css, max-width 700px and pointer: coarse): 8 from the edge, 5 + 40 + 5 tall.
const BAR_TOP = PHONE.h - (8 + 5 + 40 + 5)
// A face's labels end 116 under its anchor (zoom-frame.ts · FACE_REACH.bottom).
const LABELS = 116

describe('the last row clears the stop bar', () => {
  it('the bar is at least as tall as the room the camera keeps for it', () => {
    expect(PHONE_BAR).toBeGreaterThanOrEqual(PHONE.h - BAR_TOP)
  })

  it('scrolled to the end, the lowest names stand above the bar', () => {
    const L = layoutOf(crewOf(15), true)
    const cam = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 1e6)
    expect(cam.panMax).toBeGreaterThan(0)
    const lowest = Math.max(...[...Object.values(L.crew.at), L.crew.next].map((p) => p.y))
    expect(cam.Oy + (lowest + LABELS) * cam.S).toBeLessThanOrEqual(BAR_TOP)
  })

  it('a crew that fits is centred in the room above the bar', () => {
    const L = layoutOf(crewOf(3), true)
    const cam = phoneCamera(L, 1, null, PHONE.w, PHONE.h, 0)
    expect(cam.panMax).toBe(0)
    const lowest = Math.max(...[...Object.values(L.crew.at), L.crew.next].map((p) => p.y))
    expect(cam.Oy + (lowest + LABELS) * cam.S).toBeLessThanOrEqual(BAR_TOP)
  })

  it('so does the end of the thumbnails', () => {
    const box = { w: 400, h: 2400, cy: 1000 }
    const cam = phoneThumbs(box, PHONE.w, PHONE.h, 1e6)
    expect(cam.Oy + (box.cy + box.h / 2) * cam.S).toBeLessThanOrEqual(BAR_TOP + 1e-6)
  })
})

describe('the words lie over the ties', () => {
  const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('the ties have no layer of their own, under the agents', () => {
    const tie = css.match(/\.zv-tie \{([^}]*)\}/)
    expect(tie?.[1]).not.toMatch(/z-index/)
    expect(css).toMatch(/\.zv-m \{[^}]*z-index: 12/)
  })

  it("a name, a status word and the counts each wear the page's paper, off the open card", () => {
    expect(css).toMatch(/\.zv-m:not\(\[data-card='open'\]\) :is\(\.zv-nm, \.zv-st, \.zv-cnt\) \{[^}]*background: var\(--zv-paper\)[^}]*box-shadow: 0 0 0 3px var\(--zv-paper\)/)
  })

  it('the paper adds no padding, so the widths the painter measures stay the text', () => {
    const rule = css.match(/\.zv-m:not\(\[data-card='open'\]\) :is\(\.zv-nm, \.zv-st, \.zv-cnt\) \{([^}]*)\}/)
    expect(rule?.[1]).not.toMatch(/padding/)
  })
})
