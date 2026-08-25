import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
const rule = (sel: string): string => {
  const at = CSS.indexOf(sel + ' {')
  return at === -1 ? '' : CSS.slice(at, CSS.indexOf('}', at))
}

describe('1 — MINE is dashed, and solidifies when it serves', () => {
  it('marks a saved-but-not-serving template dashed', () => {
    expect(rule('.cr-chip.mine')).toMatch(/border-style:\s*dashed/)
  })

  it('changes ONLY the border, so the chip keeps its footprint', () => {
    // The SHARING is provisional, not the chip. A width or padding change here
    // reflows the whole dock row the moment a template starts serving.
    expect(rule('.cr-chip.mine')).not.toMatch(/width|padding|margin|font-size/)
  })

  it('restates solid on .live rather than relying on the absence of .mine', () => {
    expect(rule('.cr-chip.live')).toMatch(/border-style:\s*solid/)
  })
})

describe('2 — price is a tag, and the slot holds one truth', () => {
  it('reads as an offer: amber-deep, never rose or amber-soft', () => {
    const body = rule('.cr-chip-price')
    expect(body).toMatch(/color:\s*var\(--amber-deep\)/)
    expect(body).not.toMatch(/--rose|--amber-soft/)
  })

  it('shares the version tag’s footprint idiom, because both are facts', () => {
    // .cr-chip-ver had to be SHIPPED for this comparison to mean anything: it
    // existed only in the design mock, so the spec's premise that "the
    // vocabulary exists" was half true — the rail pin shipped, the chip family
    // did not.
    const grab = (b: string, p: string): string | undefined =>
      b.split('\n').find((l) => l.trim().startsWith(p))?.trim()
    for (const prop of ['font-family', 'font-size', 'border-radius', 'flex']) {
      expect(grab(rule('.cr-chip-price'), prop)).toBe(grab(rule('.cr-chip-ver'), prop))
    }
  })

  it('is a TAG, not an overlaid badge — it must not position itself', () => {
    // A badge overlays and needs `position`; a fact sits in the row.
    expect(rule('.cr-chip-price')).not.toMatch(/position:\s*absolute/)
  })
})

describe('3 — BY is the whole authority surface', () => {
  it('carries a sprite and a handle in one tag', () => {
    expect(rule('.cr-chip-by')).toMatch(/display:\s*inline-flex/)
    expect(CSS).toMatch(/\.cr-chip-by \.role-avatar/)
  })

  it('bounds a hostile handle instead of stretching the dock row', () => {
    const body = rule('.cr-chip-by')
    expect(body).toMatch(/max-width/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/white-space:\s*nowrap/)
  })
})

/**
 * .cr-ckpt-pin carries clip-path: polygon(0 0, 62% 0, 100% 50%, 62% 100%, 0 100%),
 * and a clip-path clips the element's PSEUDO-ELEMENTS too. A provenance mark
 * drawn outside that polygon is sliced by the flag's own silhouette. (0,0) is a
 * vertex, so the top-left corner is the one place a mark survives whole.
 */
describe('4 — the imported dot inherits pin geometry and cannot move it', () => {
  it('draws inside the clip, at the polygon’s own corner', () => {
    const body = rule('.cr-ckpt-pin.imported::after')
    expect(body).toMatch(/top:\s*2px/)
    expect(body).toMatch(/left:\s*1\.5px/)
    expect(body).toMatch(/width:\s*3px/)
  })

  it('is ABSOLUTE, which is what keeps F6 true by construction', () => {
    // Out of flow => the pin's box is identical with and without .imported =>
    // its centre cannot move => railAnchorTop still lands it on the marker.
    expect(rule('.cr-ckpt-pin.imported::after')).toMatch(/position:\s*absolute/)
  })

  it('never touches a property that could change the pin’s box', () => {
    const body = rule('.cr-ckpt-pin.imported::after')
    for (const forbidden of ['height: 13px', 'transform', 'margin', 'float']) {
      expect(body).not.toMatch(new RegExp(forbidden))
    }
  })

  it('inverts with the current pin so the dot survives the dark label', () => {
    expect(rule('.cr-ckpt-pin.current.imported::after')).toMatch(/background:\s*var\(--phos-bg\)/)
  })

  it('shifts only the LABEL to clear the dot, and only when imported', () => {
    expect(rule('.cr-ckpt-pin.imported')).toMatch(/padding-left:\s*6px/)
    expect(rule('.cr-ckpt-pin')).toMatch(/padding-left:\s*2px/)
  })
})
