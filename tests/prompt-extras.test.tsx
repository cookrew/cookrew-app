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
import { gistOf, shouldSpeak } from '../src/renderer/src/prompt/use-spoken-replies'
import { shownWords, withAttached } from '../src/renderer/src/prompt/draft-pictures'

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
  // The companion's body class: the phone default needs it AND the width.
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
    expect(html).toContain('<b>@Gauge</b>')
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

  it('hidden with an agent in the box, the tray holds only its keys, and says so', async () => {
    const html = await render({ fullAgentId: 'a1', store: new Map([['cookrew.prompt-extras', '0']]) })
    expect(html).toMatch(/class="voice-bar nodrag keys-only"/)
    expect(html).not.toContain('voice-attach')
    expect(html).toContain('term-key')
  })
})

describe('the ^ folded still says 🔊 is on', () => {
  it('marked while spoken replies are on and hidden; unmarked while shown', async () => {
    const store = (extras: string): Store => new Map([['cookrew.prompt-extras', extras], ['cookrew-speak-replies', '1']])
    expect(tag(await render({ fullAgentId: null, store: store('0') }), 'cr-prompt-more')).toMatch(/class="[^"]*\bspeaking\b/)
    expect(tag(await render({ fullAgentId: null, store: store('1') }), 'cr-prompt-more')).not.toMatch(/\bspeaking\b/)
  })

  it('a narrow desktop window is no phone: the extras show', async () => {
    vi.resetModules()
    stubWindow(new Map(), false)
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.matchMedia = () => ({ matches: true })
    const { extrasShown } = await import('../src/renderer/src/prompt/extras-pref')
    expect(extrasShown()).toBe(true)
    // The companion's boot flag counts before its body class is set.
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.COOKREW_MOBILE = 1
    expect(extrasShown()).toBe(false)
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
  it('on a wide screen the tray tools leave the 30 px square for the mic\'s sm shape', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 701px) {'))
    expect(wide).toMatch(/\.cr-prompt \.voice-bar \.cr-btn:not\(\.term-key\)\s*\{[^}]*height: auto;[^}]*padding: 3px 8px;/)
  })

  it('a keys-only tray is not drawn where the keys are not', () => {
    expect(css).toMatch(/@media \(min-width: 701px\) and \(not \(pointer: coarse\)\)\s*\{\s*\.cr-prompt \.voice-bar\.keys-only\s*\{\s*display: none;/)
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
  it('the gist: whitespace folded, the first 300 characters', () => {
    expect(gistOf('  a\n\n b  ')).toBe('a b')
    expect(gistOf('x'.repeat(400))).toHaveLength(300)
    expect(gistOf('')).toBe('done')
  })
})
