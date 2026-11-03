// THE PHONE'S BOX, ONE ROW UNDER THE WORDS (owner, 2026-11-03). First the key
// row was spread across the box in three groups; then the owner asked for the
// chips, ⌄ 🎤 ⌨ and all the keys on ONE row, every button one size, side by
// side, the row swiped sideways for the rest, and ⌨ hiding the terminal keys.
// 2026-11-04 (phone evals): the swiped row hid its last keys past the edge; it
// wraps them now, every button 32px (tests/phone-prompt-fit.test.ts).
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
  // 2026-11-03, later: the box floats as one row and 🎤 stands beside Send
  // (tests/phone-float-box.test.ts); the tools row keeps ⌄, the keys and ⌨.
  it('holds ⌄, the extras and keys, and ⌨ in one wrapper that is invisible on a wide screen', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    const at = box.indexOf('<span className="cr-prompt-tools"')
    expect(at).toBeGreaterThan(-1)
    const end = box.indexOf('</span>', box.indexOf('</VoiceBar>', at))
    const inside = box.slice(at, end)
    for (const part of ['<ExtrasToggle', '<VoiceBar']) expect(inside).toContain(part)
    // 2026-11-03, later: ⌨ is gone; the ^ folds the keys with attach and 🔊.
    expect(inside).not.toContain('cr-prompt-keys')
    expect(inside).not.toContain('voice-mic')
    expect(inside).not.toContain('type="submit"')
    expect(rule('.cr-prompt-tools')).toContain('display: contents;')
  })

  // 2026-11-04 (task "Phone tray chips float"): the tools are chips of the
  // tray, a row of its own floating over the pill (tests/phone-float-box.test.ts).
  it("on a phone lays its chips into the floating tray's one row", () => {
    expect(rule('  body .cr-prompt .cr-prompt-tools')).toContain('display: contents;')
    const row = rule('  body .cr-prompt .cr-prompt-tray')
    expect(row).toContain('display: flex;')
    expect(row).toContain('flex-wrap: nowrap;')
    // The key tray is not a row of its own any more.
    expect(css).not.toMatch(/\.cr-prompt \.voice-bar \{[^}]*flex-basis: 100%/)
  })

  it("puts the ^ first, then the extras and the keys, in the DOM's order", () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    const at = box.indexOf('<span className="cr-prompt-tools"')
    expect(box.indexOf('<ExtrasToggle', at)).toBeLessThan(box.indexOf('<VoiceBar', at))
    expect(css).not.toMatch(/\.cr-prompt-tools > [^{]*\{[^}]*order:/)
  })

  it('draws every button in it at one size', () => {
    const one = rule('  body .cr-prompt .cr-prompt-tools .cr-btn')
    expect(one).toContain('flex: none;')
    // Flat, as the desktop's (owner, 2026-11-03), and a thumb's size (2026-11-04).
    expect(one).toContain('width: 32px;')
    expect(one).toContain('height: 32px;')
    expect(css).toMatch(/body \.cr-prompt \.voice-keys \{\s*display: flex;\s*flex: none;/)
  })

  it('lets the ^ hide the terminal keys with the rest: no tray while it is folded', () => {
    expect(read('prompt', 'GlobalPrompt.tsx')).toMatch(/\{toolsShown && \(\s*<VoiceBar/)
    expect(css).not.toMatch(/keys-folded|cr-prompt-keys/)
  })

  it('draws the four arrows as one icon turned four ways', () => {
    const bar = read('VoiceBar.tsx')
    for (const way of ['left', 'down', 'up', 'right']) expect(bar).toContain(`icon: 'arrow-${way}'`)
  })

  // Owner, 2026-11-03: "the arrows and ESC seem gone". Beside two chips the row
  // showed ⌄ 🎤 ⌨ ← ↓ and the rest was past the edge, with nothing saying so.
  // 2026-11-04: the tray floats and swipes again, but runs to the screen's
  // edges past the pill (left/right -8px), so its last chip shows cut there:
  // the sign that there is more. No script scrolls it.
  it('swipes to its last key, the cut chip at the edge saying there is more', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    expect(box).toContain('<span className="cr-prompt-tools">')
    expect(box).not.toContain('scrollLeft')
    const row = rule('  body .cr-prompt .cr-prompt-tray')
    expect(row).toContain('overflow-x: auto;')
    expect(row).toContain('right: -8px;')
  })
})
