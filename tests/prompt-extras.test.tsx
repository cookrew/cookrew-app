// THE BOX'S EXTRAS (owner, 2026-11-03, a screenshot of the box): "the icons in
// the flat version, keep the extra buttons when making a new agent too, and a
// ^ button shows or hides them". Attach and 🔊 were the agent's alone
// (VoiceBar), drawn as 30 px squares beside the flat mic; a new agent had
// neither. Now both stay in the box whoever it is for, flat, behind a ^.
//
// Static markup, the house way (see prompt-enter.test.tsx).

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { shouldSpeak } from '../src/renderer/src/prompt/use-spoken-replies'
import { PromptExtras } from '../src/renderer/src/prompt/PromptExtras'
import { shownWords, withAttached } from '../src/renderer/src/prompt/draft-pictures'
import { toolsOpen } from '../src/renderer/src/prompt/extras-pref'

type Store = Map<string, string>

const stubWindow = (store: Store, phone = false): void => {
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
    matchMedia: (query: string) => ({ matches: phone && query === '(max-width: 700px)' }),
    webkitSpeechRecognition: function Recognizer() {},
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  // The companion's body class, as on the phone (the default fold reads the width alone).
  const g = globalThis as unknown as { document?: unknown }
  if (phone) g.document = { body: { classList: { contains: (c: string) => c === 'cookrew-mobile' } } }
  else delete g.document
}

const render = async (opts: { fullAgentId: string | null; remote?: boolean; store?: Store; phone?: boolean }): Promise<string> => {
  vi.resetModules()
  stubWindow(opts.store ?? new Map(), opts.phone)
  const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
  const agents = [{ id: 'a1', name: 'Gauge', remote: opts.remote ?? false }]
  return renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: opts.fullAgentId, agents, harnesses: ['Claude Code'], nodes: [] }))
}

/** The opening tag of the button carrying `cls`. */
const tag = (html: string, cls: string): string | undefined => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(cls))
const css = readFileSync('src/renderer/src/prompt/global-prompt.css', 'utf8')

describe('the extras stay for a new agent', () => {
  it('a new agent gets attach and 🔊, and no agent keys', async () => {
    const html = await render({ fullAgentId: null })
    expect(html).toContain('＋ Claude Code')
    expect(tag(html, 'voice-attach')).toMatch(/type="button"/)
    expect(tag(html, 'voice-speak')).toMatch(/type="button"/)
    expect(html).not.toContain('term-key')
  })

  it('an agent gets them too, and its keys', async () => {
    const html = await render({ fullAgentId: 'a1' })
    expect(html).toMatch(/<b>Gauge<\/b>/)
    expect(html).toContain('voice-attach')
    expect(html).toContain('voice-speak')
    expect(html).toContain('term-key')
  })

  it('nothing attaches to a team running elsewhere: 🔊 stays, the paperclip goes', async () => {
    const html = await render({ fullAgentId: 'a1', remote: true })
    expect(html).not.toContain('voice-attach')
    expect(html).toContain('voice-speak')
  })

  it('every tool is a plain button: Send stays the one submit', async () => {
    for (const fullAgentId of [null, 'a1']) {
      const html = await render({ fullAgentId })
      const submits = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/\btype="button"/.test(t))
      expect(submits).toHaveLength(1)
      expect(submits[0]).toMatch(/aria-label="Send"/)
    }
  })
})

describe('the ^ shows or hides them', () => {
  it('a ^ before the extras, open on a desktop by default', async () => {
    const html = await render({ fullAgentId: null })
    const more = tag(html, 'cr-prompt-more')
    expect(more).toMatch(/aria-expanded="true"/)
    expect(html.indexOf('cr-prompt-more')).toBeLessThan(html.indexOf('voice-attach'))
    expect(html.indexOf('voice-speak')).toBeLessThan(html.indexOf('voice-mic'))
  })

  it('folded by default on a phone, where they would take a row of their own', async () => {
    const html = await render({ fullAgentId: null, phone: true })
    expect(tag(html, 'cr-prompt-more')).toMatch(/aria-expanded="false"/)
    expect(html).not.toContain('voice-attach')
    // Nothing left for the tray to hold: no tray at all.
    expect(html).not.toContain('voice-bar')
  })

  it('the pick sticks, either way, whatever the width', async () => {
    const hidden = await render({ fullAgentId: null, store: new Map([['cookrew.prompt-extras', '0']]) })
    expect(tag(hidden, 'cr-prompt-more')).toMatch(/aria-expanded="false"/)
    expect(hidden).not.toContain('voice-speak')
    const shown = await render({ fullAgentId: null, phone: true, store: new Map([['cookrew.prompt-extras', '1']]) })
    expect(tag(shown, 'cr-prompt-more')).toMatch(/aria-expanded="true"/)
    expect(shown).toContain('voice-speak')
  })

  // Owner, 2026-11-03, later: "the arrows, paste and Esc go in there too".
  it('the agent\'s keys sit behind the same ^: shown with the rest, after them', async () => {
    const html = await render({ fullAgentId: 'a1' })
    expect(html.indexOf('voice-speak')).toBeLessThan(html.indexOf('term-key'))
    expect(html.indexOf('term-key')).toBeLessThan(html.indexOf('voice-mic'))
    expect(html).not.toContain('aria-label="Agent keys"')
  })

  it('folded with an agent in the box: no tray at all, its keys gone with the rest', async () => {
    const html = await render({ fullAgentId: 'a1', store: new Map([['cookrew.prompt-extras', '0']]) })
    expect(html).not.toContain('voice-bar')
    expect(html).not.toContain('term-key')
    expect(html).not.toContain('voice-attach')
  })

  it('the agent waiting on you opens them by itself; a tap on the ^ then stands', () => {
    expect(toolsOpen(null, false, true)).toBe(true)
    expect(toolsOpen(null, false, false)).toBe(false)
    expect(toolsOpen(null, true, false)).toBe(true)
    expect(toolsOpen(false, true, true)).toBe(false)
    expect(toolsOpen(true, false, false)).toBe(true)
  })
})

describe('the ^ folded still says 🔊 is on', () => {
  it('marked while spoken replies are on and hidden; unmarked while shown', async () => {
    const store = (extras: string): Store => new Map([['cookrew.prompt-extras', extras], ['cookrew-speak-replies', '1']])
    expect(tag(await render({ fullAgentId: null, store: store('0') }), 'cr-prompt-more')).toMatch(/class="[^"]*\bspeaking\b/)
    expect(tag(await render({ fullAgentId: null, store: store('1') }), 'cr-prompt-more')).not.toMatch(/\bspeaking\b/)
  })

  // 2026-11-04 (phone evals): a narrow window draws the phone's box (global-prompt.css
  // · the width alone gates it), so it folds as the phone does: shown, its tray stood
  // over the zoom bar's stops at 412px.
  it('a narrow window folds them as a phone does; a wide one, the companion too, shows them', async () => {
    vi.resetModules()
    stubWindow(new Map(), false)
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window
    win.matchMedia = () => ({ matches: true })
    const { extrasShown } = await import('../src/renderer/src/prompt/extras-pref')
    expect(extrasShown()).toBe(false)
    win.matchMedia = () => ({ matches: false })
    win.COOKREW_MOBILE = 1
    expect(extrasShown()).toBe(true)
  })
})

describe('the paperclip puts any file in the draft', () => {
  it('a picture is drawn, its path kept out of the words', () => {
    const draft = withAttached('look', ['/tmp/a.png'])
    expect(draft).toBe("look /tmp/a.png")
    expect(shownWords(draft)).toBe('look')
  })

  it('another file goes in as words, a space either side, once', () => {
    const once = withAttached('summarize', ['/tmp/report.pdf'])
    expect(shownWords(once)).toBe('summarize /tmp/report.pdf ')
    expect(withAttached(once, ['/tmp/report.pdf'])).toBe(once)
    expect(shownWords(withAttached('', ['/tmp/my report.pdf']))).toBe("/tmp/my\\ report.pdf ")
  })

  it('files and pictures together: the words carry the file, the picture stays drawn', () => {
    const draft = withAttached('x', ['/tmp/a.png', '/tmp/b.txt'])
    expect(shownWords(draft)).toBe('x /tmp/b.txt ')
    expect(draft.endsWith('/tmp/a.png')).toBe(true)
  })
})

describe('drawn flat, like the mic', () => {
  it('on a wide screen every tool, the keys too, leaves the 30 px square for the mic\'s sm shape', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 701px) {'))
    expect(wide).toMatch(/\.cr-prompt \.voice-bar \.cr-btn,\s*\.cr-prompt \.voice-bar \.voice-keys \.cr-btn\.term-key\s*\{[^}]*height: auto;[^}]*padding: 3px 8px;/)
  })

  it('the keys are drawn in the box at every width, not only on a touch screen', () => {
    expect(css).toMatch(/^\.cr-prompt \.voice-keys \{\s*display: flex;/m)
    expect(css).not.toMatch(/keys-only|keys-folded|cr-prompt-keys/)
  })
})

describe('🔊 reads the box agent\'s reply once, as its turn lands', () => {
  const on = true
  it('reads when the same agent lands on replied', () => {
    expect(shouldSpeak({ id: 'a', phase: 'thinking' }, { id: 'a', phase: 'replied' }, 'done it', on)).toBe(true)
  })
  it('not when off, not with no reply, not twice', () => {
    expect(shouldSpeak({ id: 'a', phase: 'thinking' }, { id: 'a', phase: 'replied' }, 'done it', false)).toBe(false)
    expect(shouldSpeak({ id: 'a', phase: 'thinking' }, { id: 'a', phase: 'replied' }, null, on)).toBe(false)
    expect(shouldSpeak({ id: 'a', phase: 'replied' }, { id: 'a', phase: 'replied' }, 'done it', on)).toBe(false)
  })
  it('not an agent the box has just come to, already replied, nor a new agent', () => {
    expect(shouldSpeak({ id: 'b', phase: 'thinking' }, { id: 'a', phase: 'replied' }, 'done it', on)).toBe(false)
    expect(shouldSpeak({ id: null, phase: undefined }, { id: null, phase: 'replied' }, 'x', on)).toBe(false)
  })
})

describe('the 🔊 button says what a tap will do', () => {
  const button = (speaking: boolean, reading: boolean): string | undefined =>
    tag(
      renderToStaticMarkup(
        createElement(PromptExtras, { canAttach: false, attaching: false, onPick: () => undefined, onBrowse: () => undefined, speaking, reading, onSpeak: () => undefined })
      ),
      'voice-speak'
    )
  it('off: speak replies aloud', () => {
    expect(button(false, false)).toMatch(/title="Speak replies aloud"/)
    expect(button(false, false)).not.toMatch(/\bon\b|\breading\b/)
  })
  it('on and quiet: a tap turns it off', () => {
    expect(button(true, false)).toMatch(/class="[^"]*\bon\b/)
    expect(button(true, false)).not.toMatch(/\breading\b/)
    expect(button(true, false)).toMatch(/tap to turn off/)
  })
  it('reading: it breathes, and a tap stops the reading', () => {
    expect(button(true, true)).toMatch(/class="[^"]*\breading\b/)
    expect(button(true, true)).toMatch(/tap to stop reading/)
  })
})
