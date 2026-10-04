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

