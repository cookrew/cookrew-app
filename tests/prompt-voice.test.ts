// ONE EAR, ONE BOX (owner, 2026-11-01): speech recognition lived in two
// places — the VoiceBar's mic (Web Speech, words into the box) and the hold
// of ⌘ (the Mac's recognizer, words straight to Sous, shown in a pill at the
// top of the stage). Wanted: both land in the global prompt box. The box has
// the one mic, for an agent and for a new one; ⌘ held drives the same ear;
// only a sentence addressed to Sous goes to Sous.
//
// Static markup, the house way (see prompt-enter.test.tsx), plus the pure
// parts (prompt/dictation.ts).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pickEar, transcriptOf, webErrorText, webRecognizer, withHeard } from '../src/renderer/src/prompt/dictation'
import { addressedToSous } from '../src/shared/sous-intent'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')

const stubWindow = (recognizer: boolean): void => {
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
    ...(recognizer ? { webkitSpeechRecognition: function Recognizer() {} } : {}),
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

const render = async (props: { fullAgentId: string | null; recognizer?: boolean }): Promise<string> => {
  vi.resetModules()
  stubWindow(props.recognizer ?? true)
  const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
  const agents = [{ id: 'a1', name: 'Gauge', remote: false }]
  return renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: props.fullAgentId, agents, harnesses: ['Claude Code'], nodes: [] }))
}

const mics = (html: string): string[] => [...html.matchAll(/<button\b[^>]*voice-mic[^>]*>/g)].map((m) => m[0])

describe('the prompt box has the one mic', () => {
  it('one mic with an agent in the box, and it is not a submit button', async () => {
    const html = await render({ fullAgentId: 'a1' })
    expect(html).toMatch(/<b>Gauge<\/b>/)
    expect(mics(html)).toHaveLength(1)
    expect(mics(html)[0]).toMatch(/type="button"/)
    expect(mics(html)[0]).toMatch(/aria-label="Dictate"/)
  })

  it('a mic for a new agent too: the task can be said', async () => {
    const html = await render({ fullAgentId: null })
    expect(html).toContain('＋ Claude Code')
    expect(mics(html)).toHaveLength(1)
  })

  it('no ear on this surface, no mic', async () => {
    const html = await render({ fullAgentId: 'a1', recognizer: false })
    expect(mics(html)).toHaveLength(0)
  })

  it('the VoiceBar no longer listens, and nothing else holds ⌘ to talk', () => {
    const bar = src('VoiceBar.tsx')
    expect(bar).not.toMatch(/SpeechRecognition|voice-mic|onDictation/)
    const app = src('App.tsx')
    expect(app).not.toMatch(/usePushToTalk|SousPill|listenStart/)
    const hearers = ['App.tsx', 'VoiceBar.tsx', 'prompt/GlobalPrompt.tsx'].filter((f) => /listenStart|SpeechRecognition/.test(src(f)))
    expect(hearers).toEqual([])
  })
})

describe('dictation, the pure parts', () => {
  it("the Mac's own ear wins over Electron's empty webkitSpeechRecognition", () => {
    expect(pickEar(true, true)).toBe('mac')
    expect(pickEar(false, true)).toBe('web')
    expect(pickEar(false, false)).toBeNull()
  })

  it('finds the Web Speech constructor, prefixed or not', () => {
    const Ctor = function R() {}
    expect(webRecognizer({ SpeechRecognition: Ctor })).toBe(Ctor)
    expect(webRecognizer({ webkitSpeechRecognition: Ctor })).toBe(Ctor)
    expect(webRecognizer({})).toBeNull()
    expect(webRecognizer(undefined)).toBeNull()
  })

  it('heard words go after the draft, never over it', () => {
    expect(withHeard('', 'fix the build')).toBe('fix the build')
    expect(withHeard('look at #Notes', ' then fix it ')).toBe('look at #Notes then fix it')
    expect(withHeard('draft  ', '')).toBe('draft  ')
    expect(withHeard('   ', 'hi')).toBe('hi')
  })

  it('joins the results so far', () => {
    expect(transcriptOf([[{ transcript: 'hello ' }], [{ transcript: 'world' }]])).toBe('hello world')
    expect(transcriptOf([])).toBe('')
  })

  it('silence and a stop say nothing; a refused mic says why', () => {
    expect(webErrorText('no-speech')).toBeNull()
    expect(webErrorText('aborted')).toBeNull()
    expect(webErrorText(undefined)).toBeNull()
    expect(webErrorText('not-allowed')).toMatch(/not allowed/)
    expect(webErrorText('network')).toMatch(/not reachable/)
    expect(webErrorText('weird')).toMatch(/weird/)
  })
})

describe('only a sentence addressed to Sous goes to Sous', () => {
  it('Sous and its Chinese names, with or without the comma', () => {
    expect(addressedToSous('Sous, switch to Cookrew Dev')).toBe(true)
    expect(addressedToSous('  sous back')).toBe(true)
    expect(addressedToSous('\u82cf\u65af\uff0c\u5207\u6362\u5230 cookrew')).toBe(true)
    expect(addressedToSous('\u5c0f\u53a8 \u8fd4\u56de')).toBe(true)
  })

  it('everything else is the prompt', () => {
    expect(addressedToSous('fix the failing test')).toBe(false)
    expect(addressedToSous('ask Sous later')).toBe(false)
    expect(addressedToSous('')).toBe(false)
  })

  it('a word that only starts like the name is not the name', () => {
    expect(addressedToSous('Sousa marches are loud')).toBe(false)
    expect(addressedToSous('sous-vide the eggs, add a class for it')).toBe(false)
    expect(addressedToSous('\u5c0f\u53a8\u623f\u592a\u5c0f')).toBe(false)
    expect(addressedToSous('Sous: back')).toBe(true)
  })
})
