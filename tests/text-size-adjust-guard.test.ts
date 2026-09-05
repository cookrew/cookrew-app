// iOS Safari text autosizing, and the rule that keeps it off.
//
// Safari inflates nowrap inline-block text runs it judges too small for a wide
// block, ignoring the sheet's font-size. On the phone (IMG_3251, 2026-09-05)
// the checkpoint rail's 12.5px titles rendered at headline size while the 8px
// T-tags beside them stayed correct — CSS byte-identical across builds, nothing
// in CSS or JS scaling the text, phone-only. The guard is one rule on `html`.
//
// This is a SOURCE rule test: nothing here can run Safari. It exists so the
// rule cannot be removed by a refactor that "cleans up" a line nobody
// remembers the reason for — the way `text-size-adjust` had never existed in
// this repo until the bug was seen on a device.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css')

describe('html keeps iOS text autosizing off', () => {
  it('declares both the prefixed and standard property at 100%', () => {
    const css = readFileSync(STYLES, 'utf8')
    // Find the html rule that carries the guard, wherever it sits.
    const htmlRules = [...css.matchAll(/(^|\n)html\s*\{([^}]*)\}/g)].map((m) => m[2])
    const guarded = htmlRules.find((body) => /text-size-adjust/.test(body))
    expect(guarded, 'no html { … } rule declares text-size-adjust').toBeDefined()
    expect(guarded).toMatch(/-webkit-text-size-adjust:\s*100%/)
    expect(guarded).toMatch(/(^|[^-])text-size-adjust:\s*100%/)
  })

  it('uses 100%, never none', () => {
    // `none` also disables the user's own accessibility text scaling on some
    // engines. Freezing our layout must not cost them theirs.
    const css = readFileSync(STYLES, 'utf8')
    expect(css).not.toMatch(/text-size-adjust:\s*none/)
  })
})
