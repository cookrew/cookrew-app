// THE PHONE'S KEY ROW, LAID OUT (owner, 2026-11-03: "optimise the keyboard
// buttons' layout"). It sat right-aligned with an empty left third, its keys
// 30px squares under the 36px mic and ⌨ above. Now it spans the box in three
// groups, [attach speak] [← ↓ ↑ →] [paste ESC], every key the height of the
// buttons above it, sharing the width evenly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/renderer/src/prompt/global-prompt.css'), 'utf8')
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe("the phone's key row", () => {
  it('spans the whole box, its keys one row of equal shares', () => {
    expect(rule('  body.cookrew-mobile .cr-prompt .voice-keys')).toContain('display: contents;')
    const key = rule('  body.cookrew-mobile .cr-prompt .voice-bar .cr-btn')
    expect(key).toContain('flex: 1 1 0;')
    expect(key).toContain('min-width: 0;')
  })

  it('makes every key as tall as the mic and ⌨ above it', () => {
    expect(rule('  body.cookrew-mobile .cr-prompt .voice-bar .cr-btn')).toContain('height: 36px;')
  })

  // The mono face drew ← → smaller than ↓ ↑ on the owner's phone: the four are one icon turned.
  it('draws the four arrows as one icon turned four ways, at the size of the box’s icons', async () => {
    const bar = readFileSync(join(__dirname, '../src/renderer/src/VoiceBar.tsx'), 'utf8')
    for (const way of ['left', 'down', 'up', 'right']) expect(bar).toContain(`icon: 'arrow-${way}'`)
    expect(rule('  body.cookrew-mobile .cr-prompt .voice-bar .cr-btn .cr-icon')).toContain('width: 16px;')
  })

  it('parts the three groups: the extras, the arrows, paste and Esc', () => {
    expect(rule('  body.cookrew-mobile .cr-prompt .voice-bar:not(.keys-only) .voice-keys > :first-child')).toMatch(/margin-left: \d+px;/)
    expect(rule('  body.cookrew-mobile .cr-prompt .voice-bar .cr-btn.term-key-lead')).toMatch(/margin-left: \d+px;/)
  })
})
