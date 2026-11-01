// THE SIDE GROUPS SIT CLOSE AND THE BROWSERS' HAS NO FRAME (owner, 2026-11-01):
// in a desktop full view the browsers and notes stood 30px apart inside a
// white pill the ink theme gave every troop but the agents', and the agents
// stood 26px apart. Both columns now share one close gap, and a docked troop
// on the desktop wears no frame in the ink theme either. The phone strip keeps
// its pill: it sits over the transcript, and the pill is what it reads on.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pets = readFileSync(new URL('../src/renderer/src/pets/pets.css', import.meta.url), 'utf8')
const ink = readFileSync(new URL('../src/renderer/src/zoom/ink-theme.css', import.meta.url), 'utf8')

const gapOf = (css: string, selector: string): number => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  const block = css.slice(at, css.indexOf('}', at))
  return Number(/gap:\s*(\d+)px/.exec(block)?.[1])
}

describe('the docked side groups on a desktop', () => {
  it('stand at one close gap, the agents and the browsers alike', () => {
    expect(gapOf(pets, '.cr-pets.docked.right')).toBeLessThanOrEqual(14)
    expect(gapOf(pets, '.cr-pets.docked.left')).toBe(gapOf(pets, '.cr-pets.docked.right'))
  })

  it('the browsers and notes wear no frame in the ink theme', () => {
    const rule = /@media \(min-width: 701px\) \{\s*body\.cr-ink \.cr-pets\.docked \{([^}]*)\}/.exec(ink)
    expect(rule, 'a desktop rule for the docked troop').not.toBeNull()
    expect(rule?.[1]).toMatch(/border-color:\s*transparent/)
    expect(rule?.[1]).toMatch(/background:\s*none/)
    expect(rule?.[1]).toMatch(/box-shadow:\s*none/)
  })
})
