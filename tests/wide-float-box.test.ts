// THE BOX FLOATS AT EVERY WIDTH (owner, 2026-11-03: "the desktop and wide
// screens are not done yet"). The phone's floating pill (phone-float-box.test.ts)
// is the app's box everywhere but the cookrew.dev embed: the dock is a
// see-through layer, the box a pill centred and capped on a wide screen, and
// what stood on the band clears it through --cr-float-h, defined for every width.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
const box = read('prompt', 'global-prompt.css')
const wide = box.slice(box.indexOf('THE BOX FLOATS AT EVERY WIDTH'), box.indexOf('THE BOX FLOATS, ONE ROW'))

describe('the dock floats at every width', () => {
  it('is written before the phone block, outside any media query, and leaves the embed alone', () => {
    expect(wide.length).toBeGreaterThan(0)
    expect(wide).not.toContain('@media')
    expect(wide).toMatch(/\.cr-app:not\(\.cr-embed\) > \.cr-dock \{[^}]*position: fixed;[^}]*background: transparent;[^}]*pointer-events: none;/)
  })

  it('defines the clearance for every width, and the phone its own on the same element', () => {
    expect(wide).toMatch(/\.cr-app:not\(\.cr-embed\) \{[^}]*--cr-float-h:/)
    expect(box).toMatch(/body\.cookrew-mobile \.cr-app:not\(\.cr-embed\) \{[^}]*--cr-float-h:/)
  })

  it('draws the box as a pill no wider than 960px, centred', () => {
    expect(wide).toMatch(/> \.cr-dock\) \.cr-prompt \{[^}]*flex: 0 1 960px;[^}]*border-radius: 24px;/)
    expect(wide).toMatch(/> \.cr-dock \.dock-canvas \{[^}]*justify-content: center;/)
  })

  it('lifts the zoom bar and ends the full view above it at every width', () => {
    const zoom = read('zoom', 'zoom.css')
    const lift = zoom.slice(zoom.indexOf('THE BOX FLOATS over the stage'))
    expect(lift).toMatch(/^[^@]*\.zv-root:not\(\[data-full='true'\]\) \.zv-controls \{\s*bottom: var\(--cr-float-h/)
    const full = read('zoom', 'full-views.css')
    const base = full.slice(full.indexOf('.zv-fullview {'), full.indexOf('@media'))
    expect(base).toMatch(/padding-bottom: var\(--cr-float-h/)
  })
})
