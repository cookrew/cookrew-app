// THE PHONE'S BOX, ONE ROW UNDER THE WORDS (owner, 2026-11-03). First the key
// row was spread across the box in three groups; then the owner asked for the
// chips, ⌄ 🎤 ⌨ and all the keys on ONE row, every button one size, side by
// side, the row swiped sideways for the rest, and ⌨ hiding the terminal keys.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
const css = read('prompt', 'global-prompt.css')
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe("the phone's tools: one row after the chips", () => {
  it('holds ⌄, the extras and keys, 🎤 and ⌨ in one wrapper that is invisible on a wide screen', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    const at = box.indexOf('<span className="cr-prompt-tools"')
    expect(at).toBeGreaterThan(-1)
    const end = box.indexOf('</span>', box.indexOf('cr-prompt-keys', at))
    const inside = box.slice(at, end)
    for (const part of ['<ExtrasToggle', '<VoiceBar', 'voice-mic', 'cr-prompt-keys']) expect(inside).toContain(part)
    expect(inside).not.toContain('type="submit"')
    expect(rule('.cr-prompt-tools')).toContain('display: contents;')
  })

  it('on a phone is one row that never wraps and swipes sideways', () => {
    const row = rule('  body.cookrew-mobile .cr-prompt .cr-prompt-tools')
    expect(row).toContain('display: flex;')
    expect(row).toContain('flex-wrap: nowrap;')
    expect(row).toContain('overflow-x: auto;')
    expect(row).toContain('min-width: 0;')
    // The key tray is not a row of its own any more.
    expect(css).not.toMatch(/\.cr-prompt \.voice-bar \{[^}]*flex-basis: 100%/)
  })

  it('puts ⌄ 🎤 ⌨ first, then the extras and the keys', () => {
    const order = (sel: string): number => Number(rule(`  body.cookrew-mobile .cr-prompt .cr-prompt-tools > ${sel}`).match(/order: (\d+);/)?.[1])
    expect(order('.cr-prompt-more')).toBeLessThan(order('.voice-mic'))
    expect(order('.voice-mic')).toBeLessThan(order('.cr-prompt-keys'))
    expect(order('.cr-prompt-keys')).toBeLessThan(order('.voice-bar'))
  })

  it('draws every button in it at one size', () => {
    const one = rule('  body.cookrew-mobile .cr-prompt .cr-prompt-tools .cr-btn')
    expect(one).toContain('flex: none;')
    expect(one).toContain('width: 34px;')
    expect(one).toContain('height: 36px;')
    expect(css).toMatch(/body\.cookrew-mobile \.cr-prompt \.voice-keys \{\s*display: contents;/)
  })

  it('still lets ⌨ hide the terminal keys', () => {
    expect(css).toMatch(/\.cr-prompt\.keys-folded \.voice-keys,\s*body\.cookrew-mobile \.cr-prompt\.keys-folded \.voice-bar\.keys-only \{\s*display: none;/)
  })

  it('draws the four arrows as one icon turned four ways', () => {
    const bar = read('VoiceBar.tsx')
    for (const way of ['left', 'down', 'up', 'right']) expect(bar).toContain(`icon: 'arrow-${way}'`)
  })

  // Owner, 2026-11-03: "the arrows and ESC seem gone". Beside two chips the row
  // showed ⌄ 🎤 ⌨ ← ↓ and the rest was past the edge, with nothing saying so.
  it('swipes the row to the keys whenever they open', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    expect(box).toContain('<span className="cr-prompt-tools" ref={toolsRef}>')
    expect(box).toMatch(/if \(row && to && !keysFolded\) row\.scrollLeft = row\.scrollWidth\s*\}, \[keysFolded, to\?\.id\]\)/)
  })

  it('fits all six keys in the ~235px two chips leave on a 412px phone', () => {
    const width = Number(rule('  body.cookrew-mobile .cr-prompt .cr-prompt-tools .cr-btn').match(/width: (\d+)px;/)?.[1])
    const gap = Number(rule('  body.cookrew-mobile .cr-prompt .cr-prompt-tools > .voice-bar').match(/gap: (\d+)px;/)?.[1] ?? 4)
    expect(6 * width + 5 * gap + 2 * gap).toBeLessThanOrEqual(235)
  })
})
