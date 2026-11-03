// THE CHECKPOINT FAN ON PAPER (phone report 2026-11-01, Samsung Browser, CHAT).
//
// A tap on the rail fans T1…T5 along the bar. In the paper full view each row
// drew as a 336px black slab over the cream transcript, hiding the message
// text, and every title was cut mid-letter ("Update commen", "Finch reviewe").
// Measured in headless Chromium at 412px with the real stylesheets
// (scratchpad/ckpt-paper): dev drew every laid row 336px wide in
// rgb(28, 28, 31) with 127px left for titles needing 188-278px; this draws
// them as wide as their words (250-336px), cream, titles whole or ending in an
// ellipsis.
//
// Four causes, one rule each — and the fan lives behind a scrub or a pin,
// which a static render never sets (CheckpointRowView.tsx), so the stylesheet
// is what these read.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sheet = (name: string): string =>
  readFileSync(join(__dirname, '../src/renderer/src', name), 'utf8')
const styles = sheet('styles.css')
const roster = sheet('agent-roster.css')

/** The declarations of the first rule whose selector list holds `selector` exactly. */
function rule(css: string, selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(flat); m !== null; m = re.exec(flat)) {
    const selectors = m[1].split(',').map((s) => s.trim())
    if (selectors.includes(selector)) return m[2]
  }
  throw new Error(`no rule for ${selector}`)
}

const has = (decls: string, prop: string, value: string): boolean =>
  new RegExp(`(^|;)\\s*${prop}\\s*:\\s*${value.replace(/[()]/g, '\\$&')}\\s*(;|$)`).test(decls)

describe('a laid row is a tag at the bar, not a bar across the lane', () => {
  const laid = rule(roster, '.cr-ckpt-list .cr-ckpt-row')

  it('is anchored right only, so it shrinks to its words', () => {
    expect(has(laid, 'right', '0')).toBe(true)
    expect(/(^|;)\s*left\s*:/.test(laid)).toBe(false)
  })

  it('never wider than the lane', () => {
    expect(has(laid, 'max-width', '100%')).toBe(true)
  })
})

describe('an unrevealed action strip takes no room from the title', () => {
  const hidden = rule(
    styles,
    '.cr-ckpt-row:not(:hover):not(:focus-within):not(.acting) .cr-ckpt-row-actions'
  )

  it('is out of flow until revealed', () => {
    expect(has(hidden, 'position', 'absolute')).toBe(true)
  })

  it('but not display:none, so its buttons stay focusable and focus reveals it', () => {
    expect(/display\s*:\s*none/.test(hidden)).toBe(false)
  })

  it('the reveals themselves are untouched', () => {
    expect(has(rule(styles, '.cr-ckpt-row.acting .cr-ckpt-row-actions'), 'opacity', '1')).toBe(true)
  })
})

describe('a title too long ends in an ellipsis, not mid-letter', () => {
  it('the text is inline at rest, where the clip can put an ellipsis', () => {
    expect(has(rule(roster, '.cr-ckpt-title-text'), 'display', 'inline')).toBe(true)
  })

  it('and a box only while it marquees, which needs a transform', () => {
    expect(has(rule(roster, '.cr-ckpt-title-text.marquee'), 'display', 'inline-block')).toBe(true)
  })

  it('the clip still carries the ellipsis', () => {
    expect(has(rule(styles, '.cr-ckpt-row-title'), 'text-overflow', 'ellipsis')).toBe(true)
  })
})

describe('the paper full view takes the cream skin', () => {
  it('rows are cream, the focused one amber-soft, titles ink', () => {
    expect(has(rule(styles, '.zv-fullview .cr-ckpt-rail .cr-ckpt-row'), 'background', 'var(--cream-hi)')).toBe(true)
    expect(
      has(rule(styles, '.zv-fullview .cr-ckpt-rail .cr-ckpt-row.active'), 'background', 'var(--amber-soft)')
    ).toBe(true)
    expect(has(rule(styles, '.zv-fullview .cr-ckpt-rail .cr-ckpt-row-title'), 'color', 'var(--ink)')).toBe(true)
  })

  it('the same declarations as .on-cream, so the two never drift', () => {
    for (const [cream, paper] of [
      ['.cr-ckpt-rail.on-cream .cr-ckpt-row', '.zv-fullview .cr-ckpt-rail .cr-ckpt-row'],
      ['.cr-ckpt-rail.on-cream .cr-ckpt-action', '.zv-fullview .cr-ckpt-rail .cr-ckpt-action']
    ]) {
      expect(rule(styles, paper)).toBe(rule(styles, cream))
    }
  })

  it('the focused tag wrapper adds no dark surface behind the row', () => {
    expect(has(rule(sheet('zoom/full-views.css'), '.zv-fullview .cr-ckpt-fan-focus'), 'background', 'transparent')).toBe(true)
  })
})
