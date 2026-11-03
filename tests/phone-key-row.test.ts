// THE PHONE'S BOX, ONE ROW UNDER THE WORDS (owner, 2026-11-03). First the key
// row was spread across the box in three groups; then the owner asked for the
// chips, ⌄ 🎤 ⌨ and all the keys on ONE row, every button one size, side by
// side, the row swiped sideways for the rest, and ⌨ hiding the terminal keys.
// 2026-11-04 (phone evals): the swiped row hid its last keys past the edge; it
// wraps them now, every button 32px (tests/phone-prompt-fit.test.ts).
// 2026-11-04, later (the cut "Tray tools"): every button is the tray's pill,
// 28px drawn and 32px to the thumb (tests/tray-tools.test.tsx), the keys
// Esc ← ↓ ↑ → paste after a hairline.
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

  // 2026-11-04, later: the wide row puts the ^ after the keys (chip · model ·
  // words · 📎 🔊 · keys · ^ · mic · Send), so the DOM does; the phone's row
  // keeps it first by its order.
  it('puts the ^ first in the phone\'s row, then the extras and the keys', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    const at = box.indexOf('<span className="cr-prompt-tools"')
    expect(box.indexOf('</VoiceBar>', at)).toBeLessThan(box.indexOf('<ExtrasToggle', at))
    expect(rule('  body .cr-prompt .cr-prompt-tools > .cr-prompt-more')).toContain('order: -1;')
  })

  it('draws every button in it as one pill', () => {
    const one = rule('.cr-app .cr-prompt .cr-btn.cr-tray')
    expect(one).toContain('flex: none;')
    expect(one).toContain('height: calc(var(--tray-h) + 2 * var(--tray-reach));')
    for (const cls of ['cr-prompt-more', 'voice-attach', 'voice-speak']) expect(read('prompt', 'PromptExtras.tsx')).toContain(`cr-btn sm cr-tray ${cls}`)
    expect(read('VoiceBar.tsx')).toContain('cr-btn sm cr-tray term-key')
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
