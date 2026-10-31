// THE PHONE STRIP IS ONE ROW (owner, 2026-11-01, Samsung Browser): with the
// keyboard closed the crew stood in two rows over the full view, the first
// behind the browsers and notes, the second over the transcript's top lines.
// "+N" had expanded the troop into a wrapping block; in the strip it now turns
// a page of the same row (pet-dock.ts · stripPage), and the stylesheet keeps
// the strip from wrapping whatever class it wears.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripPage } from '../src/renderer/src/pets/pet-dock'

describe('"+N" in the strip turns a page', () => {
  it('shows the first row and how many are behind it', () => {
    expect(stripPage(14, 4, 0)).toEqual({ start: 0, end: 4, rest: 10, last: false })
  })

  it('never shows more faces than the row holds', () => {
    for (let page = 0; page < 8; page++) {
      const at = stripPage(14, 4, page)
      expect(at.end - at.start).toBeLessThanOrEqual(4)
      expect(at.end - at.start).toBeGreaterThan(0)
    }
  })

  it('ends on the last page, then wraps back to the first', () => {
    expect(stripPage(14, 4, 3)).toEqual({ start: 12, end: 14, rest: 0, last: true })
    expect(stripPage(14, 4, 4)).toEqual(stripPage(14, 4, 0))
  })

  it('a row that holds everyone is one page', () => {
    expect(stripPage(3, 4, 0)).toEqual({ start: 0, end: 3, rest: 0, last: true })
  })
})

describe('the troop does not expand in the strip', () => {
  const troop = readFileSync('src/renderer/src/pets/PetTroop.tsx', 'utf8')

  it('wears no "expanded" class while it is a strip row', () => {
    expect(troop).toMatch(/expanded && !strip \? ' expanded' : ''/)
  })

  it('pages instead of expanding there', () => {
    expect(troop).toMatch(/if \(strip\) setPage\(/)
  })
})

describe('the stylesheet agrees', () => {
  const css = readFileSync('src/renderer/src/pets/pets.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.indexOf('@media (max-width: 700px)')
  const phone = css.slice(css.indexOf('{', start) + 1)

  it('a docked troop on a phone is a row that never wraps, expanded or not', () => {
    const rule = phone.match(/([^{}]*)\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const [, selectors, body] = rule as RegExpMatchArray
    expect(selectors).toMatch(/\.cr-pets\.docked\.expanded/)
    expect(body).toMatch(/flex-direction: row/)
    expect(body).toMatch(/flex-wrap: nowrap/)
  })
})
