// THE GLOBAL PROMPT (owner, 2026-11-01): one prompt box at the foot of the
// app. In an agent's full view (or with its card open) it carries @agent and
// sends to it, sharing its draft with the card's reply box; with no agent, it
// makes a new agent in this workspace, named from the prompt, on the harness
// last used unless another is picked.

import { beforeEach, describe, expect, it } from 'vitest'
import { nameFromPrompt } from '../src/shared/agent-name'
import { boxPin, boxTargetId, heldAfter, mentionTarget, promptTargetOf, viewKeyOf } from '../src/renderer/src/prompt/prompt-target'
import { draftKey, getDraft, setDraft, subscribeDrafts } from '../src/renderer/src/prompt/prompt-draft'
import { lastHarness, rememberHarness } from '../src/renderer/src/prompt/harness-pref'

describe('nameFromPrompt', () => {
  it('names an English task by its subject, not its verb', () => {
    expect(nameFromPrompt('fix the login redirect bug')).toBe('Login Redirect')
    expect(nameFromPrompt('Please add dark mode to the settings page')).toBe('Dark Mode')
    expect(nameFromPrompt('investigate why CI is slow')).toBe('Ci Slow')
  })

  it('names a Chinese task by its first words, without the polite lead-in', () => {
    expect(nameFromPrompt('帮我把登录页的跳转修好')).toBe('把登录页的跳')
    expect(nameFromPrompt('请调研一下herdr的取名功能')).toBe('调研一下')
  })

  it('a bare verb still names something; nothing at all falls back to Agent', () => {
    expect(nameFromPrompt('deploy')).toBe('Deploy')
    expect(nameFromPrompt('   ')).toBe('Agent')
    expect(nameFromPrompt('!!! ???')).toBe('Agent')
  })

  it('stays short', () => {
    expect(nameFromPrompt('refactor supercalifragilisticexpialidocious frobnicator').length).toBeLessThanOrEqual(20)
  })
})

describe('promptTargetOf', () => {
  const zoom = (v: number, agent: string | null, dir: 'agents' | 'items' = 'agents') => ({ dir, v, agent })
  it("a full view's agent is the target", () => {
    expect(promptTargetOf({ zoom: zoom(1, null), fullAgentId: 'a1' })).toBe('a1')
  })
  it("an open card's agent is the target", () => {
    expect(promptTargetOf({ zoom: zoom(2, 'a2'), fullAgentId: null })).toBe('a2')
  })
  it('the crew with no card, the device and the item side have none', () => {
    expect(promptTargetOf({ zoom: zoom(1, 'a2'), fullAgentId: null })).toBeNull()
    expect(promptTargetOf({ zoom: zoom(-1, 'a2'), fullAgentId: null })).toBeNull()
    expect(promptTargetOf({ zoom: zoom(1, 'a2', 'items'), fullAgentId: null })).toBeNull()
  })
})

// LET GO, THEN COME BACK (owner, 2026-11-01): Backspace on an empty box let
// go of @agent ("＋ harness"), and stepping into an agent's card or full view
// never brought @agent back while the box kept its focus (a phone tap does):
// the focus hold pinned "nobody". Wanted: a release lasts only while the view
// stays put, and only words showing in the box hold it still.
describe('boxTargetId', () => {
  const known = (id: string): boolean => ['a1', 'a2'].includes(id)
  const card = (id: string | null): string => viewKeyOf(null, id)
  const full = (id: string): string => viewKeyOf(id, id)
  const box = (o: { viewed: string | null; view: string; pin?: { id: string | null } | null; released?: string | null }): string | null =>
    boxTargetId({ viewed: o.viewed, viewKey: o.view, pin: o.pin ?? null, released: o.released ?? null, known })

  it('with nothing typed, the box carries whoever the view shows', () => {
    expect(box({ viewed: 'a1', view: card('a1') })).toBe('a1')
    expect(box({ viewed: null, view: card(null) })).toBeNull()
  })

  it('a release lets go of the viewed agent while the view stays put', () => {
    expect(box({ viewed: 'a1', view: card('a1'), released: card('a1') })).toBeNull()
  })

  it("a release ends when the view moves: another agent's card, or the same agent's full view", () => {
    expect(box({ viewed: 'a2', view: card('a2'), released: card('a1') })).toBe('a2')
    expect(box({ viewed: 'a1', view: full('a1'), released: card('a1') })).toBe('a1')
  })

  it('a card and the full view of one agent are different views', () => {
    expect(viewKeyOf(null, 'a1')).not.toBe(viewKeyOf('a1', 'a1'))
  })

  it('typed words hold the box still while the view moves on', () => {
    expect(box({ viewed: 'a2', view: card('a2'), pin: { id: 'a1' } })).toBe('a1')
    expect(box({ viewed: 'a2', view: card('a2'), pin: { id: null } })).toBeNull()
  })

  it('a hold on an agent that is gone falls back to the view', () => {
    expect(box({ viewed: 'a2', view: card('a2'), pin: { id: 'gone' } })).toBe('a2')
  })
})

describe('what pins the box', () => {
  const known = (id: string): boolean => ['a1', 'a2'].includes(id)
  it('words showing in the focused box pin it; an empty box, or one not focused, does not', () => {
    expect(boxPin(null, { id: 'a1' }, 'fix it')).toEqual({ id: 'a1' })
    expect(boxPin(null, { id: null }, 'a new task')).toEqual({ id: null })
    expect(boxPin(null, { id: 'a1' }, '')).toBeNull()
    expect(boxPin(null, null, 'fix it')).toBeNull()
  })
  it('the ear pins it while it listens, words or not', () => {
    expect(boxPin({ id: 'a2' }, { id: 'a1' }, '')).toEqual({ id: 'a2' })
  })
  it('an empty box hands its hold to whoever it carries now: after a send, after a release, after the view moved', () => {
    expect(heldAfter({ id: 'a1' }, { boxId: 'a2', heldWords: '', known })).toEqual({ id: 'a2' })
    expect(heldAfter({ id: 'a1' }, { boxId: null, heldWords: '', known })).toEqual({ id: null })
  })
  it('words keep the hold where it is', () => {
    const held = { id: 'a1' }
    expect(heldAfter(held, { boxId: 'a2', heldWords: 'fix it', known })).toBe(held)
    expect(heldAfter(held, { boxId: 'a1', heldWords: '', known })).toBe(held)
    expect(heldAfter(null, { boxId: 'a1', heldWords: '', known })).toBeNull()
  })
  it('a hold on an agent that is gone moves to whoever the box carries', () => {
    expect(heldAfter({ id: 'gone' }, { boxId: 'a2', heldWords: 'fix it', known })).toEqual({ id: 'a2' })
  })
})

describe('mentionTarget', () => {
  const agents = [{ id: 'f', name: 'Fresco' }, { id: 'p', name: 'Probe3 (2)' }, { id: 'q', name: 'Probe3' }]
  it('a leading @name picks that agent, case-insensitively, the longest name first', () => {
    expect(mentionTarget('@fresco look at the logo', agents)).toEqual({ id: 'f', text: 'look at the logo' })
    expect(mentionTarget('@Probe3 (2) hi', agents)).toEqual({ id: 'p', text: 'hi' })
    expect(mentionTarget('@Probe3 hi', agents)).toEqual({ id: 'q', text: 'hi' })
  })
  it('no mention, or an unknown one, picks nobody', () => {
    expect(mentionTarget('look at the logo', agents)).toBeNull()
    expect(mentionTarget('@nobody hi', agents)).toBeNull()
    expect(mentionTarget('@Frescoes hi', agents)).toBeNull()
  })
})

describe('the shared draft', () => {
  it("one agent's draft is the same text wherever it is read, and others hear it change", () => {
    const heard: string[] = []
    const off = subscribeDrafts(() => heard.push(getDraft(draftKey('a1'))))
    setDraft(draftKey('a1'), 'half a thought')
    expect(getDraft(draftKey('a1'))).toBe('half a thought')
    expect(getDraft(draftKey('a2'))).toBe('')
    expect(getDraft(draftKey(null))).toBe('')
    off()
    setDraft(draftKey('a1'), '')
    expect(heard).toEqual(['half a thought'])
  })
})

describe('the harness a new agent takes', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    }
  })
  it('the last one used, if it is still offered; else Claude Code; else the first', () => {
    const offered = ['Shell', 'Claude Code', 'Codex']
    expect(lastHarness(offered)).toBe('Claude Code')
    rememberHarness('Codex')
    expect(lastHarness(offered)).toBe('Codex')
    expect(lastHarness(['Shell', 'Pi'])).toBe('Shell')
  })
})

describe('the box, drawn', () => {
  it('with an agent in full view: @agent, its prompt, the voice keys, one send', async () => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    g.window = g.window ?? globalThis
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
    const agents = [{ id: 'l', name: 'Lark', remote: false }]
    const full = renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: 'l', agents, harnesses: ['Claude Code', 'Codex'], nodes: [] }))
    expect(full).toContain('@Lark')
    expect(full).toContain('placeholder="Prompt Lark… # a note or browser"')
    expect(full).toContain('voice-bar')
    expect(full.match(/aria-label="Send"/g)?.length).toBe(1)
    const none = renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: null, agents, harnesses: ['Claude Code', 'Codex'], nodes: [] }))
    expect(none).toContain('＋ Claude Code ▾')
    expect(none).toContain('Describe a task for a new agent')
    expect(none).not.toContain('voice-bar')
  })
})

// Review, 2026-11-01: App seeds its preset list with ['Shell'] before the real
// one arrives, and a prompt typed into zsh runs as a command.
describe('a prompt never goes to a bare shell', () => {
  it('the dock offers the box no Shell, so it falls back to Claude Code', async () => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    g.window = g.window ?? globalThis
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { Dock } = await import('../src/renderer/src/Dock')
    const noop = (): void => undefined
    const html = renderToStaticMarkup(createElement(Dock, {
      tool: 'move', onSelect: noop, clipping: false, onToggleClipping: noop, presets: ['Shell'], preset: '', onPreset: noop,
      roles: [], role: null, onRole: noop, orch: false, onOrch: noop, connectHint: null, onMake: noop,
      voiceFor: null, agents: [], nodes: [], browserFor: null, boardFor: null
    }))
    expect(html).toContain('＋ Claude Code ▾')
    expect(html).not.toContain('＋ Shell')
  })

  it('main injects a first prompt only into a terminal that runs a command', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const main = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    expect(main).toContain("const first = typeof opts.prompt === 'string' && terminal.command.trim() ? opts.prompt.trim() : ''")
  })
})
