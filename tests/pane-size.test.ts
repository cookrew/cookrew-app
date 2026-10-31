import { describe, expect, it } from 'vitest'
import { createSizeOwner, OPEN_CLAIM_MS, OWN_MS, openedAt, tookOthers } from '../src/renderer/src/pane-size'

describe("who sets a shared pane's size", () => {
  it('a viewer owns the size when it was opened or used, while it is visible', () => {
    const owner = createSizeOwner(1000)
    expect(owner.owns(1000 + OWN_MS - 1, true)).toBe(true)
    expect(owner.owns(1000 + OWN_MS - 1, false)).toBe(false)
    expect(owner.owns(1000 + OWN_MS, true)).toBe(false)
    owner.use(5000 + OWN_MS)
    expect(owner.owns(5000 + OWN_MS, true)).toBe(true)
  })

  it('gives the size up the moment another viewer takes it, until its own next use', () => {
    const owner = createSizeOwner(1000)
    owner.yieldTo()
    expect(owner.owns(1001, true)).toBe(false)
    owner.use(2000)
    expect(owner.owns(2001, true)).toBe(true)
  })

  it('two viewers cannot bounce: the one not used stays quiet', () => {
    // The phone is touched; the desktop was opened a minute ago and not used since.
    const desktop = createSizeOwner(0)
    const phone = createSizeOwner(0)
    phone.use(60_000)
    // The desktop adopts the phone's size; its box changes; it may not answer.
    expect(desktop.owns(60_100, true)).toBe(false)
    expect(phone.owns(60_100, true)).toBe(true)
  })

  it("a pane that settles on this viewer's own size was this viewer's (a repaint kick passes cols-1)", () => {
    expect(tookOthers({ cols: 100, rows: 40 }, { cols: 100, rows: 40 })).toBe(false)
    expect(tookOthers({ cols: 46, rows: 34 }, { cols: 100, rows: 40 })).toBe(true)
    expect(tookOthers({ cols: 46, rows: 34 }, null)).toBe(true)
  })

  it('a terminal the app mounted on its own does not take the size; one someone opened does', () => {
    // The desktop's stage follows what needs you and mounts the terminal with nobody at the desktop.
    const auto = createSizeOwner(openedAt(100_000, Number.NEGATIVE_INFINITY))
    expect(auto.owns(100_001, true)).toBe(false)
    const stale = createSizeOwner(openedAt(100_000, 100_000 - OPEN_CLAIM_MS))
    expect(stale.owns(100_001, true)).toBe(false)
    // A click on its pet a moment ago opened it.
    const clicked = createSizeOwner(openedAt(100_000, 99_800))
    expect(clicked.owns(100_001, true)).toBe(true)
  })
})
