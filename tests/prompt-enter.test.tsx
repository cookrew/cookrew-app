// ENTER IN THE AGENT'S PROMPT BOX DID NOT SEND (owner, 2026-11-01): the box
// carrying @agent is a <form> that also holds the agent's VoiceBar, whose
// paperclip, mic, speaker and terminal keys had no `type` — so each was a
// submit button, and the paperclip, first in the form, was its default
// button. Enter "clicked" the paperclip: a file dialog opened, and while an
// attach was busy the disabled paperclip made Enter do nothing at all.
// Wanted: Send is the form's only submit button.
//
// Static markup, the house way (see dock-zoom.test.tsx).

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
    // A recognizer, so the mic is drawn too.
    webkitSpeechRecognition: function Recognizer() {},
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

/** Each <button …> opening tag in the markup, in document order. */
const buttons = (html: string): string[] => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])
/** A button with no type, or type="submit", submits its form. */
const submits = (tag: string): boolean => !/\btype="/.test(tag) || /\btype="submit"/.test(tag)

const render = async (agent: { id: string; name: string; remote: boolean }): Promise<string> => {
  vi.resetModules()
  stubWindow()
  const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
  return renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: agent.id, agents: [agent], harnesses: ['Claude Code'], nodes: [] }))
}

describe("Enter in the agent's prompt box sends", () => {
  it('the box carries the agent, with its VoiceBar inside the form', async () => {
    const html = await render({ id: 'a1', name: 'Gauge', remote: false })
    expect(html).toMatch(/<b>Gauge<\/b>/)
    expect(html).toMatch(/voice-attach/)
    expect(html).toMatch(/voice-mic/)
    expect(html).toMatch(/term-key/)
  })

  it('the box says a screenshot can be pasted or dropped into it, for an agent and for a new one', async () => {
    const html = await render({ id: 'a1', name: 'Gauge', remote: false })
    expect(html).toMatch(/<input[^>]*title="Paste or drop a screenshot: it goes into the prompt"/)
    expect(html).not.toContain('attaching…')
  })

  it('Send is the only submit button, so implicit submission goes to it', async () => {
    for (const remote of [false, true]) {
      const html = await render({ id: 'a1', name: 'Gauge', remote })
      const submitting = buttons(html).filter(submits)
      expect(submitting).toHaveLength(1)
      expect(submitting[0]).toMatch(/aria-label="Send"/)
    }
  })
})
