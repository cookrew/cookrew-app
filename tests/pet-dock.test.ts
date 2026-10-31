// THE SIDE GROUPS ATTACH TO THE FULL VIEW (owner, 2026-10-31), as
// docs/brand-ink-2026-10-31/group-motion-pivot.html draws it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { columnMiddle, dockedOrder, dockedSpot, LANE_WIDE, nearDock, sheetBox, SHEET_INSET, SNAP_PX } from '../src/renderer/src/pets/pet-dock'

const full = { left: 0, top: 60, width: 1440, height: 780 }
const lanes = { left: LANE_WIDE, right: LANE_WIDE }
const viewport = { width: 1440, height: 900 }

describe('where an attached column stands', () => {
  it('the sheet steps in by a lane each side', () => {
    const sheet = sheetBox(full, lanes)
    expect(sheet).toEqual({ left: 14 + 56, top: 60 + SHEET_INSET.top, width: 1440 - 2 * (14 + 56), height: 780 - SHEET_INSET.top - SHEET_INSET.bottom })
  })

  it('the agents beside the sheet on the right, the browsers and notes on the left, both centred on it', () => {
    const sheet = sheetBox(full, lanes)
    const right = columnMiddle('right', full, sheet, 40)
    const left = columnMiddle('left', full, sheet, 40)
    expect(right.x).toBeGreaterThan(sheet.left + sheet.width)
    expect(left.x).toBeLessThan(sheet.left)
    expect(right.y).toBe(sheet.top + sheet.height / 2)
    expect(left.y).toBe(right.y)
  })

  it('with no lane (a narrow screen) the column stands just inside the sheet edge, on screen', () => {
    const narrow = { left: 0, top: 50, width: 500, height: 800 }
    const sheet = sheetBox(narrow, { left: 0, right: 0 })
    const right = columnMiddle('right', narrow, sheet, 40)
    expect(right.x + 20).toBeLessThanOrEqual(sheet.left + sheet.width)
    const spot = dockedSpot('left', narrow, sheet, { width: 40, height: 300 }, { width: 500, height: 900 })
    expect(spot.left).toBeGreaterThanOrEqual(sheet.left)
  })

  it('a column taller than the sheet starts at its top instead of climbing over the head', () => {
    const sheet = sheetBox(full, lanes)
    expect(dockedSpot('right', full, sheet, { width: 40, height: 2000 }, viewport).top).toBe(sheet.top)
  })
})

describe('snapping on and off', () => {
  const sheet = sheetBox(full, lanes)
  const middle = columnMiddle('right', full, sheet, 40)
  const at = (x: number, y: number) => ({ left: x - 20, top: y - 100, width: 40, height: 200 })

  it('let go by the panel side, it snaps on', () => {
    expect(nearDock('right', at(middle.x, middle.y), full, sheet)).toBe(true)
    expect(nearDock('right', at(middle.x - SNAP_PX + 1, middle.y + 200), full, sheet)).toBe(true)
  })

  it('let go anywhere else, it floats there', () => {
    expect(nearDock('right', at(middle.x - SNAP_PX - 40, middle.y), full, sheet)).toBe(false)
    expect(nearDock('right', at(middle.x, sheet.top - 120), full, sheet)).toBe(false)
    // The agents' troop does not snap to the left side.
    expect(nearDock('right', at(columnMiddle('left', full, sheet, 40).x, middle.y), full, sheet)).toBe(false)
  })
})

describe('who stands in an attached column', () => {
  const m = (...ids: string[]) => ids.map((id) => ({ id }))

  it('never the card the panel shows', () => {
    expect(dockedOrder(m('a', 'b', 'c'), { exclude: 'b', first: [] })).toEqual({ members: m('a', 'c'), dim: new Set() })
  })

  it("around a browser or note: the agents wired to it first, the rest after them, dimmed", () => {
    const out = dockedOrder(m('a', 'b', 'c', 'd'), { exclude: null, first: ['c', 'a'] })
    expect(out.members.map((x) => x.id)).toEqual(['a', 'c', 'b', 'd'])
    expect([...out.dim]).toEqual(['b', 'd'])
  })
})

describe('the stylesheets agree with the numbers', () => {
  it('the full view takes a lane per attached group, and none below 900px', () => {
    const css = readFileSync('src/renderer/src/zoom/full-views.css', 'utf8')
    expect(css).toMatch(/body\.cr-docked-left \.zv-fullview \{\s*--fv-lane-left: 56px;/)
    expect(css).toMatch(/body\.cr-docked-right \.zv-fullview \{\s*--fv-lane-right: 56px;/)
    expect(css).toMatch(/@media \(max-width: 899px\)[^@]*--fv-lane-left: 0px;/)
    expect(css).toMatch(/inset: 78px calc\(14px \+ var\(--fv-lane-right\)\) 12px calc\(14px \+ var\(--fv-lane-left\)\);/)
  })
})
