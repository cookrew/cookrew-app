import { describe, expect, it } from 'vitest'
import { standInFigures } from '../src/strata/stand-in/figures'

describe('the stand-in figure kit', () => {
  it('returns the same art for the same input, so callers can memoize', () => {
    const a = standInFigures.avatar({ phase: 'thinking', source: 'live', harness: 'claude', size: 'full' })
    const b = standInFigures.avatar({ phase: 'thinking', source: 'live', harness: 'claude', size: 'full' })
    expect(a).toBe(b)
  })

  it('seats every avatar up to capacity, in order', () => {
    const box = standInFigures.container({ name: 'Monorepo', slots: 60 })
    const slots = Object.keys(box.anchors).filter((k) => k.startsWith('slot:'))
    expect(box.capacity).toBe(48)
    expect(slots).toHaveLength(48)
    expect(box.anchors['slot:1'].x).toBeGreaterThan(box.anchors['slot:0'].x)
  })

  it('gives a machine the portal its workspaces fly out of', () => {
    const machine = standInFigures.machine({ kind: 'laptop', link: 'live' })
    expect(machine.anchors.portal.w).toBeGreaterThan(0)
    expect(machine.svg).not.toMatch(/href=|url\(/)
  })

  it('escapes workspace names', () => {
    expect(standInFigures.container({ name: '<b>&', slots: 1 }).svg).not.toContain('<b>')
  })
})
