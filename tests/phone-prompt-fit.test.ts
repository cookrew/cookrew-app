// THE PHONE'S BOX FITS (2026-11-04, phone evals): at 412px an agent's full view
// drew the box's last buttons past the screen's right edge, Send among them.
// The eval's page carried no companion class, so the box kept the wide
// screen's one row (chip, words, ^, 📎, 🔊, six keys, 🎤, Send) in 412px. Now:
//   the width alone lays the box out as the phone's (a narrow window is as
//   narrow as a phone); the tray above the words wraps what does not fit onto
//   a line of its own instead of swiping it out of sight; and every control
//   is a thumb's size, 32px or more, the type untouched.
// 2026-11-04, later (the cut "Tray tools"): the tray's tools are pills drawn
// 28px tall inside a clear 2px border, so the thumb still gets 32px.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
const css = read('prompt', 'global-prompt.css')
/** Every declaration written for `selector`, in order (the phone's float block adds to the first). */
const rule = (selector: string): string => {
  const bodies: string[] = []
  for (let at = css.indexOf(`${selector} {`); at > -1; at = css.indexOf(`${selector} {`, at + 1)) bodies.push(css.slice(at, css.indexOf('}', at)))
  expect(bodies.length, selector).toBeGreaterThan(0)
  return bodies.join('\n')
}
/** The value that wins: the last `prop: Npx;` written. */
const px = (body: string, prop: string): number => Number([...body.matchAll(new RegExp(`(?:^|[\\s;{])${prop}: (\\d+)px;`, 'g'))].at(-1)?.[1] ?? NaN)

describe('the width alone lays the box out as the phone', () => {
  it('needs no companion class in any of the box rules', () => {
    expect(css).not.toContain('body.cookrew-mobile')
    expect(css).toMatch(/@media \(max-width: 700px\) \{\s*(\/\*[\s\S]*?\*\/\s*)?body \.cr-prompt \{/)
  })
})

describe('the tray above the words', () => {
  it('wraps onto a line of its own instead of swiping out of sight', () => {
    const row = rule('  body .cr-prompt .cr-prompt-tools')
    expect(row).toContain('flex-wrap: wrap;')
    expect(row).not.toContain('overflow-x: auto;')
    expect(row).toContain('min-width: 0;')
  })

  it("lays the tray's buttons out in the row, and wraps the agent's keys as one group", () => {
    expect(rule('  body .cr-prompt .cr-prompt-tools > .voice-bar')).toContain('display: contents;')
    const keys = rule('  body .cr-prompt .voice-keys')
    expect(keys).toContain('display: flex;')
    expect(keys).toContain('flex: none;')
    expect(keys).toContain('flex-wrap: nowrap;')
  })

  it('never scrolls, so nothing swipes it', () => {
    expect(read('prompt', 'GlobalPrompt.tsx')).not.toContain('scrollLeft')
  })
})

describe("every control a thumb's size (32px or more)", () => {
  /** The pill's reach on a phone: its drawn height and the clear border round it. */
  const trayReach = (): number => {
    const phone = rule('  body .cr-prompt')
    return px(phone, '--tray-h') + 2 * px(phone, '--tray-reach')
  }

  it('the tools, the ^ and the keys: one pill, 32px with its reach', () => {
    const pill = rule('.cr-app .cr-prompt .cr-btn.cr-tray')
    expect(pill).toContain('height: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(pill).toContain('min-width: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(trayReach()).toBeGreaterThanOrEqual(32)
  })

  it('🎤 and Send', () => {
    const send = rule("  body .cr-prompt > .voice-mic,\n  body .cr-prompt > button[type='submit']")
    expect(px(send, 'width')).toBeGreaterThanOrEqual(32)
    expect(px(send, 'height')).toBeGreaterThanOrEqual(32)
  })

  it('the chips and the × that lets go of the agent', () => {
    expect(px(rule('  body .cr-prompt-to'), 'min-height')).toBeGreaterThanOrEqual(32)
    const x = rule('  body .cr-prompt-to button')
    expect(px(x, 'width')).toBeGreaterThanOrEqual(32)
    expect(px(x, 'height')).toBeGreaterThanOrEqual(32)
    expect(px(rule('  body .cr-prompt-new > .cr-prompt-harness'), 'height')).toBeGreaterThanOrEqual(32)
    expect(rule('.cr-prompt .cr-tune-menu-btn,\n.cr-prompt .cr-prompt-tune')).toContain('height: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(trayReach()).toBeGreaterThanOrEqual(32)
  })

  it('the words row as tall as its buttons', () => {
    expect(px(rule('  body .cr-prompt input'), 'height')).toBeGreaterThanOrEqual(32)
  })
})
