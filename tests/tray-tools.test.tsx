// THE TRAY'S TOOLS, ONE FORM (owner, 2026-11-04; the design's cut "Cut · Tray
// tools"): model · effort, 📎, 🔊 and the keys (Esc ← ↓ ↑ → paste) share one
// pill on every width: 28 px on a phone, 26 on a desktop, the radius half the
// height. The tools sit on the card's paper with a hairline, the keys on
// paper-2 with no line, a 1 px hairline between the two. The ^ is the same
// pill, lit in ink while open. Desktop: chip · model · words · 📎 🔊 · [keys]
// · ^ · mic · Send in the one row. They were flat 8 px squares (32 px on a
// phone, ~20 on a desktop). Where the phone's row stands is not this lane's
// (teammate Float Chips): only the pills' look and the ^'s place in it.
//
// Static markup and the stylesheet, the house way (prompt-extras.test.tsx).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
const css = read('prompt', 'global-prompt.css')
const tray = css.slice(css.indexOf('THE TRAY\'S TOOLS, ONE FORM'), css.indexOf('END OF THE TRAY'))
const phone = tray.slice(tray.indexOf('@media (max-width: 700px)'))
/** Every declaration written for `selector` in `sheet`, in order. */
const rule = (sheet: string, selector: string): string => {
  const bodies: string[] = []
  for (let at = sheet.indexOf(`${selector} {`); at > -1; at = sheet.indexOf(`${selector} {`, at + 1)) bodies.push(sheet.slice(at, sheet.indexOf('}', at)))
  expect(bodies.length, selector).toBeGreaterThan(0)
  return bodies.join('\n')
}

const stubWindow = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
    webkitSpeechRecognition: function Recognizer() {},
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  delete (globalThis as unknown as { document?: unknown }).document
}

const render = async (fullAgentId: string | null): Promise<string> => {
  vi.resetModules()
  stubWindow()
  const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
  const agents = [{ id: 'a1', name: 'Gauge', remote: false }]
  return renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId, agents, harnesses: ['Claude Code'], nodes: [] }))
}

/** The opening tags of the buttons, in the markup's order. */
const buttons = (html: string): string[] => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])

describe('one pill for every tool', () => {
  it('26 px on a desktop, 28 on a phone, the radius half the height', () => {
    expect(rule(tray, '.cr-prompt')).toContain('--tray-h: 26px;')
    expect(rule(tray, '.cr-prompt')).toContain('--tray-reach: 0px;')
    expect(rule(phone, '  body .cr-prompt')).toContain('--tray-h: 28px;')
    const pill = rule(tray, '.cr-app .cr-prompt .cr-btn.cr-tray')
    // Drawn inside a clear border (the reach): the pill's own edge is --tray-h.
    expect(pill).toContain('height: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(pill).toContain('min-width: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(pill).toContain('border: var(--tray-reach) solid transparent;')
    expect(pill).toContain('border-radius: calc(var(--tray-h) / 2 + var(--tray-reach));')
    expect(pill).toContain('background-clip: padding-box;')
  })

  it("the tools on the card's paper with a hairline", () => {
    const pill = rule(tray, '.cr-app .cr-prompt .cr-btn.cr-tray')
    expect(pill).toContain('background-color: var(--sumi-card')
    expect(pill).toMatch(/box-shadow: inset 0 0 0 1px var\(--sumi-hair-2/)
  })

  it('never resets the clip with a background shorthand (the reach would fill in)', () => {
    expect(tray).not.toMatch(/^\s*background: /m)
  })

  it("keeps the clip while the model menu is open (header.css's open rule sets the shorthand)", () => {
    expect(rule(tray, ".cr-prompt .cr-tune-menu-btn:hover,\n.cr-prompt .cr-tune-menu.open .cr-tune-menu-btn,\n.cr-prompt .cr-prompt-tune:hover,\n.cr-prompt .cr-prompt-tune[aria-expanded='true']")).toContain('background-clip: padding-box;')
  })

  it('the keys on paper-2 with no line, a hairline between them and the tools', () => {
    const key = rule(tray, '.cr-app .cr-prompt .cr-btn.cr-tray.term-key')
    expect(key).toContain('background-color: var(--sumi-paper-2')
    expect(key).toContain('box-shadow: none;')
    const line = rule(tray, '.cr-prompt .voice-keys::before')
    expect(line).toContain('width: 1px;')
    expect(line).toContain('background-color: var(--sumi-hair-2')
  })

  it('the ^ the same pill, lit in ink while open', () => {
    const lit = rule(tray, '.cr-app .cr-prompt .cr-btn.cr-tray.cr-prompt-more.open')
    expect(lit).toContain('background-color: var(--sumi-ink')
    expect(lit).toContain('color: var(--sumi-paper')
    // Lit says open; it no longer turns over.
    expect(css).not.toMatch(/cr-prompt-more\.open \.cr-icon \{[^}]*rotate/)
  })

  it('model · effort leads with a seal dot, then the words and ▾, in the same pill', () => {
    const chip = rule(tray, '.cr-prompt .cr-tune-menu-btn,\n.cr-prompt .cr-prompt-tune')
    expect(chip).toContain('height: calc(var(--tray-h) + 2 * var(--tray-reach));')
    expect(chip).toContain('border-radius: calc(var(--tray-h) / 2 + var(--tray-reach));')
    expect(chip).toContain('background-color: var(--sumi-card')
    expect(chip).toContain('background-clip: padding-box;')
    const dot = rule(tray, '.cr-prompt .cr-tune-menu-btn::before,\n.cr-prompt .cr-prompt-tune::before')
    expect(dot).toContain('background-color: var(--sumi-seal')
    expect(dot).toContain('border-radius: 50%;')
    // The effort shows on a phone too, after a middle dot.
    expect(rule(tray, '.cr-prompt .cr-tune-menu-effort::before')).toContain("content: '· ';")
    expect(rule(tray, '.cr-prompt .cr-tune-menu-effort')).toContain('display: inline;')
  })

  it('every tool wears the pill: 📎, 🔊, the ^ and each key', () => {
    const extras = read('prompt', 'PromptExtras.tsx')
    for (const cls of ['cr-prompt-more', 'voice-attach', 'voice-speak']) expect(extras).toMatch(new RegExp(`cr-btn sm cr-tray ${cls}`))
    expect(read('VoiceBar.tsx')).toContain('cr-btn sm cr-tray term-key')
  })

  it('by tokens only: Ink, Ink night and Root draw it from --sumi-*', () => {
    expect(tray).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(tray).not.toMatch(/rgba?\(/)
    for (const v of tray.matchAll(/var\(--([a-z0-9-]+)/g)) expect(v[1], v[0]).toMatch(/^(sumi-|tray-|font-|cream|line|ink|amber|muted)/)
  })
})

describe('the keys: Esc ← ↓ ↑ → paste, and no numbers', () => {
  it('in that order', async () => {
    const titles = buttons(await render('a1'))
      .filter((t) => t.includes('term-key'))
      .map((t) => t.match(/title="([^"]+)"/)?.[1])
    expect(titles).toEqual(['Escape', 'Arrow left', 'Arrow down', 'Arrow up', 'Arrow right', 'Paste from the clipboard'])
  })

  it("none of them a number: a waiting agent's menu is the choice box's", () => {
    const bar = read('VoiceBar.tsx')
    expect(bar).not.toMatch(/label: '\d'/)
  })
})

describe('the desktop row: chip · model · words · 📎 🔊 · [keys] · ^ · mic · Send', () => {
  it('draws 📎 🔊, the keys, then the ^, before the mic', async () => {
    const html = await render('a1')
    const at = (cls: string): number => html.indexOf(cls)
    expect(at('voice-attach')).toBeLessThan(at('voice-speak'))
    expect(at('voice-speak')).toBeLessThan(at('term-key'))
    expect(html.lastIndexOf('term-key')).toBeLessThan(at('cr-prompt-more'))
    expect(at('cr-prompt-more')).toBeLessThan(at('voice-mic'))
  })
})

describe('on a phone', () => {
  it('keeps the ^ first in its row, as before: it opens what follows it', () => {
    const box = css.slice(0, css.indexOf("THE TRAY'S TOOLS, ONE FORM"))
    expect(rule(box, '  body .cr-prompt .cr-prompt-tools > .cr-prompt-more')).toContain('order: -1;')
  })

  it("a thumb's reach round a 28 px pill: 32 px with its clear border", () => {
    const reach = Number(rule(phone, '  body .cr-prompt').match(/--tray-reach: (\d+)px;/)?.[1])
    expect(28 + 2 * reach).toBeGreaterThanOrEqual(32)
  })

  it('no pill keeps the old flat 32 px square or the wide screen\'s 3px 8px', () => {
    expect(css).not.toMatch(/\.cr-prompt-tools \.cr-btn \{[^}]*width: 32px/)
    expect(css).not.toContain('padding: 3px 8px;\n    font-size: 8.5px;')
  })
})
