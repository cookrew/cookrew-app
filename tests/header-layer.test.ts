import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE HEADER'S LAYER, AND THE TWO THINGS THAT HANG OFF IT.
 *
 * Reported from a phone (IMG_3468, 2026-09-27): tapping the connection badge
 * greyed the header and froze it — no sheet appeared and nothing in the bar
 * could be pressed again.
 *
 * Nothing about it was random. `.cr-header` declares `z-index: 50` where it is
 * defined, and a later rule of equal specificity —
 * `.cr-header, .cr-stage, .cr-dock { position: relative; z-index: 1 }` — has
 * silently overridden it since the first commit. So the header is a stacking
 * context at layer 1, `.cr-stage` is another at layer 1, and the stage is
 * later in the document: everything the header paints outside its own box is
 * painted UNDER the canvas.
 *
 * Two things paint outside that box, and both were broken by it:
 *
 *   THE CONNECTION SHEET (PathBadge.tsx) is a `.gs-scrim` — fixed, inset 0,
 *   z-index 60 — rendered inside the header. Trapped at layer 1 it is hidden
 *   behind the canvas everywhere the canvas reaches, which is everywhere
 *   except the bar itself. What is left is a grey strip over the header, and
 *   because the scrim still takes the taps there, every button under it dies.
 *   The sheet's own ✕ is off in the hidden part, and the scrim has no
 *   click-outside, so there is no way back: the freeze.
 *
 *   THE LOCAL-NETWORK ASK (`.cr-path-ask`) is absolute, `top: 100%`,
 *   z-index 60 — it hangs off the bottom edge of the bar, into the stage, and
 *   is painted under it. "A permission nobody knows to look for is a
 *   permission nobody grants" was written about this row; nobody could look
 *   for it.
 *
 * So this is one number, and it is asserted as a COMPARISON rather than a
 * literal: what matters is that the bar outranks the canvas it overhangs, not
 * which value says so. `.cr-dock` is left exactly as it is — it is above the
 * stage already by document order, and nothing hangs off it (it is
 * `overflow: hidden`).
 *
 * A SOURCE RULE TEST: nothing here can run a browser. It exists because the
 * `z-index: 50` this restores had been dead for the whole life of the file,
 * and both features were written on top of it as if it were not.
 */

const css = stripComments(
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')
)

/** CSS comments carry example values ("z-index above .gs-scrim (60)"). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every rule body whose selector list has `selector` as its SUBJECT — the
 *  last compound of one of its comma-separated parts, so `.cr-header` matches
 *  `body.cookrew-mobile .cr-header` and never `.cr-header .vi-coin-led` or
 *  `.cr-header-brand`. In source order. */
function rulesFor(selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, list]) =>
      list
        .split(',')
        .map((part) => part.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '')
        .includes(selector)
    )
    .map(([, , body]) => body)
}

/** The z-index that wins for a selector: the last one declared for it. */
function layerOf(selector: string): number | null {
  const declared = rulesFor(selector)
    .flatMap((body) => [...body.matchAll(/(?:^|;)\s*z-index:\s*(-?\d+)/g)].map((m) => Number(m[1])))
  return declared.length === 0 ? null : declared[declared.length - 1]
}

describe('the header outranks the canvas it overhangs', () => {
  it('wins the layer against the stage, so what hangs off the bar is visible', () => {
    const header = layerOf('.cr-header')
    const stage = layerOf('.cr-stage')
    expect(header, '.cr-header declares no z-index').not.toBeNull()
    expect(stage, '.cr-stage declares no z-index').not.toBeNull()
    expect(header as number).toBeGreaterThan(stage as number)
  })

  it('still stands under the sheets and the lock, which must cover everything', () => {
    // An account sheet or the lock is rendered at App level and covers the
    // whole app, the bar included. Raising the bar past them would put chrome
    // over a modal — the opposite mistake.
    expect(layerOf('.cr-header') as number).toBeLessThan(60)
  })

  it('keeps position: relative — the ask is anchored to the bar, not the page', () => {
    expect(rulesFor('.cr-header').some((body) => /position:\s*relative/.test(body))).toBe(true)
  })

  /**
   * Any of these on the bar makes it the containing block for the fixed scrim
   * inside it, which is the same freeze by another route: the sheet would be
   * sized and clipped to the header instead of the viewport.
   */
  it('creates no containing block for the fixed sheet it renders', () => {
    for (const property of ['transform', 'filter', 'backdrop-filter', 'perspective', 'contain']) {
      for (const body of rulesFor('.cr-header')) {
        expect(body, `.cr-header must not declare ${property}`).not.toMatch(
          new RegExp(`(?:^|;)\\s*(?:-webkit-)?${property}:`)
        )
      }
    }
  })
})

describe('what hangs off the header', () => {
  it('the local-network ask hangs off the bottom edge, above the canvas', () => {
    const [ask] = rulesFor('.cr-path-ask')
    expect(ask, 'no .cr-path-ask rule').toBeDefined()
    expect(ask).toMatch(/position:\s*absolute/)
    expect(ask).toMatch(/top:\s*100%/)
    // Above the header's own children, and carried above the canvas by the
    // header's layer — which is what the comparison above protects.
    expect(layerOf('.cr-path-ask') as number).toBeGreaterThan(0)
  })
})
